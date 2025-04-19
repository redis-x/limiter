import type { RedisClientType, RedisModules, RedisFunctions, RedisScripts } from 'redis';
type RedisClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
export type LimitDefinition = {
    type: 'counter' | 'set';
    limit: number;
    ttl: number;
    ttl_block?: number;
    onError?: (ttl: number) => Error | void;
};
type GetReturns = Record<string, {
    counter: 0;
} | {
    ttl: number;
} | {
    counter: number;
    ttl: number;
}>;
export declare class RedisXLimiter<const L extends Record<string, LimitDefinition>> {
    private redisClient;
    private namespace;
    private uses_set;
    private limit_names;
    private redis_args;
    private error_handlers;
    /**
     * @param client Redis client.
     * @param options Options.
     * @param options.namespace Namespace of the limiter.
     * @param options.limits Limits.
     */
    constructor(client: RedisClient, options: {
        namespace: string;
        limits: L;
    });
    private getRedisKeys;
    /**
     * Creates an error.
     * @param key Limit key.
     * @param limit_name Limit name.
     * @param ttl Time-to-live.
     */
    private createError;
    /**
     * Hits the limiter.
     * @param key Limiter key to hit.
     * @param elements Elements to use instead of plain counters.
     */
    hit(key: string | number, ...elements: string[]): Promise<void>;
    /**
     * Gets the limiter.
     * @param key Limiter key to get.
     * @returns -
     */
    get(key: string | number): Promise<GetReturns>;
    /**
     * Checks if the key is within the limits.
     * @param key Limiter key to check.
     */
    check(key: string | number): Promise<void>;
    /**
     * Resets the limiter.
     * @param key Limiter key to reset.
     * @param limit_names Limit name.
     */
    reset(key: string | number, ...limit_names: [
        string & keyof L,
        ...(string & keyof L)[]
    ]): Promise<void>;
    /**
     * Resets all limits for the key.
     * @param key Limiter key to reset.
     */
    resetAll(key: string | number): Promise<void>;
}
export {};
