
export class RedisXLimiterLimitExceededError extends Error {
	/** @type {string | number} */
	key;
	/** @type {string} */
	limit_name;
	/** @type {number} */
	ttl;

	/**
	 * @param {string | number} key -
	 * @param {string} limit_name -
	 * @param {number} ttl -
	 */
	constructor(key, limit_name, ttl) {
		super(`[RedisXLimiter] Limit for key "${key}" exceeded.`);

		this.key = key;
		this.limit_name = limit_name;
		this.ttl = ttl;
	}
}
