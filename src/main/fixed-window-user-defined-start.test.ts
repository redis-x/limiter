import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimiterExceededError,
	RedisXLimiterType,
} from '../main.js';
import { REDIS_PREFIX } from '../utils.js';

const names: string[] = [];

/** Creates an independent limiter for each test. */
function createLimiter(options: {
	limit: number;
	ttl: number;
	block_ttl?: number;
}) {
	const name = randomUUID();
	names.push(name);
	return new RedisXLimiter(redisXClient, {
		...options,
		name,
		type: RedisXLimiterType.FixedWindowUserDefinedStart,
	});
}

afterAll(async () => {
	await redisXClient.DEL(names.map((name) => `${REDIS_PREFIX}:${name}`));
	await redisXClient.HDEL(
		`${REDIS_PREFIX}:_block`,
		names.map((name) => `${name}:subject`),
	);
});

test('starts on the first hit and preserves that deadline through exhaustion', async () => {
	const limiter = createLimiter({ limit: 2, ttl: 3 });
	const key = `${REDIS_PREFIX}:${limiter.name}`;
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 2,
		ttl: undefined,
	});
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.hit('subject')).toEqual({
		limiter,
		remaining: 1,
		ttl: 3,
	});
	expect(await redisXClient.HEXISTS(key, 'subject')).toBe(true);
	expect(await limiter.get('subject')).toMatchObject({ limiter, remaining: 1 });
	expect(await limiter.check('subject')).toBe(true);

	await delay(1100);
	const last = await limiter.hit('subject');
	expect(last).toEqual({ limiter, remaining: 0, ttl: expect.any(Number) });
	expect(last.ttl).toBeGreaterThan(0);
	expect(last.ttl).toBeLessThan(3);
	expect(await limiter.check('subject')).toBe(false);
	const exhausted = await limiter.get('subject');
	expect(exhausted).toEqual({ limiter, ttl: expect.any(Number) });
	const rejected = limiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter,
		ttl: expect.any(Number),
	});
	expect(await limiter.get('other')).toEqual({
		limiter,
		remaining: 2,
		ttl: undefined,
	});

	await delay((exhausted.ttl ?? 0) * 1000 + 50);
	expect(await redisXClient.HEXISTS(key, 'subject')).toBe(false);
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 2,
		ttl: undefined,
	});
	expect(await limiter.hit('subject')).toEqual({
		limiter,
		remaining: 1,
		ttl: 3,
	});
}, 10_000);

test('keeps a block beyond the window without extending it on retries', async () => {
	const limiter = createLimiter({ limit: 1, ttl: 2, block_ttl: 4 });
	const key = `${REDIS_PREFIX}:${limiter.name}`;
	const blockKey = `${REDIS_PREFIX}:_block`;
	const blockField = `${limiter.name}:subject`;
	expect(await limiter.hit('subject')).toEqual({
		limiter,
		remaining: 0,
		ttl: 2,
	});
	expect(await limiter.check('subject')).toBe(false);
	const exhausted = await limiter.get('subject');
	expect(exhausted.ttl).toBeLessThanOrEqual(2);
	expect(await redisXClient.HEXISTS(blockKey, blockField)).toBe(false);
	const rejected = limiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({ limiter, ttl: 4 });
	expect(await redisXClient.HEXISTS(blockKey, blockField)).toBe(true);

	await delay(2100);
	expect(await redisXClient.HEXISTS(key, 'subject')).toBe(false);
	expect(await redisXClient.HEXISTS(blockKey, blockField)).toBe(true);
	expect(await limiter.check('subject')).toBe(false);
	const blocked = await limiter.get('subject');
	expect(blocked).toEqual({ limiter, ttl: expect.any(Number) });
	expect(blocked.ttl).toBeGreaterThan(0);
	expect(blocked.ttl).toBeLessThanOrEqual(2);
	await expect(limiter.hit('subject')).rejects.toBeInstanceOf(
		RedisXLimiterExceededError,
	);

	await delay((blocked.ttl ?? 0) * 1000 + 50);
	expect(await redisXClient.HEXISTS(blockKey, blockField)).toBe(false);
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.get('subject')).toEqual({
		limiter,
		remaining: 1,
		ttl: undefined,
	});
	expect(await limiter.hit('subject')).toEqual({
		limiter,
		remaining: 0,
		ttl: 2,
	});
}, 10_000);
