// oxlint-disable no-await-in-loop -- Sequential hits verify cumulative refill deadlines.

import { afterAll, beforeEach, expect, test } from 'vitest';
import {
	hashFieldExpiration,
	redisTime,
	redisXClient,
	setHashField,
} from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimiterExceededError,
	RedisXLimiterType,
} from '../main.js';
import { REDIS_PREFIX } from '../utils.js';

const ttl = 3601;
const blockTtl = 7202;
const limiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.TokenBucket,
	name: 'test-token-bucket',
	limit: 3,
	ttl,
});
const blockingLimiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.TokenBucket,
	name: 'test-token-bucket-block',
	limit: 3,
	ttl,
	block_ttl: blockTtl,
});
const key = `${REDIS_PREFIX}:${limiter.name}`;
const blockingKey = `${REDIS_PREFIX}:${blockingLimiter.name}`;
const blockKey = `${REDIS_PREFIX}:_block`;
const blockField = `${blockingLimiter.name}:subject`;

beforeEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});
afterAll(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

/** Allows the Redis clock to tick during the public calls. */
function expectTtl(
	value: number | undefined,
	deadline: number,
	times: [number, number],
) {
	expect(value).toBeGreaterThanOrEqual(deadline - times[1]);
	expect(value).toBeLessThanOrEqual(deadline - times[0]);
}

/** Checks rejection without confusing next-token time with full refill. */
async function expectRejectedHit(instance: RedisXLimiter, deadline: number) {
	const before = await redisTime();
	try {
		await instance.hit('subject');
	} catch (error) {
		expect(error).toBeInstanceOf(RedisXLimiterExceededError);
		expect(error).toMatchObject({ limiter: instance });
		expectTtl((error as RedisXLimiterExceededError).ttl, deadline, [
			before,
			await redisTime(),
		]);
		return;
	}

	expect.unreachable('Expected the hit to be rejected');
}

test('an unused bucket is full and its first hit expires after one token refills', async () => {
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.EXISTS(key, blockKey)).toBe(0);

	const before = await redisTime();
	const hit = await limiter.hit('subject');
	const after = await redisTime();
	expect(hit).toEqual({
		limiter,
		remaining: 2,
		ttl: 1201,
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '1' });
	const deadline = await hashFieldExpiration(key, 'subject');
	expect(deadline).toBeGreaterThanOrEqual(before + 1201);
	expect(deadline).toBeLessThanOrEqual(after + 1201);
	expect(await redisXClient.EXPIRETIME(key)).toBe(-1);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('partial refill is derived from the counter and deadline without changing another subject', async () => {
	const before = await redisTime();
	// Two hits 1,800 seconds ago leave about half a token of usage.
	await setHashField(key, 'subject', { value: 2, deadline: before + 601 });
	await setHashField(key, 'other', { value: 3, deadline: before + ttl });
	expect(await limiter.check('subject')).toBe(true);
	const current = await limiter.get('subject');
	expect(current).toEqual({
		limiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, before + 601, [before, await redisTime()]);
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '2', other: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(before + 601);

	const hit = await limiter.hit('subject');
	expect(hit).toEqual({
		limiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, before + 1801, [before, await redisTime()]);
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '3', other: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(before + 1801);
	expect(await hashFieldExpiration(key, 'other')).toBe(before + ttl);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('a partially refilled full counter rebases on the last fitting hit without creating a block', async () => {
	const before = await redisTime();
	await setHashField(blockingKey, 'subject', {
		value: 3,
		deadline: before + 1801,
	});
	expect(await blockingLimiter.check('subject')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, before + 1801, [before, await redisTime()]);
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(before + 1801);

	const hit = await blockingLimiter.hit('subject');
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 0,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, before + 3002, [before, await redisTime()]);
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '1' });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(before + 3002);
	// The rebased counter is one, but its future anchor still means no whole token fits.
	expect(await blockingLimiter.check('subject')).toBe(false);
	const exhausted = await blockingLimiter.get('subject');
	expect(exhausted).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(exhausted.ttl, before + 601, [before, await redisTime()]);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('successive hits round cumulative refill time and keep the stored counter integral', async () => {
	const before = await redisTime();
	await setHashField(blockingKey, 'subject', {
		value: 1,
		deadline: before + 1201,
	});
	for (const [counter, offset] of [
		[2, 2401],
		[3, 3601],
	] as const) {
		expect(await blockingLimiter.check('subject')).toBe(true);
		const current = await blockingLimiter.get('subject');
		expect(current).toMatchObject({
			limiter: blockingLimiter,
			remaining: 4 - counter,
			is_hit_unique: true,
		});
		const hit = await blockingLimiter.hit('subject');
		expect(hit).toEqual({
			limiter: blockingLimiter,
			remaining: 3 - counter,
			ttl: expect.any(Number),
			is_hit_unique: true,
		});
		expectTtl(hit.ttl, before + offset, [before, await redisTime()]);
		expect(await redisXClient.HGETALL(blockingKey)).toEqual({
			subject: String(counter),
		});
		expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(
			before + offset,
		);
	}

	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('exhaustion reports next-token time without incrementing or refreshing usage', async () => {
	const before = await redisTime();
	const deadline = before + ttl;
	await setHashField(key, 'subject', { value: 3, deadline });
	expect(await limiter.check('subject')).toBe(false);
	const current = await limiter.get('subject');
	expect(current).toEqual({ limiter, ttl: expect.any(Number) });
	expectTtl(current.ttl, before + 1201, [before, await redisTime()]);
	await expectRejectedHit(limiter, before + 1201);
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('an exceeding hit creates an independent block and preserves the refill deadline', async () => {
	const before = await redisTime();
	const deadline = before + ttl;
	await setHashField(blockingKey, 'subject', { value: 3, deadline });
	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, before + 1201, [before, await redisTime()]);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	const rejected = blockingLimiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: blockingLimiter,
		ttl: blockTtl,
	});
	const after = await redisTime();
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(deadline);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	const blockDeadline = await hashFieldExpiration(blockKey, blockField);
	expect(blockDeadline).toBeGreaterThanOrEqual(before + blockTtl);
	expect(blockDeadline).toBeLessThanOrEqual(after + blockTtl);
	expect(await redisXClient.EXPIRETIME(blockKey)).toBe(-1);
});

test('an active block outlives bucket refill and rejected hits preserve its expiration', async () => {
	const before = await redisTime();
	const deadline = before + 120;
	await setHashField(blockingKey, 'subject', {
		value: 3,
		deadline: before - 1,
	});
	await setHashField(blockKey, blockField, { value: '', deadline });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(-2);
	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, deadline, [before, await redisTime()]);
	await expectRejectedHit(blockingLimiter, deadline);
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(deadline);
});

test('expired usage and block fields restore full capacity and allow a fresh hit', async () => {
	const before = await redisTime();
	await setHashField(blockingKey, 'subject', {
		value: 3,
		deadline: before - 1,
	});
	await setHashField(blockKey, blockField, { value: '', deadline: before - 1 });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(-2);
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(-2);
	expect(await blockingLimiter.check('subject')).toBe(true);
	expect(await blockingLimiter.get('subject')).toEqual({
		limiter: blockingLimiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});

	const hit = await blockingLimiter.hit('subject');
	const after = await redisTime();
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 2,
		ttl: 1201,
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '1' });
	const deadline = await hashFieldExpiration(blockingKey, 'subject');
	expect(deadline).toBeGreaterThanOrEqual(before + 1201);
	expect(deadline).toBeLessThanOrEqual(after + 1201);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});
});
