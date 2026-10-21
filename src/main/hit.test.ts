import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimiterExceededError,
	RedisXLimitersBatch,
	RedisXLimiterType,
} from '../main.js';
import { SCRIPT_OP, ScriptResultError } from '../scripts.js';
import { REDIS_PREFIX } from '../utils.js';

const blockKey = `${REDIS_PREFIX}:_block`;
const ownedKeys = new Set<string>();
const ownedBlockFields: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await redisXClient.DEL([...ownedKeys]);
	await redisXClient.HDEL(blockKey, ownedBlockFields);
});

/** Creates isolated state on the shared test client. */
function createLimiter(
	options: {
		priority?: number;
		limit?: number;
		ttl?: number;
		block_ttl?: number;
		type?: RedisXLimiterType;
	} = {},
) {
	const limiter = new RedisXLimiter(redisXClient, {
		type: RedisXLimiterType.FixedWindowUserDefinedStart,
		name: randomUUID(),
		limit: 2,
		ttl: 60,
		...options,
	});
	ownedKeys.add(limiter._getRedisKey('subject'));
	ownedBlockFields.push(`${limiter.name}:subject`);
	return limiter;
}

test('batch commits usage and returns the smallest remaining quota regardless of priority', async () => {
	const generous = createLimiter({ priority: 100, limit: 10, ttl: 120 });
	const strict = createLimiter({ priority: 1, limit: 2, ttl: 60 });
	const batch = new RedisXLimitersBatch(generous, strict);
	expect(await batch.hit('subject')).toEqual({
		name: strict.name,
		usage: { remaining: 1, ttl: 60 },
	});
	expect(await batch.hit('subject')).toEqual({
		name: strict.name,
		usage: { remaining: 0, ttl: expect.any(Number) },
	});
	expect(
		await redisXClient.HGET(generous._getRedisKey('subject'), 'subject'),
	).toBe('2');
	expect(
		await redisXClient.HGET(strict._getRedisKey('subject'), 'subject'),
	).toBe('2');
});

test('batch persists new blocks, throws the highest-priority one, and consumes no usage', async () => {
	const conditional = createLimiter({
		priority: 10,
		limit: 1,
		block_ttl: 3600,
	});
	const unconditional = createLimiter({
		priority: 100,
		limit: 1,
		block_ttl: 60,
	});
	const companion = createLimiter();
	await conditional.hit('subject');
	await unconditional.hit('subject');
	const batch = new RedisXLimitersBatch(companion, conditional, unconditional);
	const rejected = batch.hit('subject');
	await expect(rejected).rejects.toBeInstanceOf(RedisXLimiterExceededError);
	await expect(rejected).rejects.toMatchObject({
		limiter: unconditional,
		ttl: 60,
	});
	expect(
		await redisXClient.HGET(companion._getRedisKey('subject'), 'subject'),
	).toBeNull();
	expect(
		await redisXClient.HGET(conditional._getRedisKey('subject'), 'subject'),
	).toBe('1');
	expect(
		await redisXClient.HGET(unconditional._getRedisKey('subject'), 'subject'),
	).toBe('1');
	expect(
		await redisXClient.HEXISTS(blockKey, `${conditional.name}:subject`),
	).toBe(true);
	expect(
		await redisXClient.HEXISTS(blockKey, `${unconditional.name}:subject`),
	).toBe(true);
});

test('selects the longest block only within the highest blocked priority in one HIT call', async () => {
	const available = createLimiter({ priority: 1000 });
	const lower = createLimiter({ priority: 10 });
	const short = createLimiter({ priority: 100 });
	const long = createLimiter({ priority: 100 });
	const batch = new RedisXLimitersBatch(available, lower, short, long);
	const execute = vi.spyOn(lower._script, 'executeWithKeys').mockResolvedValue([
		[long.name, 1, 120],
		[short.name, 1, 60],
		[lower.name, 1, 3600],
	]);
	await expect(batch.hit('subject')).rejects.toMatchObject({
		limiter: long,
		ttl: 120,
	});
	expect(execute).toHaveBeenCalledTimes(1);
	expect(execute).toHaveBeenCalledWith(
		[
			blockKey,
			...[available, lower, short, long].map((limiter) =>
				limiter._getRedisKey('subject'),
			),
		],
		SCRIPT_OP.HIT,
		'subject',
		expect.any(String),
		...[available, lower, short, long].flatMap(
			(limiter) => limiter._redis_args,
		),
	);
});

