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
const blockTtl = ttl * 3;
const limiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.SlidingWindowApproximate,
	name: 'test-sliding-window-approximate',
	limit: 3,
	ttl,
});
const blockingLimiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.SlidingWindowApproximate,
	name: 'test-sliding-window-approximate-block',
	limit: 3,
	ttl,
	block_ttl: blockTtl,
});
const blockKey = `${REDIS_PREFIX}:_block`;
const blockField = `${blockingLimiter.name}:subject`;

beforeEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});
afterAll(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

/** Prepares the two retained epochs using the real Redis clock. */
async function setWindow(
	instance: RedisXLimiter,
	previous: number,
	current: number,
) {
	const now = await redisTime();
	const epoch = Math.floor(now / ttl);
	const key = `${REDIS_PREFIX}:${instance.name}`;
	const previousField = `${epoch - 1}:subject`;
	const currentField = `${epoch}:subject`;
	const rollover = (epoch + 1) * ttl;
	const deadline = rollover + ttl;
	if (previous > 0) {
		await setHashField(key, previousField, {
			value: previous,
			deadline: rollover,
		});
	}

	if (current > 0) {
		await setHashField(key, currentField, { value: current, deadline });
	}

	return { now, key, previousField, currentField, rollover, deadline };
}

/** Allows Redis's whole-second clock to tick during public calls. */
function expectTtl(
	value: number | undefined,
	deadline: number,
	times: [number, number],
) {
	expect(value).toBeGreaterThanOrEqual(deadline - times[1]);
	expect(value).toBeLessThanOrEqual(deadline - times[0]);
}

/** Verifies rejection and its independently calculated retry deadline. */
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

test('an empty window has full capacity and its first hit retains the epoch for two windows', async () => {
	const s = await setWindow(limiter, 0, 0);
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.EXISTS(s.key, blockKey)).toBe(0);

	const hit = await limiter.hit('subject');
	expect(hit).toEqual({
		limiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, s.deadline, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({ [s.currentField]: '1' });
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.EXPIRETIME(s.key)).toBe(-1);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('previous-only usage recovers at rollover and a hit starts the current epoch', async () => {
	const s = await setWindow(limiter, 1, 0);
	const otherField = s.currentField.replace('subject', 'other');
	await setHashField(s.key, otherField, { value: 3, deadline: s.deadline });
	expect(await limiter.check('subject')).toBe(true);
	const current = await limiter.get('subject');
	expect(current).toEqual({
		limiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, s.rollover, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[otherField]: '3',
	});

	const hit = await limiter.hit('subject');
	expect(hit).toEqual({
		limiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, s.deadline, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[s.currentField]: '1',
		[otherField]: '3',
	});
	expect(await hashFieldExpiration(s.key, s.previousField)).toBe(s.rollover);
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await hashFieldExpiration(s.key, otherField)).toBe(s.deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('weighted usage rounds capacity down and the final fitting hit preserves both deadlines', async () => {
	const s = await setWindow(blockingLimiter, 1, 1);
	expect(await blockingLimiter.check('subject')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, s.deadline, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[s.currentField]: '1',
	});

	const hit = await blockingLimiter.hit('subject');
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 0,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, s.deadline, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[s.currentField]: '2',
	});
	expect(await hashFieldExpiration(s.key, s.previousField)).toBe(s.rollover);
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('fractional exhaustion waits for previous usage to decay and writes no block', async () => {
	const s = await setWindow(limiter, 1, 2);
	expect(await limiter.check('subject')).toBe(false);
	const current = await limiter.get('subject');
	expect(current).toEqual({ limiter, ttl: expect.any(Number) });
	expectTtl(current.ttl, s.rollover, [s.now, await redisTime()]);
	await expectRejectedHit(limiter, s.rollover);
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[s.currentField]: '2',
	});
	expect(await hashFieldExpiration(s.key, s.previousField)).toBe(s.rollover);
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('a full current epoch requires rollover plus rounded-up decay before another hit', async () => {
	const s = await setWindow(limiter, 0, 3);
	const retryDeadline = s.rollover + Math.ceil(ttl / 3);
	expect(await limiter.check('subject')).toBe(false);
	const current = await limiter.get('subject');
	expect(current).toEqual({ limiter, ttl: expect.any(Number) });
	expectTtl(current.ttl, retryDeadline, [s.now, await redisTime()]);
	await expectRejectedHit(limiter, retryDeadline);
	expect(await redisXClient.HGETALL(s.key)).toEqual({ [s.currentField]: '3' });
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('an exceeding hit creates an independent block without incrementing or refreshing usage', async () => {
	const s = await setWindow(blockingLimiter, 1, 2);
	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, s.rollover, [s.now, await redisTime()]);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	const rejected = blockingLimiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: blockingLimiter,
		ttl: blockTtl,
	});
	const after = await redisTime();
	expect(await redisXClient.HGETALL(s.key)).toEqual({
		[s.previousField]: '1',
		[s.currentField]: '2',
	});
	expect(await hashFieldExpiration(s.key, s.previousField)).toBe(s.rollover);
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	const deadline = await hashFieldExpiration(blockKey, blockField);
	expect(deadline).toBeGreaterThanOrEqual(s.now + blockTtl);
	expect(deadline).toBeLessThanOrEqual(after + blockTtl);
	expect(await redisXClient.EXPIRETIME(blockKey)).toBe(-1);
});

test('a stored block outlives old epochs and rejected retries preserve its deadline', async () => {
	const s = await setWindow(blockingLimiter, 0, 0);
	const oldField = `${Math.floor(s.now / ttl) - 2}:subject`;
	await setHashField(s.key, oldField, { value: 3, deadline: s.rollover - ttl });
	const deadline = s.now + 120;
	await setHashField(blockKey, blockField, { value: '', deadline });
	expect(await hashFieldExpiration(s.key, oldField)).toBe(-2);
	expect(await blockingLimiter.check('subject')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, deadline, [s.now, await redisTime()]);
	await expectRejectedHit(blockingLimiter, deadline);
	expect(await redisXClient.HGETALL(s.key)).toEqual({});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(deadline);
});

test('expired epochs and block fields disappear and allow a fresh hit', async () => {
	const s = await setWindow(blockingLimiter, 0, 0);
	const oldField = `${Math.floor(s.now / ttl) - 2}:subject`;
	await setHashField(s.key, oldField, { value: 3, deadline: s.rollover - ttl });
	await setHashField(blockKey, blockField, { value: '', deadline: s.now - 1 });
	expect(await hashFieldExpiration(s.key, oldField)).toBe(-2);
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(-2);
	expect(await blockingLimiter.check('subject')).toBe(true);
	expect(await blockingLimiter.get('subject')).toEqual({
		limiter: blockingLimiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(s.key)).toEqual({});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});

	const hit = await blockingLimiter.hit('subject');
	expect(hit).toEqual({
		limiter: blockingLimiter,
		remaining: 2,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(hit.ttl, s.deadline, [s.now, await redisTime()]);
	expect(await redisXClient.HGETALL(s.key)).toEqual({ [s.currentField]: '1' });
	expect(await hashFieldExpiration(s.key, s.currentField)).toBe(s.deadline);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});
});
