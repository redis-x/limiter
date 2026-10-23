import { expect, test } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import { RedisXLimiter, RedisXLimiterType } from '../main.js';

const options = {
	type: RedisXLimiterType.FixedWindow,
	name: 'validation',
	limit: 2,
	ttl: 10,
};
let limiterId = 0;

/** Creates options with a unique limiter name for each constructor attempt. */
function createOptions(): typeof options {
	limiterId += 1;
	return { ...options, name: `validation-${limiterId}` };
}

const invalidNumbers = [
	1.5,
	Number('not-a-number'),
	Infinity,
	-Infinity,
	Number.MAX_SAFE_INTEGER + 1,
	'1',
	null,
];

test.each(['limit', 'ttl'] as const)('validates %s at construction', (key) => {
	for (const value of [0, -1, undefined, ...invalidNumbers]) {
		expect(
			() =>
				new RedisXLimiter(redisXClient, {
					...createOptions(),
					[key]: value,
				} as typeof options),
		).toThrow(`Invalid ${key}:`);
	}
});

test('validates block_ttl at construction', () => {
	for (const value of [-2, -1, 0, 2_147_483_648, ...invalidNumbers]) {
		expect(
			() =>
				new RedisXLimiter(redisXClient, {
					...createOptions(),
					block_ttl: value as number,
				}),
		).toThrow('Invalid block_ttl:');
	}
});

test('rejects window durations beyond the supported range', () => {
	expect(
		() =>
			new RedisXLimiter(redisXClient, {
				...createOptions(),
				ttl: 2_147_483_648,
			}),
	).toThrow('Invalid ttl:');
});

test('accepts the maximum supported capacity and duration', () => {
	expect(
		() =>
			new RedisXLimiter(redisXClient, {
				...createOptions(),
				limit: Number.MAX_SAFE_INTEGER,
				ttl: 2_147_483_647,
			}),
	).not.toThrow();
});

test('encodes omitted block_ttl as the exhaustion-only sentinel', () => {
	const limiterOptions = createOptions();
	const limiter = new RedisXLimiter(redisXClient, limiterOptions);

	expect(limiter._redis_args).toEqual([
		'0',
		limiterOptions.name,
		'2',
		'10',
		'-1',
	]);
});

test.each([1, 60, 2_147_483_647])(
	'preserves supported block_ttl setting %s',
	(block_ttl) => {
		const limiterOptions = createOptions();
		const limiter = new RedisXLimiter(redisXClient, {
			...limiterOptions,
			limit: 1,
			ttl: 1,
			block_ttl,
		});

		expect(limiter._redis_args).toEqual([
			'0',
			limiterOptions.name,
			'1',
			'1',
			String(block_ttl),
		]);
	},
);
