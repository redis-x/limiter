// oxlint-disable no-await-in-loop -- Read each limiter's persisted state for comparison.

import { afterAll, beforeEach, expect, test } from 'vitest';
import {
	hashFieldExpiration,
	redisTime,
	redisXClient,
} from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimiterExceededError,
	RedisXLimitersBatch,
	RedisXLimiterType,
} from '../main.js';
import { REDIS_PREFIX } from '../utils.js';

const lowPriority = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.FixedWindowUserDefinedStart,
	name: 'test-batch-first-hit',
	limit: 1,
	ttl: 7200,
	block_ttl: 7200,
	priority: 1,
});
const shortBlock = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.FixedWindow,
	name: 'test-batch-fixed',
	limit: 1,
	ttl: 900,
	block_ttl: 1800,
	priority: 10,
});
const longBlock = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.SlidingWindow,
	name: 'test-batch-sliding',
	limit: 1,
	ttl: 1800,
	block_ttl: 3600,
	priority: 10,
});
const approximate = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.SlidingWindowApproximate,
	name: 'test-batch-approximate',
	limit: 3,
	ttl: 3600,
	priority: 100,
});
const bucket = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.TokenBucket,
	name: 'test-batch-bucket',
	limit: 3,
	ttl: 3600,
	priority: 100,
});
// A repeated instance must not appear twice in results or receive two hits.
const batch = new RedisXLimitersBatch(
	lowPriority,
	shortBlock,
	longBlock,
	approximate,
	bucket,
	lowPriority,
);
const lowKey = `${REDIS_PREFIX}:${lowPriority.name}`;
const fixedKey = `${REDIS_PREFIX}:${shortBlock.name}`;
const slidingKey = `${REDIS_PREFIX}:${longBlock.name}:subject`;
const approximateKey = `${REDIS_PREFIX}:${approximate.name}`;
const bucketKey = `${REDIS_PREFIX}:${bucket.name}`;
const blockKey = `${REDIS_PREFIX}:_block`;

beforeEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});
afterAll(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

/** Captures counters, members, and deadlines so rejection cannot hide partial writes. */
async function readUsage(epoch: number) {
	const hashes = [];
	for (const [key, field] of [
		[lowKey, 'subject'],
		[fixedKey, 'subject'],
		[approximateKey, `${epoch}:subject`],
		[bucketKey, 'subject'],
	] as const) {
		hashes.push({
			key,
			fields: await redisXClient.HGETALL(key),
			deadline: await hashFieldExpiration(key, field),
		});
	}

	return {
		hashes,
		members: await redisXClient.ZRANGE(slidingKey, 0, -1, { WITHSCORES: true }),
		slidingDeadline: await redisXClient.EXPIRETIME(slidingKey),
	};
}

/** Allows Redis's clock to tick between requests. */
function expectTtl(
	value: number | undefined,
	deadline: number,
	times: [number, number],
) {
	expect(value).toBeGreaterThanOrEqual(deadline - times[1]);
	expect(value).toBeLessThanOrEqual(deadline - times[0]);
}

/** Verifies every committed limiter entry and returns its snapshot. */
async function expectAcceptedUsage(times: [number, number]) {
	const hitTime = (await hashFieldExpiration(lowKey, 'subject')) - 7200;
	expect(hitTime).toBeGreaterThanOrEqual(times[0]);
	expect(hitTime).toBeLessThanOrEqual(times[1]);
	const epoch = Math.floor(hitTime / 3600);
	const accepted = await readUsage(epoch);
	expect(accepted).toEqual({
		hashes: [
			{ key: lowKey, fields: { subject: '1' }, deadline: hitTime + 7200 },
			{
				key: fixedKey,
				fields: { subject: '1' },
				deadline: (Math.floor(hitTime / 900) + 1) * 900,
			},
			{
				key: approximateKey,
				fields: { [`${epoch}:subject`]: '1' },
				deadline: (epoch + 2) * 3600,
			},
			{ key: bucketKey, fields: { subject: '1' }, deadline: hitTime + 1200 },
		],
		members: [{ member: 'first', score: hitTime + 1800 }],
		slidingDeadline: hitTime + 1800,
	});
	expect(await redisXClient.EXISTS(blockKey)).toBe(0);

	return { hitTime, epoch, accepted };
}

test('a mixed batch returns the selected states, commits every accepted hit, and rejects without partial usage writes', async () => {
	expect(await batch.check('subject', 'first')).toBe(true);
	expect(await batch.getAll('subject')).toEqual([
		{ limiter: lowPriority, remaining: 1, ttl: undefined, is_hit_unique: true },
		{
			limiter: shortBlock,
			remaining: 1,
			ttl: expect.any(Number),
			is_hit_unique: true,
		},
		{ limiter: longBlock, remaining: 1, ttl: 0, is_hit_unique: true },
		{ limiter: approximate, remaining: 3, ttl: 0, is_hit_unique: true },
		{ limiter: bucket, remaining: 3, ttl: 0, is_hit_unique: true },
	]);
	expect(await batch.get('subject')).toEqual({
		limiter: shortBlock,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.sendCommand('DBSIZE')).toBe(0);

	const before = await redisTime();
	expect(await batch.hit('subject', 'first')).toEqual({
		limiter: lowPriority,
		remaining: 0,
		ttl: 7200,
		is_hit_unique: true,
	});
	const after = await redisTime();
	const { hitTime, epoch, accepted } = await expectAcceptedUsage([
		before,
		after,
	]);
	// A repeated sliding-window ID cannot bypass exhaustion of the other limiters.
	expect(await batch.check('subject', 'first')).toBe(false);

	const rejectBefore = await redisTime();
	const rejected = batch.hit('subject', 'second');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: longBlock,
		ttl: 3600,
	});
	const rejectAfter = await redisTime();
	expect(await readUsage(epoch)).toEqual(accepted);
	expect(await redisXClient.HGETALL(blockKey)).toEqual({
		[`${lowPriority.name}:subject`]: '',
		[`${shortBlock.name}:subject`]: '',
		[`${longBlock.name}:subject`]: '',
	});
	const blockDeadlines = [];
	for (const [limiter, duration] of [
		[lowPriority, 7200],
		[shortBlock, 1800],
		[longBlock, 3600],
	] as const) {
		const deadline = await hashFieldExpiration(
			blockKey,
			`${limiter.name}:subject`,
		);
		expect(deadline).toBeGreaterThanOrEqual(rejectBefore + duration);
		expect(deadline).toBeLessThanOrEqual(rejectAfter + duration);
		blockDeadlines.push(deadline);
	}

	const readBefore = await redisTime();
	expect(await batch.check('subject')).toBe(false);
	const current = await batch.get('subject');
	expect(current).toEqual({ limiter: longBlock, ttl: expect.any(Number) });
	const all = await batch.getAll('subject');
	expect(all).toEqual([
		{ limiter: lowPriority, ttl: expect.any(Number) },
		{ limiter: shortBlock, ttl: expect.any(Number) },
		{ limiter: longBlock, ttl: expect.any(Number) },
		{
			limiter: approximate,
			remaining: 2,
			ttl: expect.any(Number),
			is_hit_unique: true,
		},
		{
			limiter: bucket,
			remaining: 2,
			ttl: expect.any(Number),
			is_hit_unique: true,
		},
	]);
	const readAfter = await redisTime();
	expectTtl(current.ttl, blockDeadlines[2]!, [readBefore, readAfter]);
	const deadlines = [...blockDeadlines, (epoch + 2) * 3600, hitTime + 1200];
	for (const [index, state] of all.entries()) {
		expectTtl(state.ttl, deadlines[index]!, [readBefore, readAfter]);
	}

	expect(await readUsage(epoch)).toEqual(accepted);
});

test('reset deletes usage and blocks of every limiter for one subject', async () => {
	await batch.hit('subject');
	await expect(batch.hit('subject')).rejects.toThrow(
		RedisXLimiterExceededError,
	);
	await batch.hit('other');
	expect(Object.keys(await redisXClient.HGETALL(blockKey))).toHaveLength(3);

	await batch.reset('subject');

	expect(await redisXClient.EXISTS(blockKey)).toBe(0);
	expect(await redisXClient.EXISTS(slidingKey)).toBe(0);
	expect(
		await redisXClient.EXISTS(`${REDIS_PREFIX}:${longBlock.name}:other`),
	).toBe(1);
	for (const key of [lowKey, fixedKey, approximateKey, bucketKey]) {
		expect(Object.keys(await redisXClient.HGETALL(key))).toEqual([
			expect.stringMatching(/other$/u),
		]);
	}

	expect(await batch.hit('subject')).toMatchObject({ remaining: 0 });
});
