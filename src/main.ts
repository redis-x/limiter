import type { RedisXClient } from '@redis-x/client';
import { check, createScript, runScript, SCRIPT_OP } from './scripts.js';
import {
	getLongestBlock,
	getSmallestLimit,
	type RedisXLimiterBlock,
	type RedisXLimiterUsage,
} from './state.js';
import { REDIS_PREFIX, type Script } from './utils.js';

export type { UsageState } from './scripts.js';

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

export class RedisXLimiterExceededError extends Error {
	override readonly name = 'RedisXLimiterExceededError';

	constructor(
		readonly limiter: RedisXLimiter,
		readonly ttl: number,
	) {
		super('Limit exceeded.');
	}
}

export class RedisXLimiter {
	readonly type: RedisXLimiterType;
	readonly name: string;
	readonly priority: number = Number.MAX_SAFE_INTEGER;
	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_script: Script;
	/** @internal */
	// eslint-disable-next-line unicorn/prefer-private-class-fields
	_redis_args: string[];

	constructor(
		redisXClient: RedisXClient,
		options: {
			/** Limiter type. Check {@link RedisXLimiterType}. */
			type: RedisXLimiterType;
			/**
			 * Limiter name. Must be unique for current process.
			 *
			 * Can contain only letters, digits or `._+-`.
			 *
			 * Can only start and end with a letter or digit.
			 */
			name: string;
			/** Limiter priority to return most important limit first when multiple limiters blocked. */
			priority?: number;
			/** Maximum number of hits allowed within the TTL; for token bucket, the number of tokens in the bucket. */
			limit: number;
			/** Limiter window in **seconds**; for token bucket, the total time for bucket replenishment from empty to full. */
			ttl: number;
			/** Time in **seconds** to block the limiter after exceeding the limit. Only hit **exceeding the limit** will put limiter in block state. */
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
				`Invalid ttl: expected a positive integer up to ${MAX_TTL_SECONDS}.`,
			);
		}

		if (
			options.block_ttl !== undefined
			&& (!Number.isSafeInteger(options.block_ttl)
				|| options.block_ttl <= 0
				|| options.block_ttl > MAX_TTL_SECONDS)
		) {
			throw new TypeError(
				`Invalid block_ttl: expected a positive integer up to ${MAX_TTL_SECONDS}.`,
			);
		}

		if (LIMITER_NAMES.has(this.name)) {
			throw new TypeError(
				'Duplicate limiter name. You can not reuse the same name for multiple limiters to avoid conflicts.',
			);
		}

		LIMITER_NAMES.add(this.name);

		if (options.priority !== undefined) {
			this.priority = options.priority;
		}

		this._script = createScript(redisXClient);

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

	#runScript(op: SCRIPT_OP, key: string | number, hit_id?: string | number) {
		return runScript(
			this._script,
			op,
			key,
			hit_id,
			[this._getRedisKey(key)],
			this._redis_args,
		);
	}

	async check(
		key: string | number,
		hit_id?: string | number,
	): Promise<boolean> {
		return check(await this.#runScript(SCRIPT_OP.GET, key, hit_id));
	}

	async get(
		key: string | number,
		hit_id?: string | number,
	): Promise<RedisXLimiterBlock | RedisXLimiterUsage> {
		const state = await this.#runScript(SCRIPT_OP.GET, key, hit_id);
		if (state.block.size > 0) {
			return {
				limiter: this,
				ttl: state.block.get(this.name)!.ttl,
			};
		}

		const { remaining, ttl } = state.usage.get(this.name)!;
		return {
			limiter: this,
			remaining,
			ttl,
		};
	}

	async hit(
		key: string | number,
		hit_id?: string | number,
	): Promise<RedisXLimiterUsage> {
		if (typeof key === 'string' && !inkey_regex.test(key)) {
			throw new TypeError('Invalid key.');
		}

		if (this.type !== RedisXLimiterType.SlidingWindow && hit_id !== undefined) {
			throw new Error(
				'Passing hit_id is only supported for sliding window limiter.',
			);
		}

		const state = await this.#runScript(SCRIPT_OP.HIT, key, hit_id);
		if (state.block.size > 0) {
			throw new RedisXLimiterExceededError(
				this,
				state.block.get(this.name)!.ttl,
			);
		}

		const { remaining, ttl } = state.usage.get(this.name)!;
		return {
			limiter: this,
			remaining,
			ttl,
		};
	}
}

export class RedisXLimitersBatch {
	#limiters: RedisXLimiter[];
	#script: Script;
	#redis_args: string[] = [];

	constructor(...limiters: RedisXLimiter[]) {
		this.#limiters = [...new Set(limiters)];

		const script = this.#limiters[0]?._script;
		if (script === undefined) {
			throw new TypeError('At least one limiter is required.');
		}

		this.#script = script;

		for (const limiter of this.#limiters) {
			if (limiter._script !== this.#script) {
				throw new Error('All limiters must use the same Redis client.');
			}

			this.#redis_args.push(...limiter._redis_args);
		}
	}

	#runScript(op: SCRIPT_OP, key: string | number, hit_id?: string | number) {
		return runScript(
			this.#script,
			op,
			key,
			hit_id,
			this.#limiters.map((limiter) => limiter._getRedisKey(key)),
			this.#redis_args,
		);
	}

	async check(
		key: string | number,
		hit_id?: string | number,
	): Promise<boolean> {
		return check(await this.#runScript(SCRIPT_OP.GET, key, hit_id));
	}

	async get(
		key: string | number,
		hit_id?: string | number,
	): Promise<RedisXLimiterBlock | RedisXLimiterUsage> {
		const state = await this.#runScript(SCRIPT_OP.GET, key, hit_id);
		if (state.block.size > 0) {
			return getLongestBlock(this.#limiters, state.block);
		}

		return getSmallestLimit(this.#limiters, state.usage);
	}

	async getAll(
		key: string | number,
		hit_id?: string | number,
	): Promise<(RedisXLimiterBlock | RedisXLimiterUsage)[]> {
		const state = await this.#runScript(SCRIPT_OP.GET, key, hit_id);
		const result: (RedisXLimiterBlock | RedisXLimiterUsage)[] = [];
		for (const limiter of this.#limiters) {
			if (state.block.has(limiter.name)) {
				const { ttl } = state.block.get(limiter.name)!;
				result.push({ limiter, ttl });
			}

			if (state.usage.has(limiter.name)) {
				const { remaining, ttl } = state.usage.get(limiter.name)!;
				result.push({ limiter, remaining, ttl });
			}
		}

		return result;
	}

	async hit(
		key: string | number,
		hit_id?: string | number,
	): Promise<RedisXLimiterUsage> {
		const state = await this.#runScript(SCRIPT_OP.HIT, key, hit_id);
		if (state.block.size > 0) {
			const { limiter, ttl } = getLongestBlock(this.#limiters, state.block);
			throw new RedisXLimiterExceededError(limiter, ttl);
		}

		return getSmallestLimit(this.#limiters, state.usage);
	}
}
