export declare class RedisXLimiterLimitExceededError extends Error {
    key: string | number;
    limit_name: string;
    ttl: number;
    constructor(key: string | number, limit_name: string, ttl: number);
}
