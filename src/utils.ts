import type { RedisXScript } from '@redis-x/client';

export type Script = RedisXScript<string[], unknown>;

export const REDIS_PREFIX = '@x:limiter';
