export class RedisXLimiterLimitExceededError extends Error {
    key;
    limit_name;
    ttl;
    constructor(key, limit_name, ttl) {
        super(`[RedisXLimiter] Limit for key "${key}" exceeded.`);
        this.key = key;
        this.limit_name = limit_name;
        this.ttl = ttl;
        this.key = key;
        this.limit_name = limit_name;
        this.ttl = ttl;
    }
}
