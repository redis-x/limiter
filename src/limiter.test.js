
import {
	beforeAll,
	describe,
	test,
	expect,
}                                    from 'vitest';
import { createClient }              from 'redis';
import { RedisXClient }              from '@redis-x/client';
import {
	RedisXLimiter,
	RedisXLimiterLimitExceededError,
}                                    from './main.js';

const redisClient = createClient({
	socket: {
		host: 'localhost',
		port: 16379,
	},
});

const redisXClient = new RedisXClient(redisClient);

beforeAll(async () => {
	await redisClient.connect();
	await redisClient.FLUSHDB();
	await redisClient.SCRIPT_FLUSH();
});

describe('constructor', () => {
	test('raw Redis client', () => {
		expect(
			new RedisXLimiter(
				redisClient,
				{
					namespace: 'test',
					limits: {},
				},
			),
		).toBeDefined();
	});

	test('redis-x client', () => {
		expect(
			new RedisXLimiter(
				redisXClient,
				{
					namespace: 'test',
					limits: {},
				},
			),
		).toBeDefined();
	});
});

describe('plain counter', () => {
	const redisXLimiter = new RedisXLimiter(
		redisXClient,
		{
			namespace: 'test',
			limits: {
				foo: {
					type: 'counter',
					limit: 2,
					ttl: 10,
				},
				bar: {
					type: 'counter',
					limit: 2,
					ttl: 1000,
					ttl_block: 1_000_000,
				},
			},
		},
	);

	test('limit', async () => {
		await expect(
			redisXLimiter.hit(1),
		).resolves.toBeUndefined();

		await expect(
			redisXLimiter.hit(1),
		).resolves.toBeUndefined();

		const rejected = expect(
			redisXLimiter.hit(1),
		).rejects;
		await rejected.toBeInstanceOf(RedisXLimiterLimitExceededError);
		await rejected.toHaveProperty('limit_name', 'bar');
		await rejected.toHaveProperty('ttl', 1_000_000);

		// other keys should not be affected
		await expect(
			redisXLimiter.hit(2),
		).resolves.toBeUndefined();
	});

	test('custom error', async () => {
		class CustomError extends Error {}

		const redisXLimiterError = new RedisXLimiter(
			redisXClient,
			{
				namespace: 'test-error',
				limits: {
					foo: {
						type: 'counter',
						limit: 1,
						ttl: 10,
						onError() {
							throw new CustomError();
						},
					},
				},
			},
		);

		await expect(
			redisXLimiterError.hit(1),
		).resolves.toBeUndefined();

		await expect(
			redisXLimiterError.hit(1),
		).rejects.toBeInstanceOf(CustomError);
	});

	test('get', async () => {
		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			foo: {
				ttl: 10,
			},
			bar: {
				ttl: 1_000_000,
			},
		});

		await expect(
			redisXLimiter.get(2),
		).resolves.toStrictEqual({
			foo: {
				counter: 1,
				ttl: 10,
			},
			bar: {
				counter: 1,
				ttl: 1000,
			},
		});
	});

	test('check', async () => {
		const rejected = expect(
			redisXLimiter.check(1),
		).rejects;
		await rejected.toBeInstanceOf(RedisXLimiterLimitExceededError);
		await rejected.toHaveProperty('limit_name', 'bar');
		await rejected.toHaveProperty('ttl', 1_000_000);

		await expect(
			redisXLimiter.check(2),
		).resolves.toBeUndefined();
	});

	test('reset all', async () => {
		await redisXLimiter.reset(1);

		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			foo: {
				counter: 0,
			},
			bar: {
				counter: 0,
			},
		});
	});

	test('reset only one', async () => {
		try {
			await redisXLimiter.hit(1);
			await redisXLimiter.hit(1);
			await redisXLimiter.hit(1);
		}
		catch {}

		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			foo: {
				ttl: 10,
			},
			bar: {
				ttl: 1_000_000,
			},
		});

		await redisXLimiter.reset(1, 'bar');

		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			foo: {
				ttl: 10,
			},
			bar: {
				counter: 0,
			},
		});
	});
});

describe('counter & unique elements', () => {
	const redisXLimiter = new RedisXLimiter(
		redisXClient,
		{
			namespace: 'test-counter-unique',
			limits: {
				count: {
					type: 'counter',
					limit: 3,
					ttl: 100,
				},
				unique: {
					type: 'set',
					limit: 2,
					ttl: 1000,
				},
			},
		},
	);

	test('reach limit by unique elements', async () => {
		await expect(
			redisXLimiter.hit(1, 'apple'),
		).resolves.toBeUndefined();

		await expect(
			redisXLimiter.hit(1, 'banana'),
		).resolves.toBeUndefined();

		const rejected = expect(
			redisXLimiter.hit(1, 'cherry'),
		).rejects;
		await rejected.toBeInstanceOf(RedisXLimiterLimitExceededError);
		await rejected.toHaveProperty('limit_name', 'unique');
		await rejected.toHaveProperty('ttl', 1000);

		// other keys should not be affected
		await expect(
			redisXLimiter.hit(2, 'dragonfruit'),
		).resolves.toBeUndefined();
	});

	test('reset all', async () => {
		await redisXLimiter.reset(1);

		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			count: {
				counter: 0,
			},
			unique: {
				counter: 0,
			},
		});
	});

	test('reach limit by total hit count', async () => {
		// hit one element 3 times — nothing sould happen

		await expect(
			redisXLimiter.hit(1, 'apple'),
		).resolves.toBeUndefined();

		await expect(
			redisXLimiter.hit(1, 'apple'),
		).resolves.toBeUndefined();

		await expect(
			redisXLimiter.hit(1, 'apple'),
		).resolves.toBeUndefined();

		// hit it one more time — should throw an error
		const rejected = expect(
			redisXLimiter.hit(1, 'apple'),
		).rejects;
		await rejected.toBeInstanceOf(RedisXLimiterLimitExceededError);
		await rejected.toHaveProperty('limit_name', 'count');
		await rejected.toHaveProperty('ttl', 100);

		// other keys should not be affected
		await expect(
			redisXLimiter.hit(2, 'apple'),
		).resolves.toBeUndefined();
	});

	test('reset single limit', async () => {
		// reset the counter limit
		await redisXLimiter.reset(1, 'count');

		await expect(
			redisXLimiter.get(1),
		).resolves.toStrictEqual({
			count: {
				counter: 0,
			},
			unique: {
				counter: 1,
				ttl: 1000,
			},
		});

		// now we can successfully hit again

		await expect(
			redisXLimiter.hit(1, 'banana'),
		).resolves.toBeUndefined();
	});
});
