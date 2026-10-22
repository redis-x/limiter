import { RedisXClient, type RedisXScript } from '@redis-x/client';
import type {
	RedisClientType,
	RedisFunctions,
	RedisModules,
	RedisScripts,
} from 'redis';

export type Script = RedisXScript<string[], unknown>;

export type RedisClient = RedisClientType<
	RedisModules,
	RedisFunctions,
	RedisScripts
>;

export const REDIS_PREFIX = '@x:limiter';

const REDIS_X_CLIENTS = new WeakMap<RedisClient, RedisXClient>();

/** Returns the RedisX client to run commands with, wrapping each `redis` client only once. */
export function getRedisXClient(
	client: RedisClient | RedisXClient,
): RedisXClient {
	// Checked by shape, so a RedisX client from another package copy is not wrapped again.
	if ('createScript' in client) {
		return client;
	}

	let redisXClient = REDIS_X_CLIENTS.get(client);
	if (!redisXClient) {
		redisXClient = new RedisXClient(client);
		REDIS_X_CLIENTS.set(client, redisXClient);
	}

	return redisXClient;
}
