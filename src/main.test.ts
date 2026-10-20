import { test } from 'vitest';
import { redisClient } from '../test/redis.js';
import { RedisXLimiter, RedisXLimiterType } from './main.js';

const limiter = new RedisXLimiter(redisClient, {
	type: RedisXLimiterType.FixedWindowUserDefinedStart,
	name: 'test',
	limit: 2,
	ttl: 10,
});

test('test', async () => {
	await limiter.hit('user1');
	await limiter.hit('user1');
	await limiter.hit('user1');
});
