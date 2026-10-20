import { RedisClientType, RedisFunctions, RedisModules, RedisScripts } from "redis";
//#region src/utils.d.ts
type RedisClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
//#endregion
//#region src/main.d.ts
export declare enum RedisXLimiterType {
  FixedWindow = "0",
  FixedWindowUserDefinedStart = "1",
  SlidingWindow = "2",
  SlidingWindowApproximate = "3",
  TokenBucket = "4"
}
export declare class RedisXLimiter {
  #private;
  readonly type: RedisXLimiterType;
  readonly name: string;
  readonly priority: number;
  constructor(redisClient: RedisClient, options: {
    type: RedisXLimiterType;
    name: string;
    priority?: number;
    limit: number;
    ttl: number;
    block_ttl?: number;
  });
  hit(key: string | number, hit_id?: string): Promise<void>;
}
//#endregion
export {};