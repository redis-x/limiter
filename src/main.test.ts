import { test } from 'vitest';
import { redisXClient } from '../test/redis.js';
import { RedisXLimiter, RedisXLimiterType } from './main.js';

const limiter = new RedisXLimiter(redisXClient, {
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
