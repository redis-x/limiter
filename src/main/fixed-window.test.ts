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
		type: RedisXLimiterType.FixedWindow,
	});
}

afterAll(async () => {
	await redisXClient.DEL(names.map((name) => `${REDIS_PREFIX}:${name}`));
	await redisXClient.HDEL(
		`${REDIS_PREFIX}:_block`,
		names.map((name) => `${name}:subject`),
	);
});

test('tracks quota and recovers at the clock-aligned boundary', async () => {
	const limiter = createLimiter({ limit: 2, ttl: 4 });
	const key = `${REDIS_PREFIX}:${limiter.name}`;
	const initial = await limiter.get('subject');
	expect(initial).toEqual({ limiter, remaining: 2, ttl: expect.any(Number) });
	expect(initial.ttl).toBeGreaterThan(0);
	expect(initial.ttl).toBeLessThanOrEqual(4);
	expect(await limiter.check('subject')).toBe(true);

	// Start partway through an aligned window, using the public reset duration.
	await delay((((initial.ttl ?? 4) + 2) % 4) * 1000);
	const first = await limiter.hit('subject');
	expect(first).toEqual({ limiter, remaining: 1, ttl: expect.any(Number) });
	expect(first.ttl).toBeGreaterThan(0);
	expect(first.ttl).toBeLessThanOrEqual(2);
	expect(await redisXClient.HEXISTS(key, 'subject')).toBe(true);
	expect(await limiter.get('subject')).toMatchObject({ limiter, remaining: 1 });
	expect(await limiter.check('subject')).toBe(true);

	expect(await limiter.hit('subject')).toMatchObject({ limiter, remaining: 0 });
	expect(await limiter.check('subject')).toBe(false);
	const exhausted = await limiter.get('subject');
	expect(exhausted).toEqual({ limiter, ttl: expect.any(Number) });
	const rejected = limiter.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter,
		ttl: expect.any(Number),
	});
	expect(await limiter.get('other')).toMatchObject({ limiter, remaining: 2 });

	await delay((exhausted.ttl ?? 0) * 1000 + 50);
	expect(await redisXClient.HEXISTS(key, 'subject')).toBe(false);
	expect(await limiter.check('subject')).toBe(true);
	expect(await limiter.get('subject')).toMatchObject({ limiter, remaining: 2 });
	expect(await limiter.hit('subject')).toMatchObject({ limiter, remaining: 1 });
}, 10_000);

test('keeps a block beyond the window without extending it on retries', async () => {
	const limiter = createLimiter({ limit: 1, ttl: 2, block_ttl: 4 });
	const key = `${REDIS_PREFIX}:${limiter.name}`;
	const blockKey = `${REDIS_PREFIX}:_block`;
	const blockField = `${limiter.name}:subject`;
	const initial = await limiter.get('subject');
	if (initial.ttl === 1) {
		await delay(1000);
	}

	expect(await limiter.hit('subject')).toMatchObject({ limiter, remaining: 0 });
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
	expect(await limiter.get('subject')).toMatchObject({ limiter, remaining: 1 });
	expect(await limiter.hit('subject')).toMatchObject({ limiter, remaining: 0 });
}, 10_000);
