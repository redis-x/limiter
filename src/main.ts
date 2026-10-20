import { hit } from './scripts.js';
import { REDIS_PREFIX, type RedisClient } from './utils.js';

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

export class RedisXLimiter {
	readonly type: RedisXLimiterType;
	readonly name: string;
	readonly priority: number = Number.MAX_SAFE_INTEGER;
	#redisClient: RedisClient;
	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_redis_args: string[];

	constructor(
		redisClient: RedisClient,
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

		if (options.priority !== undefined) {
			this.priority = options.priority;
		}

		this.#redisClient = redisClient;

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
			this.#redisClient,
			key,
			hit_id,
			[this._getRedisKey(key)],
			this._redis_args,
		);
	}
}

// export class RedisXLimitersBatch {
// 	#redis_args: string[];
//
// 	constructor(...limiters: RedisXLimiter[]) {
// 		this.#redis_args = limiters.flatMap((limiter) => limiter._redis_args);
// 	}
//
// 	hit(key: string, hit_id?: string): void {
// 		//
// 	}
// }
