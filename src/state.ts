import type { RedisXLimiter } from './main.js';
import type { BlockState, UsageState } from './scripts.js';

export type RedisXLimiterBlock = {
	limiter: RedisXLimiter;
	ttl: number;
};
export type RedisXLimiterUsage = {
	limiter: RedisXLimiter;
	remaining: number;
	ttl?: number;
};

/** Finds the longest block among the given limiters. */
export function getLongestBlock(
	limiters: RedisXLimiter[],
	block_states: ReadonlyMap<string, BlockState>,
): RedisXLimiterBlock {
	let limiter_priority = -Infinity;
	let result_limiter: RedisXLimiter | undefined;
	let result_block_state: BlockState | undefined;

	for (const limiter of limiters) {
		const block_state = block_states.get(limiter.name);
		if (!block_state) {
			continue;
		}

		if (
			!result_block_state
			|| limiter.priority > limiter_priority
			|| (limiter.priority === limiter_priority
				&& block_state.ttl > result_block_state.ttl)
		) {
			limiter_priority = limiter.priority;
			result_limiter = limiter;
			result_block_state = block_state;
		}
	}

	if (!result_limiter || !result_block_state) {
		throw new Error(`Internal @redis-x/limiter error.`);
	}

	return {
		limiter: result_limiter,
		ttl: result_block_state.ttl,
	};
}

/** Finds the smallest limit among the given limiters. */
export function getSmallestLimit(
	limiters: RedisXLimiter[],
	usage_states: ReadonlyMap<string, UsageState>,
): RedisXLimiterUsage {
	const [usage_state] = usage_states
		.values()
		.toArray()
		.toSorted((a, b) => {
			if (a.remaining !== b.remaining) {
				return a.remaining - b.remaining;
			}

			return (b.ttl ?? -1) - (a.ttl ?? -1);
		});

	if (!usage_state) {
		throw new Error(`Internal @redis-x/limiter error.`);
	}

	return {
		limiter: limiters.find((limiter) => limiter.name === usage_state.name)!,
		remaining: usage_state.remaining,
		ttl: usage_state.ttl,
	};
}