test('equal block priorities and TTLs keep batch order regardless of reply order', async () => {
	const first = createLimiter({ priority: 10 });
	const second = createLimiter({ priority: 10 });
	vi.spyOn(first._script, 'executeWithKeys').mockResolvedValue([
		[second.name, 1, 60],
		[first.name, 1, 60],
	]);
	await expect(
		new RedisXLimitersBatch(first, second).hit('subject'),
	).rejects.toMatchObject({ limiter: first, ttl: 60 });
});

test('equal remaining quotas select the longest known reset and keep its own data', async () => {
	const absent = createLimiter({ priority: 100 });
	const short = createLimiter({ priority: 200 });
	const long = createLimiter({ priority: 1 });
	vi.spyOn(absent._script, 'executeWithKeys').mockResolvedValue([
		[absent.name, 0, 2],
		[long.name, 0, 2, 120],
		[short.name, 0, 2, 60],
	]);
	expect(
		await new RedisXLimitersBatch(absent, short, long).hit('subject'),
	).toEqual({
		name: long.name,
		usage: { remaining: 2, ttl: 120 },
	});
});

test('equal usage quotas and reset times keep batch order regardless of priority', async () => {
	const first = createLimiter({ priority: 1 });
	const second = createLimiter({ priority: 100 });
	vi.spyOn(first._script, 'executeWithKeys').mockResolvedValue([
		[second.name, 0, 2, 60],
		[first.name, 0, 2, 60],
	]);
	expect(await new RedisXLimitersBatch(first, second).hit('subject')).toEqual({
		name: first.name,
		usage: { remaining: 2, ttl: 60 },
	});
});

test.each(['single', 'batch'])(
	'%s hit preserves zero usage and absent TTL and forwards hit ID',
	async (kind) => {
		const limiter = createLimiter({ type: RedisXLimiterType.SlidingWindow });
		const target =
			kind === 'single' ? limiter : new RedisXLimitersBatch(limiter);
		const execute = vi
			.spyOn(limiter._script, 'executeWithKeys')
			.mockResolvedValue([[limiter.name, 0, 0]]);
		expect(await target.hit('subject', 'resource')).toEqual({
			name: limiter.name,
			usage: { remaining: 0, ttl: undefined },
		});
		expect(execute).toHaveBeenCalledWith(
			[blockKey, limiter._getRedisKey('subject')],
			SCRIPT_OP.HIT,
			'subject',
			'resource',
			...limiter._redis_args,
		);
	},
);

test.each(['empty', 'incomplete', 'unknown', 'malformed'])(
	'invalid %s hit responses fail as protocol errors',
	async (kind) => {
		const first = createLimiter();
		const second = createLimiter();
		const replies: Record<string, unknown> = {
			empty: [],
			incomplete: [[first.name, 0, 1, 60]],
			unknown: [['unknown', 1, 60]],
			malformed: [[first.name, 2, 60]],
		};
		vi.spyOn(first._script, 'executeWithKeys').mockResolvedValue(replies[kind]);
		await expect(
			new RedisXLimitersBatch(first, second).hit('subject'),
		).rejects.toBeInstanceOf(ScriptResultError);
	},
);

test.each(['single', 'batch'])(
	'%s hit propagates Redis failures unchanged',
	async (kind) => {
		const limiter = createLimiter();
		const target =
			kind === 'single' ? limiter : new RedisXLimitersBatch(limiter);
		const error = new Error('Redis connection failed');
		vi.spyOn(limiter._script, 'executeWithKeys').mockRejectedValue(error);
		await expect(target.hit('subject')).rejects.toBe(error);
	},
);
