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

const ttl = 3600;
const blockTtl = 7200;
const limiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.FixedWindow,
	name: 'test-fixed-window',
	limit: 3,
	ttl,
});
const blockingLimiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.FixedWindow,
	name: 'test-fixed-window-block',
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

/** Allows the Redis clock to tick while the public methods execute. */
function expectTtl(
	value: number | undefined,
	deadline: number,
	times: [number, number],
) {
	expect(value).toBeGreaterThanOrEqual(deadline - times[1]);
	expect(value).toBeLessThanOrEqual(deadline - times[0]);
}

/** Checks a rejected hit's identity and remaining retry time. */
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

test('an empty window reports full capacity and the first hit sets an aligned deadline', async () => {
	expect(await limiter.check('subject')).toBe(true);
	const initial = await limiter.get('subject');
	expect(initial).toStrictEqual({
		limiter,
		remaining: 3,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(initial.ttl).toBeGreaterThan(0);
	expect(initial.ttl).toBeLessThanOrEqual(ttl);
	expect(await redisXClient.EXISTS(key, blockKey)).toBe(0);

	const before = await redisTime();
	const hit = await limiter.hit('subject');
	const after = await redisTime();
	expect(hit).toStrictEqual({
		limiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '1' });
	const deadline = await hashFieldExpiration(key, 'subject');
	expect(deadline % ttl).toBe(0);
	expect(deadline).toBeGreaterThan(before);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expectTtl(hit.ttl, deadline, [before, after]);
	expect(await redisXClient.EXPIRETIME(key)).toBe(-1);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('a partially used window increments only its subject and preserves expiration', async () => {
	const before = await redisTime();
	const deadline = before - (before % ttl) + ttl;
	await setHashField(key, 'subject', { value: 1, deadline });
	await setHashField(key, 'other', { value: 3, deadline });

	expect(await limiter.check('subject')).toBe(true);
	const current = await limiter.get('subject');
	expect(current).toEqual({
		limiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '1', other: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(deadline);

	const hit = await limiter.hit('subject');
	const after = await redisTime();
	expect(hit).toEqual({
		limiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, deadline, [before, after]);
	expectTtl(hit.ttl, deadline, [before, after]);
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '2', other: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(deadline);
	expect(await hashFieldExpiration(key, 'other')).toBe(deadline);
	expect(await redisXClient.EXPIRETIME(key)).toBe(-1);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('the last available hit succeeds without creating a block', async () => {
	const before = await redisTime();
	const deadline = before - (before % ttl) + ttl;
	await setHashField(blockingKey, 'subject', { value: 2, deadline });

	expect(await blockingLimiter.check('subject')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	const hit = await blockingLimiter.hit('subject');
	const after = await redisTime();
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 0,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, deadline, [before, after]);
	expectTtl(hit.ttl, deadline, [before, after]);
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('exhaustion without block_ttl rejects a hit without changing stored state', async () => {
	const before = await redisTime();
	const deadline = before - (before % ttl) + ttl;
	await setHashField(key, 'subject', { value: 3, deadline });

	expect(await limiter.check('subject')).toBe(false);
	const current = await limiter.get('subject');
	expect(current).toEqual({ limiter, ttl: expect.any(Number) });
	await expectRejectedHit(limiter, deadline);
	const after = await redisTime();
	expectTtl(current.ttl, deadline, [before, after]);
	expect(await redisXClient.HGETALL(key)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(key, 'subject')).toBe(deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('an exceeding hit creates an independently expiring block and preserves usage', async () => {
	const before = await redisTime();
	const deadline = before - (before % ttl) + ttl;
	await setHashField(blockingKey, 'subject', { value: 3, deadline });

	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	const rejected = blockingLimiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: blockingLimiter,
		ttl: blockTtl,
	});
	const after = await redisTime();
	expectTtl(current.ttl, deadline, [before, after]);
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '3' });
	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(deadline);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	const blockDeadline = await hashFieldExpiration(blockKey, blockField);
	expect(blockDeadline).toBeGreaterThanOrEqual(before + blockTtl);
	expect(blockDeadline).toBeLessThanOrEqual(after + blockTtl);
	expect(await redisXClient.EXPIRETIME(blockKey)).toBe(-1);
});

test('an existing block denies a subject with no usage and keeps its original deadline', async () => {
	const before = await redisTime();
	const deadline = before + 60;
	await setHashField(blockKey, blockField, { value: '', deadline });

	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	await expectRejectedHit(blockingLimiter, deadline);
	const after = await redisTime();
	expectTtl(current.ttl, deadline, [before, after]);
	expect(await redisXClient.EXISTS(blockingKey)).toBe(0);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(deadline);
	expect(await redisXClient.EXPIRETIME(blockKey)).toBe(-1);
});

test('expired usage and block fields allow a fresh window', async () => {
	const before = await redisTime();
	await setHashField(blockingKey, 'subject', {
		value: 3,
		deadline: before - 1,
	});
	await setHashField(blockKey, blockField, { value: '', deadline: before - 1 });

	expect(await hashFieldExpiration(blockingKey, 'subject')).toBe(-2);
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(-2);
	expect(await blockingLimiter.check('subject')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		remaining: 3,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});

	const hit = await blockingLimiter.hit('subject');
	const after = await redisTime();
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(blockingKey)).toEqual({ subject: '1' });
	const deadline = await hashFieldExpiration(blockingKey, 'subject');
	expect(deadline % ttl).toBe(0);
	expect(deadline).toBeGreaterThan(before);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expectTtl(hit.ttl, deadline, [before, after]);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});
});
