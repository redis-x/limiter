import type { RedisXClient } from '@redis-x/client';
import { nanoid } from 'nanoid';
import lua_hit from './lua/hit.lua' with { type: 'text' };
import lua_prepare from './lua/prepare.lua' with { type: 'text' };
import lua_time from './lua/time.lua' with { type: 'text' };
import { REDIS_PREFIX, type Script } from './utils.js';

// const SCRIPT_GET = [lua_time, lua_prepare].join('\n');
const SCRIPT_HIT = [lua_time, lua_prepare, lua_hit].join('\n');

export type RedisXLimiterScripts = {
	// get: Script;
	hit: Script;
};
const SCRIPTS = new WeakMap<RedisXClient, RedisXLimiterScripts>();

/** Creates scripts on RedisX client. */
export function createScripts(
	redisXClient: RedisXClient,
): RedisXLimiterScripts {
	let scripts = SCRIPTS.get(redisXClient);
	if (!scripts) {
		scripts = {
			// get: redisXClient.createScript(SCRIPT_CHECK),
			hit: redisXClient.createScript(SCRIPT_HIT),
		};
		SCRIPTS.set(redisXClient, scripts);
	}

	return scripts;
}

/**
 * Hits limiters with the given key. If any of the limiters are exceeded, does nothing.
 */
// oxlint-disable-next-line max-params
export async function hit(
	redisXScript: Script,
	key: string | number,
	hit_id: string | undefined,
	redis_keys: string[],
	redis_args: string[],
): Promise<void> {
	const result = await redisXScript.executeWithKeys(
		[`${REDIS_PREFIX}:_block`, ...redis_keys],
		String(key),
		hit_id ?? nanoid(16),
		...redis_args,
	);
	console.log('result', result);
}
