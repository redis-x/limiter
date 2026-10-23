// oxlint-disable no-await-in-loop

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
	type: RedisXLimiterType.SlidingWindow,
	name: 'test-sliding-window',
	limit: 3,
	ttl,
});
const blockingLimiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.SlidingWindow,
	name: 'test-sliding-window-block',
	limit: 3,
	ttl,
	block_ttl: blockTtl,
});
const key = `${REDIS_PREFIX}:${limiter.name}:subject`;
const blockingKey = `${REDIS_PREFIX}:${blockingLimiter.name}:subject`;
const blockKey = `${REDIS_PREFIX}:_block`;
const blockField = `${blockingLimiter.name}:subject`;

beforeEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});
afterAll(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

/** Prepares a window with idle expiration at its latest member deadline. */
async function setWindow(redisKey: string, members: Record<string, number>) {
	await redisXClient.ZADD(redisKey, members);
	await redisXClient.EXPIREAT(redisKey, Math.max(...Object.values(members)));
}

/** Reads every stored member, including expired members awaiting cleanup. */
async function readWindow(redisKey: string): Promise<Record<string, number>> {
	const members = await redisXClient.ZRANGE(redisKey, 0, -1, {
		WITHSCORES: true,
	});
	return Object.fromEntries(
		members.map(({ member, score }) => [member, score]),
	);
}

/** Allows Redis's whole-second clock to tick during the operation. */
function expectTtl(
	value: number | undefined,
	deadline: number,
	times: [number, number],
) {
	expect(value).toBeGreaterThanOrEqual(deadline - times[1]);
	expect(value).toBeLessThanOrEqual(deadline - times[0]);
}

/** Checks the selected limiter and retry time on a rejected hit. */
async function expectRejectedHit(
	instance: RedisXLimiter,
	deadline: number,
	hitId: string,
) {
	const before = await redisTime();
	try {
		await instance.hit('subject', hitId);
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

test('an empty window reports full capacity and the first hit sets member and key expiration', async () => {
	expect(await limiter.check('subject', 'first')).toBe(true);
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.EXISTS(key, blockKey)).toBe(0);

	const before = await redisTime();
	expect(await limiter.hit('subject', 'first')).toEqual({
		limiter,
		remaining: 2,
		ttl,
		is_hit_unique: true,
	});
	const after = await redisTime();
	const deadline = await redisXClient.EXPIRETIME(key);
	expect(deadline).toBeGreaterThanOrEqual(before + ttl);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expect(await readWindow(key)).toEqual({ first: deadline });
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('expired members are ignored by reads and removed when an expired ID takes the final slot', async () => {
	const before = await redisTime();
	const members = {
		expired: before - 10,
		boundary: before,
		first: before + 30,
		last: before + 90,
	};
	const otherKey = `${REDIS_PREFIX}:${blockingLimiter.name}:other`;
	await setWindow(blockingKey, members);
	await setWindow(otherKey, { unrelated: before + 120 });

	expect(await blockingLimiter.check('subject', 'expired')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expectTtl(current.ttl, members.last, [before, await redisTime()]);
	expect(await readWindow(blockingKey)).toEqual(members);
	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(members.last);

	expect(await blockingLimiter.hit('subject', 'expired')).toEqual({
		limiter: blockingLimiter,
		remaining: 0,
		ttl,
		is_hit_unique: true,
	});
	const after = await redisTime();
	const deadline = await redisXClient.EXPIRETIME(blockingKey);
	expect(deadline).toBeGreaterThanOrEqual(before + ttl);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expect(await readWindow(blockingKey)).toEqual({
		first: members.first,
		last: members.last,
		expired: deadline,
	});
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	expect(await readWindow(otherKey)).toEqual({ unrelated: before + 120 });
	expect(await redisXClient.EXPIRETIME(otherKey)).toBe(before + 120);
});

test('an active repeated ID at full capacity refreshes expiration without consuming a slot', async () => {
	const before = await redisTime();
	const members = {
		first: before + 30,
		second: before + 60,
		last: before + 90,
	};
	await setWindow(blockingKey, members);

	expect(await blockingLimiter.check('subject', 'first')).toBe(true);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, members.first, [before, await redisTime()]);
	expect(await readWindow(blockingKey)).toEqual(members);
	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(members.last);

	expect(await blockingLimiter.hit('subject', 'first')).toEqual({
		limiter: blockingLimiter,
		remaining: 0,
		ttl,
		is_hit_unique: false,
	});
	const after = await redisTime();
	const deadline = await redisXClient.EXPIRETIME(blockingKey);
	expect(deadline).toBeGreaterThanOrEqual(before + ttl);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expect(await readWindow(blockingKey)).toEqual({
		...members,
		first: deadline,
	});
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('exhaustion rejects a new or expired ID with the earliest active deadline and no writes', async () => {
	const before = await redisTime();
	const members = {
		expired: before - 10,
		first: before + 30,
		second: before + 60,
		last: before + 90,
	};
	await setWindow(key, members);

	expect(await limiter.check('subject')).toBe(false);
	expect(await limiter.check('subject', 'expired')).toBe(false);
	const current = await limiter.get('subject');
	expect(current).toEqual({ limiter, ttl: expect.any(Number) });
	await expectRejectedHit(limiter, members.first, 'expired');
	expectTtl(current.ttl, members.first, [before, await redisTime()]);
	expect(await readWindow(key)).toEqual(members);
	expect(await redisXClient.EXPIRETIME(key)).toBe(members.last);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('an exceeding hit creates an independent block and preserves the sorted set', async () => {
	const before = await redisTime();
	const members = {
		first: before + 30,
		second: before + 60,
		last: before + 90,
	};
	await setWindow(blockingKey, members);

	expect(await blockingLimiter.check('subject', 'new')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	expectTtl(current.ttl, members.first, [before, await redisTime()]);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	const rejected = blockingLimiter.hit('subject', 'new');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: blockingLimiter,
		ttl: blockTtl,
	});
	const after = await redisTime();
	expect(await readWindow(blockingKey)).toEqual(members);
	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(members.last);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	const deadline = await hashFieldExpiration(blockKey, blockField);
	expect(deadline).toBeGreaterThanOrEqual(before + blockTtl);
	expect(deadline).toBeLessThanOrEqual(after + blockTtl);
	expect(await redisXClient.EXPIRETIME(blockKey)).toBe(-1);
});

test('an existing block rejects even repeated IDs without refreshing either deadline', async () => {
	const before = await redisTime();
	const members = {
		first: before + 30,
		second: before + 60,
		last: before + 90,
	};
	const deadline = before + 120;
	await setWindow(blockingKey, members);
	await setHashField(blockKey, blockField, { value: '', deadline });

	expect(await blockingLimiter.check('subject', 'first')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	await expectRejectedHit(blockingLimiter, deadline, 'first');
	expectTtl(current.ttl, deadline, [before, await redisTime()]);
	expect(await readWindow(blockingKey)).toEqual(members);
	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(members.last);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(deadline);
});

test('a block remains enforced after the sorted-set key expires', async () => {
	const before = await redisTime();
	const deadline = before + 60;
	await setWindow(blockingKey, { expired: before - 1 });
	await setHashField(blockKey, blockField, { value: '', deadline });

	expect(await blockingLimiter.check('subject', 'new')).toBe(false);
	const current = await blockingLimiter.get('subject');
	expect(current).toEqual({
		limiter: blockingLimiter,
		ttl: expect.any(Number),
	});
	await expectRejectedHit(blockingLimiter, deadline, 'new');
	expectTtl(current.ttl, deadline, [before, await redisTime()]);
	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(-2);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({ [blockField]: '' });
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(deadline);
});

test('expired usage and block state allow a new sorted set', async () => {
	const before = await redisTime();
	await setWindow(blockingKey, { expired: before - 1 });
	await setHashField(blockKey, blockField, { value: '', deadline: before - 1 });

	expect(await redisXClient.EXPIRETIME(blockingKey)).toBe(-2);
	expect(await hashFieldExpiration(blockKey, blockField)).toBe(-2);
	expect(await blockingLimiter.check('subject', 'new')).toBe(true);
	expect(await blockingLimiter.get('subject')).toEqual({
		limiter: blockingLimiter,
		remaining: 3,
		ttl: 0,
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});

	expect(await blockingLimiter.hit('subject', 'new')).toEqual({
		limiter: blockingLimiter,
		remaining: 2,
		ttl,
		is_hit_unique: true,
	});
	const after = await redisTime();
	const deadline = await redisXClient.EXPIRETIME(blockingKey);
	expect(deadline).toBeGreaterThanOrEqual(before + ttl);
	expect(deadline).toBeLessThanOrEqual(after + ttl);
	expect(await readWindow(blockingKey)).toEqual({ new: deadline });
	expect(await redisXClient.HGETALL(blockKey)).toEqual({});
});

test('calls without hit IDs create distinct members', async () => {
	const before = await redisTime();
	for (const remaining of [2, 1]) {
		expect(await limiter.hit('subject')).toEqual({
			limiter,
			remaining,
			ttl,
			is_hit_unique: true,
		});
	}

	const after = await redisTime();
	const members = await readWindow(key);
	expect(Object.keys(members)).toHaveLength(2);
	for (const deadline of Object.values(members)) {
		expect(deadline).toBeGreaterThanOrEqual(before + ttl);
		expect(deadline).toBeLessThanOrEqual(after + ttl);
	}

	expect(await redisXClient.EXPIRETIME(key)).toBe(
		Math.max(...Object.values(members)),
	);
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
});

test('reset deletes only the subject window and block', async () => {
	const now = await redisTime();
	const otherKey = `${REDIS_PREFIX}:${blockingLimiter.name}:other`;
	const otherBlockField = `${blockingLimiter.name}:other`;
	await setWindow(blockingKey, { a: now + ttl, b: now + ttl, c: now + ttl });
	await setWindow(otherKey, { a: now + ttl });
	await Promise.all(
		[blockField, otherBlockField].map((field) =>
			setHashField(blockKey, field, { value: '', deadline: now + blockTtl }),
		),
	);

	await blockingLimiter.reset('subject');

	expect(await redisXClient.EXISTS(blockingKey)).toBe(0);
	expect(await readWindow(otherKey)).toEqual({ a: now + ttl });
	expect(await redisXClient.HGETALL(blockKey)).toEqual({
		[otherBlockField]: '',
	});
	expect(await blockingLimiter.get('subject')).toMatchObject({ remaining: 3 });
});
