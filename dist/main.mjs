import { nanoid } from "nanoid";
//#region src/lua/hit.lua
var hit_default = "local function set_block(limiter)\n	if limiter.ttl_block > 0 then\n		redis.call(\"HSET\", key_block, limiter.field_block, \"\")\n		redis.call(\"HEXPIREAT\", key_block, ts + limiter.ttl_block, \"FIELDS\", 1, limiter.field_block)\n\n		table.insert(\n			limiters_blocked,\n			{ limiter.name, limiter.ttl_block }\n		)\n\n		return true\n	end\nend\n\nlocal hit_args = {}\nfor _, limiter in ipairs(limiters) do\n	-- ---------------------------------------------------\n	-- fixed window / fixed window with user defined start\n	-- ---------------------------------------------------\n	if limiter.type == \"0\" or limiter.type == \"1\" then\n		local value = redis.call(\"HGET\", limiter.key, limiting_key)\n		local counter = tonumber(value) or 0\n		-- if counter does not exists yet, set it to 1 and set the ttl\n		if counter == 0 then\n			local ts_expire = 0\n			-- for fixed window, calculate end of the window\n			if limiter.type == \"0\" then\n				ts_expire = (math.floor(ts / limiter.ttl) + 1) * limiter.ttl\n			-- for fixed window with user defined start, start window now\n			else\n				ts_expire = ts + limiter.ttl\n			end\n\n			table.insert(hit_args, {\n				\"HSET\", limiter.key, limiting_key, 1,\n			})\n			table.insert(hit_args, {\n				\"HEXPIREAT\", limiter.key, ts_expire, \"FIELDS\", 1, limiting_key,\n			})\n		elseif counter >= limiter.limit then\n			if set_block(limiter) ~= true then\n				table.insert(limiters_blocked, {\n					limiter.name,\n					redis.call(\"HTTL\", limiter.key, \"FIELDS\", 1, limiting_key)[1]\n				})\n			end\n		else\n			table.insert(hit_args, {\n				\"HINCRBY\", limiter.key, limiting_key, 1,\n			})\n		end\n	else\n		return redis.error_reply(\"UNSUP unsupported limiter type \" .. limiter.type)\n	end\nend\n\nif #limiters_blocked > 0 then\n	return { 1, limiters_blocked }\nend\n\nfor _, args in ipairs(hit_args) do\n	redis.call(unpack(args))\nend\n";
//#endregion
//#region src/lua/prepare.lua
var prepare_default = "local key_block = KEYS[1]\nlocal limiting_key = ARGV[1]\nlocal hit_id = ARGV[2]\n\nlocal limiters = {}\nlocal limiters_block_fields = {}\n-- Each limiter is passed as: type, name, limit, ttl, block.\nfor i = 3, #ARGV, 5 do\n	local name = ARGV[i + 1]\n	local field_block = name .. \":\" .. limiting_key\n	table.insert(limiters, {\n		type = ARGV[i],\n		name = name,\n		key = KEYS[#limiters + 2],\n		field_block = field_block,\n		limit = tonumber(ARGV[i + 2]),\n		ttl = tonumber(ARGV[i + 3]),\n		ttl_block = tonumber(ARGV[i + 4]),\n	})\n	table.insert(limiters_block_fields, field_block)\nend\n\nlocal resp_blocked = redis.call('HTTL', key_block, \"FIELDS\", #limiters_block_fields, unpack(limiters_block_fields))\nlocal limiters_blocked = {}\nfor index, limiter in ipairs(limiters) do\n	local ttl = resp_blocked[index]\n	if ttl > 0 then\n		table.insert(\n			limiters_blocked,\n			{ limiter.name, ttl }\n		)\n	end\nend\n\nif #limiters_blocked > 0 then\n	return { 1, limiters_blocked }\nend\n";
//#endregion
//#region src/lua/time.lua
var time_default = "local ts = tonumber(redis.call('TIME')[1])\n";
//#endregion
//#region src/utils.ts
const REDIS_PREFIX = "@x:limiter";
//#endregion
//#region src/scripts.ts
const SCRIPT_HIT = [
	time_default,
	prepare_default,
	hit_default
].join("\n");
/**
* Hits limiters with the given key. If any of the limiters are exceeded, does nothing.
*/
async function hit(redisClient, key, hit_id, redis_keys, redis_args) {
	const result = await redisClient.sendCommand([
		"EVAL",
		SCRIPT_HIT,
		String(redis_keys.length + 1),
		`${REDIS_PREFIX}:_block`,
		...redis_keys,
		String(key),
		hit_id ?? nanoid(16),
		...redis_args
	]);
	console.log("result", result);
}
//#endregion
//#region src/main.ts
let RedisXLimiterType = /* @__PURE__ */ function(RedisXLimiterType) {
	RedisXLimiterType["FixedWindow"] = "0";
	RedisXLimiterType["FixedWindowUserDefinedStart"] = "1";
	RedisXLimiterType["SlidingWindow"] = "2";
	RedisXLimiterType["SlidingWindowApproximate"] = "3";
	RedisXLimiterType["TokenBucket"] = "4";
	return RedisXLimiterType;
}({});
const inkey_regex = /^[a-z\d](?:[a-z\d._+-]*[a-z\d])?$/iu;
const MAX_TTL_SECONDS = 2147483647;
const LIMITER_NAMES = /* @__PURE__ */ new Set();
var RedisXLimiter = class {
	type;
	name;
	priority = Number.MAX_SAFE_INTEGER;
	/** @internal */
	_redisClient;
	/** @internal */
	_redis_args;
	constructor(redisClient, options) {
		var _options$block_ttl;
		this.type = options.type;
		this.name = options.name;
		if (!inkey_regex.test(this.name)) throw new TypeError("Invalid limiter name.");
		if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new TypeError("Invalid limit: expected a positive safe integer.");
		if (!Number.isSafeInteger(options.ttl) || options.ttl <= 0 || options.ttl > MAX_TTL_SECONDS) throw new TypeError(`Invalid ttl: expected an integer from 1 to ${MAX_TTL_SECONDS} seconds.`);
		if (options.block_ttl !== void 0 && (!Number.isSafeInteger(options.block_ttl) || options.block_ttl <= 0 || options.block_ttl > MAX_TTL_SECONDS)) throw new TypeError(`Invalid block_ttl: expected an integer from 1 to ${MAX_TTL_SECONDS} seconds.`);
		if (LIMITER_NAMES.has(this.name)) throw new TypeError("Duplicate limiter name. You can not reuse the same name for multiple limiters.");
		LIMITER_NAMES.add(this.name);
		if (options.priority !== void 0) this.priority = options.priority;
		this._redisClient = redisClient;
		this._redis_args = [
			options.type,
			options.name,
			options.limit.toString(),
			options.ttl.toString(),
			((_options$block_ttl = options.block_ttl) === null || _options$block_ttl === void 0 ? void 0 : _options$block_ttl.toString()) ?? "-1"
		];
	}
	/** @internal */
	_getRedisKey(key) {
		if (this.type === "2") return `${REDIS_PREFIX}:${this.name}:${key}`;
		return `${REDIS_PREFIX}:${this.name}`;
	}
	async hit(key, hit_id) {
		if (typeof key === "string" && !inkey_regex.test(key)) throw new TypeError("Invalid key.");
		if (this.type !== "2" && hit_id !== void 0) throw new Error("Passing hit_id is only supported for sliding window limiter.");
		await hit(this._redisClient, key, hit_id, [this._getRedisKey(key)], this._redis_args);
	}
};
var RedisXLimitersBatch = class {
	#limiters;
	#redisClient;
	#redis_args = [];
	constructor(...limiters) {
		var _this$limiters$;
		this.#limiters = [...new Set(limiters)];
		const redisClient = (_this$limiters$ = this.#limiters[0]) === null || _this$limiters$ === void 0 ? void 0 : _this$limiters$._redisClient;
		if (redisClient === void 0) throw new TypeError("At least one limiter is required.");
		this.#redisClient = redisClient;
		for (const limiter of this.#limiters) {
			if (limiter._redisClient !== this.#redisClient) throw new Error("All limiters must use the same Redis client.");
			this.#redis_args.push(...limiter._redis_args);
		}
	}
	async hit(key, hit_id) {
		await hit(this.#redisClient, key, hit_id, this.#limiters.map((limiter) => limiter._getRedisKey(key)), this.#redis_args);
	}
};
//#endregion
export { RedisXLimiter, RedisXLimiterType, RedisXLimitersBatch };
