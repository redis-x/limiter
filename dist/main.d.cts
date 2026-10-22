import { RedisXClient } from "@redis-x/client";
//#region src/scripts.d.ts
type UsageState = {
  name: string;
  remaining: number;
  ttl?: number;
  /**
   * False only for an active repeated sliding-window hit ID before this operation.
   * True for every hit in other limiter types and new or expired sliding-window IDs.
   */
  is_hit_unique: boolean;
};
//#endregion
//#region src/state.d.ts
type RedisXLimiterBlock = {
  limiter: RedisXLimiter;
  ttl: number;
};
type RedisXLimiterUsage = {
  limiter: RedisXLimiter;
  remaining: number;
  ttl?: number;
  /**
   * False only for an active repeated sliding-window hit ID before this operation.
   * True for every hit in other limiter types and new or expired sliding-window IDs.
   */
  is_hit_unique: boolean;
};
//#endregion
//#region src/main.d.ts
export declare enum RedisXLimiterType {
  FixedWindow = "0",
  FixedWindowUserDefinedStart = "1",
  SlidingWindow = "2",
  SlidingWindowApproximate = "3",
  TokenBucket = "4"
}
export declare class RedisXLimiterExceededError extends Error {
  readonly limiter: RedisXLimiter;
  readonly ttl: number;
  override readonly name = "RedisXLimiterExceededError";
  constructor(limiter: RedisXLimiter, ttl: number);
}
export declare class RedisXLimiter {
  #private;
  readonly type: RedisXLimiterType;
  readonly name: string;
  readonly priority: number;
  constructor(redisXClient: RedisXClient, options: {
    /** Limiter type. Check {@link RedisXLimiterType}. */
    type: RedisXLimiterType;
    /**
     * Limiter name. Must be unique for current process.
     *
     * Can contain only letters, digits or `._+-`.
     *
     * Can only start and end with a letter or digit.
     */
    name: string;
    /** Limiter priority to return most important limit first when multiple limiters blocked. */
    priority?: number;
    /** Maximum number of hits allowed within the TTL; for token bucket, the number of tokens in the bucket. */
    limit: number;
    /** Limiter window in **seconds**; for token bucket, the total time for bucket replenishment from empty to full. */
    ttl: number;
    /** Time in **seconds** to block the limiter after exceeding the limit. Only hit **exceeding the limit** will put limiter in block state. */
    block_ttl?: number;
  });
  check(key: string | number, hit_id?: string | number): Promise<boolean>;
  get(key: string | number): Promise<RedisXLimiterBlock | RedisXLimiterUsage>;
  hit(key: string | number, hit_id?: string | number): Promise<RedisXLimiterUsage>;
}
export declare class RedisXLimitersBatch {
  #private;
  constructor(...limiters: RedisXLimiter[]);
  check(key: string | number, hit_id?: string | number): Promise<boolean>;
  get(key: string | number): Promise<RedisXLimiterBlock | RedisXLimiterUsage>;
  getAll(key: string | number): Promise<(RedisXLimiterBlock | RedisXLimiterUsage)[]>;
  hit(key: string | number, hit_id?: string | number): Promise<RedisXLimiterUsage>;
}
//#endregion
export type { UsageState };