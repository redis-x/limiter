export class RedisXLimiterLimitExceededError extends Error {
	constructor(
		public key: string | number,
		public limit_name: string,
		public ttl: number,
	) {
		super(`[RedisXLimiter] Limit for key "${key}" exceeded.`);
	}
}
