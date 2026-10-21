import type { RedisXClient } from '@redis-x/client';
import { nanoid } from 'nanoid';
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

class ScriptResultError extends Error {
	constructor() {
		super('Script result is not valid.');
	}
}

type UsageState = {
	name: string;
	usage: {
		remaining: number;
		ttl?: number;
	};
};

type BlockState = {
	name: string;
	block: {
		ttl: number;
	};
};

type LimiterState = UsageState | BlockState;

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
): Promise<ReadonlyMap<string, LimiterState>> {
	const result = await redisXScript.executeWithKeys(
		[`${REDIS_PREFIX}:_block`, ...redis_keys],
		op,
		String(key),
		hit_id === undefined ? nanoid(16) : String(hit_id),
		...redis_args,
	);

	if (!Array.isArray(result)) {
		throw new ScriptResultError();
	}

	const states = new Map<string, LimiterState>();
	for (const result_limiter of result) {
		if (!Array.isArray(result_limiter)) {
			throw new ScriptResultError();
		}

		const [limiter_name, status] = result_limiter;
		if (typeof limiter_name !== 'string' || !(status === 0 || status === 1)) {
			throw new ScriptResultError();
		}

		if (status === 0) {
			const remaining = result_limiter[2];
			const ttl = result_limiter[3];
			if (
				typeof remaining !== 'number'
				|| (ttl !== undefined && typeof ttl !== 'number')
			) {
				throw new ScriptResultError();
			}

			states.set(limiter_name, {
				name: limiter_name,
				usage: {
					remaining,
					ttl,
				},
			});
		} else {
			const ttl = result_limiter[2];
			if (typeof ttl !== 'number') {
				throw new ScriptResultError();
			}

			states.set(limiter_name, {
				name: limiter_name,
				block: {
					ttl,
				},
			});
		}
	}

	console.log(states);

	return states;
}

export function check(states: ReadonlyMap<string, LimiterState>) {
	for (const state of states.values()) {
		if ('block' in state || state.usage.remaining <= 0) {
			return false;
		}
	}

	return true;
}
