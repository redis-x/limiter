import { afterEach, expect, test } from 'vitest';
import { redisClient, redisXClient } from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimitersBatch,
	RedisXLimiterType,
} from '../main.js';

const options = {
	type: RedisXLimiterType.FixedWindow,
	limit: 2,
	ttl: 10,
};

afterEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

test('limiters sharing a redis client can be batched', async () => {
	const first = new RedisXLimiter(redisClient, {
		...options,
		name: 'client-first',
	});
	const second = new RedisXLimiter(redisClient, {
		...options,
		name: 'client-second',
	});

	expect(first._scripts).toBe(second._scripts);
	expect(await new RedisXLimitersBatch(first, second).hit('subject')).toEqual({
		limiter: first,
		remaining: 1,
		ttl: expect.any(Number),
		is_hit_unique: true,
	});
	expect(await redisXClient.HGETALL('@x:limiter:client-second')).toEqual({
		subject: '1',
	});
});
