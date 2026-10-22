import { randomBytes } from 'node:crypto';
import type { RedisXClient } from '@redis-x/client';
import lua_script from './script.lua' with { type: 'text' };
import { REDIS_PREFIX, type Script } from './utils.js';

const SCRIPTS = new WeakMap<RedisXClient, Script>();
export enum SCRIPT_OP {
	GET = '1',
	HIT = '2',
}

/** Creates scripts on RedisX client. */
export function createScript(redisXClient: RedisXClient): Script {
	let script = SCRIPTS.get(redisXClient);
	if (!script) {
		script = redisXClient.createScript(lua_script);
		SCRIPTS.set(redisXClient, script);
	}

	return script;
}

export class ScriptResultError extends Error {
	constructor() {
		super('Script result is not valid.');
	}
}

export type UsageState = {
	name: string;
	remaining: number;
	ttl?: number;
	/**
	 * False only for an active repeated sliding-window hit ID before this operation.
	 * True for every hit in other limiter types and new or expired sliding-window IDs.
	 */
	is_hit_unique: boolean;
};
export type BlockState = {
	name: string;
	ttl: number;
};
export type State = {
	block: ReadonlyMap<string, BlockState>;
	usage: ReadonlyMap<string, UsageState>;
};

/**
 * Reads or hits limiters. Rejected hits may create blocks but never consume usage.
 */
// oxlint-disable-next-line max-params
export async function runScript(
	redisXScript: Script,
	op: SCRIPT_OP,
	key: string | number,
	hit_id: string | number | undefined,
	redis_keys: string[],
	redis_args: string[],
): Promise<State> {
	const result = await redisXScript.executeWithKeys(
		[`${REDIS_PREFIX}:_block`, ...redis_keys],
		op,
		String(key),
		hit_id === undefined
			? randomBytes(12).toString('base64url')
			: String(hit_id),
		...redis_args,
	);

	if (!Array.isArray(result)) {
		throw new ScriptResultError();
	}

	const [result_block, result_usage] = result;
	if (!Array.isArray(result_block) || !Array.isArray(result_usage)) {
		throw new ScriptResultError();
	}

	const block = new Map<string, BlockState>();
	for (const result_limiter of result_block) {
		if (!Array.isArray(result_limiter)) {
			throw new ScriptResultError();
		}

		const [limiter_name, ttl] = result_limiter;
		if (typeof limiter_name !== 'string' || typeof ttl !== 'number') {
			throw new ScriptResultError();
		}

		block.set(limiter_name, {
			name: limiter_name,
			ttl,
		});
	}

	const usage = new Map<string, UsageState>();
	for (const result_limiter of result_usage) {
		if (!Array.isArray(result_limiter)) {
			throw new ScriptResultError();
		}

		const [limiter_name, remaining, ttl, is_hit_unique] = result_limiter;
		if (
			typeof limiter_name !== 'string'
			|| typeof remaining !== 'number'
			|| typeof ttl !== 'number'
			|| (is_hit_unique !== undefined
				&& is_hit_unique !== 0
				&& is_hit_unique !== 1)
		) {
			throw new ScriptResultError();
		}

		usage.set(limiter_name, {
			name: limiter_name,
			remaining,
			ttl: ttl === -1 ? undefined : ttl,
			is_hit_unique: is_hit_unique !== 0,
		});
	}

	return {
		block,
		usage,
	};
}

/** Requires every limiter to allow the hit, including active repeated IDs. */
// eslint-disable-next-line unicorn/consistent-boolean-name -- Matches the public check methods.
export function check(state: State): boolean {
	return (
		state.block.size === 0
		&& state.usage
			.values()
			.every(({ remaining, is_hit_unique }) => remaining > 0 || !is_hit_unique)
	);
}
