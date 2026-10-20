import { nanoid } from 'nanoid';
import lua_hit from './lua/hit.lua' with { type: 'text' };
import lua_prepare from './lua/prepare.lua' with { type: 'text' };
import lua_time from './lua/time.lua' with { type: 'text' };
import { REDIS_PREFIX, type RedisClient } from './utils.js';

const SCRIPT_HIT = [lua_time, lua_prepare, lua_hit].join('\n');

/**
 * Hits limiters with the given key. If any of the limiters are exceeded, does nothing.
 */
// oxlint-disable-next-line max-params
export async function hit(
	redisClient: RedisClient,
	key: string | number,
	hit_id: string | undefined,
	redis_keys: string[],
	redis_args: string[],
): Promise<void> {
	const result = await redisClient.sendCommand([
		'EVAL',
		SCRIPT_HIT,
		String(redis_keys.length + 1),
		`${REDIS_PREFIX}:_block`,
		...redis_keys,
		String(key),
		hit_id ?? nanoid(16),
		...redis_args,
	]);
	console.log('result', result);
}
