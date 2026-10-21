import type { RedisXClient, RedisXScript } from '@redis-x/client';
import { createScripts, hit, type RedisXLimiterScripts } from './scripts.js';
import { REDIS_PREFIX } from './utils.js';

export enum RedisXLimiterType {
	FixedWindow = '0',
	FixedWindowUserDefinedStart = '1',
	SlidingWindow = '2',
	SlidingWindowApproximate = '3',
	TokenBucket = '4',
}

const inkey_regex = /^[a-z\d](?:[a-z\d._+-]*[a-z\d])?$/iu;
// Bound durations so calculated deadlines stay within Redis hash-field expiration limits.
const MAX_TTL_SECONDS = 2_147_483_647;
const LIMITER_NAMES = new Set<string>();

export class RedisXLimiter {
	readonly type: RedisXLimiterType;
	readonly name: string;
	readonly priority: number = Number.MAX_SAFE_INTEGER;
	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_scripts: RedisXLimiterScripts;
	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_redis_args: string[];

	constructor(
		redisXClient: RedisXClient,
		options: {
			type: RedisXLimiterType;
			name: string;
			priority?: number;
			limit: number;
			ttl: number;
			block_ttl?: number;
		},
	) {
		this.type = options.type;

		this.name = options.name;
		if (!inkey_regex.test(this.name)) {
			throw new TypeError('Invalid limiter name.');
		}

		if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
			throw new TypeError('Invalid limit: expected a positive safe integer.');
		}

		if (
			!Number.isSafeInteger(options.ttl)
			|| options.ttl <= 0
			|| options.ttl > MAX_TTL_SECONDS
		) {
			throw new TypeError(
				`Invalid ttl: expected an integer from 1 to ${MAX_TTL_SECONDS} seconds.`,
			);
		}

		if (
			options.block_ttl !== undefined
			&& (!Number.isSafeInteger(options.block_ttl)
				|| options.block_ttl <= 0
				|| options.block_ttl > MAX_TTL_SECONDS)
		) {
			throw new TypeError(
				`Invalid block_ttl: expected an integer from 1 to ${MAX_TTL_SECONDS} seconds.`,
			);
		}

		if (LIMITER_NAMES.has(this.name)) {
			throw new TypeError(
				'Duplicate limiter name. You can not reuse the same name for multiple limiters.',
			);
		}

		LIMITER_NAMES.add(this.name);

		if (options.priority !== undefined) {
			this.priority = options.priority;
		}

		this._scripts = createScripts(redisXClient);

		this._redis_args = [
			options.type,
			options.name,
			options.limit.toString(),
			options.ttl.toString(),
			options.block_ttl?.toString() ?? '-1',
		];
	}

	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_getRedisKey(key: string | number): string {
		if (this.type === RedisXLimiterType.SlidingWindow) {
			return `${REDIS_PREFIX}:${this.name}:${key}`;
		}

		return `${REDIS_PREFIX}:${this.name}`;
	}

	async hit(key: string | number, hit_id?: string): Promise<void> {
		if (typeof key === 'string' && !inkey_regex.test(key)) {
			throw new TypeError('Invalid key.');
		}

		if (this.type !== RedisXLimiterType.SlidingWindow && hit_id !== undefined) {
			throw new Error(
				'Passing hit_id is only supported for sliding window limiter.',
			);
		}

		await hit(
			this._scripts.hit,
			key,
			hit_id,
			[this._getRedisKey(key)],
			this._redis_args,
		);
	}
}

export class RedisXLimitersBatch {
	#limiters: RedisXLimiter[];
	#scripts: RedisXLimiterScripts;
	#redis_args: string[] = [];

	constructor(...limiters: RedisXLimiter[]) {
		this.#limiters = [...new Set(limiters)];

		const scripts = this.#limiters[0]?._scripts;
		if (scripts === undefined) {
			throw new TypeError('At least one limiter is required.');
		}

		this.#scripts = scripts;

		for (const limiter of this.#limiters) {
			if (limiter._scripts !== this.#scripts) {
				throw new Error('All limiters must use the same Redis client.');
			}

			this.#redis_args.push(...limiter._redis_args);
		}
	}

	async hit(key: string, hit_id?: string): Promise<void> {
		await hit(
			this.#scripts.hit,
			key,
			hit_id,
			this.#limiters.map((limiter) => limiter._getRedisKey(key)),
			this.#redis_args,
		);
	}
}
