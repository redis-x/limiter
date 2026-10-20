import type {
	RedisClientType,
	RedisFunctions,
	RedisModules,
	RedisScripts,
} from 'redis';

export type RedisClient = RedisClientType<
	RedisModules,
	RedisFunctions,
	RedisScripts
>;

export const REDIS_PREFIX = '@x:limiter';
