import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import {
	RedisXLimiter,
	RedisXLimitersBatch,
	RedisXLimiterType,
} from '../main.js';
import { SCRIPT_OP } from '../scripts.js';
import { REDIS_PREFIX } from '../utils.js';

const ownedKeys = new Set<string>();
const ownedBlockFields: string[] = [];
const blockKey = `${REDIS_PREFIX}:_block`;
const kinds = ['single', 'batch'];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await redisXClient.DEL([...ownedKeys]);
	await redisXClient.HDEL(blockKey, ownedBlockFields);
});

/** Creates uniquely named limiters on the shared client and tracks their state. */
function createLimiter(type = RedisXLimiterType.FixedWindowUserDefinedStart) {
	const limiter = new RedisXLimiter(redisXClient, {
		type,
		name: randomUUID(),
		limit: 1,
		ttl: 60,
		block_ttl: 120,
	});
	ownedKeys.add(limiter._getRedisKey('subject'));
	ownedBlockFields.push(`${limiter.name}:subject`);
	return limiter;
}

test.each(kinds)(
	'%s check uses current capacity without consuming or blocking',
	async (kind) => {
		const limiter = createLimiter();
		const companion = createLimiter();
		const checker =
			kind === 'single' ? limiter : new RedisXLimitersBatch(companion, limiter);
		expect(await checker.check('subject')).toBe(true);
		expect(
			await redisXClient.HGET(limiter._getRedisKey('subject'), 'subject'),
		).toBeNull();
		await limiter.hit('subject');
		expect(await checker.check('subject')).toBe(false);
		expect(
			await redisXClient.HGET(limiter._getRedisKey('subject'), 'subject'),
		).toBe('1');
		expect(
			await redisXClient.HGET(companion._getRedisKey('subject'), 'subject'),
		).toBeNull();
		expect(
			await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`),
		).toBe(false);
	},
);

test.each(kinds)(
	'%s check rejects an existing block even with unused quota',
	async (kind) => {
		const limiter = createLimiter();
		const checker =
			kind === 'single'
				? limiter
				: new RedisXLimitersBatch(createLimiter(), limiter);
		const field = `${limiter.name}:subject`;
		await redisXClient.HSET(blockKey, field, '');
		await redisXClient.sendCommand(
			'HEXPIRE',
			blockKey,
			120,
			'FIELDS',
			1,
			field,
		);
		expect(await checker.check('subject')).toBe(false);
		expect(
			await redisXClient.HGET(limiter._getRedisKey('subject'), 'subject'),
		).toBeNull();
	},
);

test.each(kinds)(
	'%s check rejects a zero-remaining usage row and forwards the hit ID',
	async (kind) => {
		const limiter = createLimiter(RedisXLimiterType.SlidingWindow);
		const companion = createLimiter();
		const checker =
			kind === 'single' ? limiter : new RedisXLimitersBatch(companion, limiter);
		const rows =
			kind === 'single'
				? [[limiter.name, 0, 0, 60]]
				: [
						[companion.name, 0, 1],
						[limiter.name, 0, 0, 60],
					];
		const execute = vi
			.spyOn(limiter._script, 'executeWithKeys')
			.mockResolvedValue(rows);
		expect(await checker.check('subject', 'resource')).toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			kind === 'single'
				? [blockKey, limiter._getRedisKey('subject')]
				: [
						blockKey,
						companion._getRedisKey('subject'),
						limiter._getRedisKey('subject'),
					],
			SCRIPT_OP.GET,
			'subject',
			'resource',
			...(kind === 'single'
				? limiter._redis_args
				: [...companion._redis_args, ...limiter._redis_args]),
		);
	},
);
