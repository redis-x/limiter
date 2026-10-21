import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { redisXClient } from '../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimiterExceededError,
	RedisXLimiterType,
} from './main.js';

const limiter = new RedisXLimiter(redisXClient, {
	type: RedisXLimiterType.FixedWindowUserDefinedStart,
	name: randomUUID(),
	limit: 2,
	ttl: 10,
});

afterAll(async () => {
	await redisXClient.DEL(limiter._getRedisKey('user1'));
});

test('accepts two hits and rejects the third', async () => {
	await expect(limiter.hit('user1')).resolves.toMatchObject({
		limiter,
		remaining: 1,
	});

	await expect(limiter.hit('user1')).resolves.toMatchObject({
		limiter,
		remaining: 0,
	});

	await expect(limiter.hit('user1')).rejects.toBeInstanceOf(
		RedisXLimiterExceededError,
	);
});
