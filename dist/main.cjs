Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let node_crypto = require("node:crypto");
//#region src/script.lua
var script_default = "local ts = tonumber(redis.call('TIME')[1])\n\n-- 1=get, 2=hit\nlocal op = tonumber(ARGV[1])\nlocal key_block = KEYS[1]\nlocal limiting_key = ARGV[2]\nlocal hit_id = ARGV[3]\n\nlocal limiters = {}\nlocal limiters_block_fields = {}\nfor i = 4, #ARGV, 5 do\n	local name = ARGV[i + 1]\n	local field_block = name .. \":\" .. limiting_key\n	table.insert(limiters, {\n		type = ARGV[i],\n		name = name,\n		key = KEYS[#limiters + 2],\n		field_block = field_block,\n		limit = tonumber(ARGV[i + 2]),\n		ttl = tonumber(ARGV[i + 3]),\n		ttl_block = tonumber(ARGV[i + 4]),\n	})\n	table.insert(limiters_block_fields, field_block)\nend\n\nlocal resp_blocked = redis.call('HTTL', key_block, \"FIELDS\", #limiters_block_fields, unpack(limiters_block_fields))\nlocal result_blocks = {}\nlocal result_usage = {}\nlocal result_names = {}\nlocal function save_result(type, value)\n	local limiter_name = value[1]\n	if result_names[limiter_name] == nil then\n		if type == 0 then\n			table.insert(result_usage, value)\n		elseif type == 1 then\n			table.insert(result_blocks, value)\n		end\n		result_names[limiter_name] = true\n	end\nend\nfor index, limiter in ipairs(limiters) do\n	local ttl = resp_blocked[index]\n	if ttl > 0 then\n		save_result(1, { limiter.name, ttl })\n	end\nend\n\nlocal function get_epoch(size)\n	return math.floor(ts / size)\nend\nlocal function get_epoch_ts_end(epoch, size)\n	return (epoch + 1) * size\nend\n\nlocal hit_args = {}\nlocal function set_block(limiter)\n	if op == 2 and limiter.ttl_block > 0 then\n		-- Blocks persist even when the batch discards all queued usage changes.\n		redis.call(\"HSET\", key_block, limiter.field_block, \"\")\n		redis.call(\"HEXPIREAT\", key_block, ts + limiter.ttl_block, \"FIELDS\", 1, limiter.field_block)\n		save_result(1, { limiter.name, limiter.ttl_block })\n	end\nend\n\nfor _, limiter in ipairs(limiters) do\n	-- Skip iterating limiters that already blocked\n	if result_names[limiter.name] ~= nil then\n	-- ---------------------------------------------------\n	-- fixed window / fixed window with user defined start\n	-- ---------------------------------------------------\n	elseif limiter.type == \"0\" or limiter.type == \"1\" then\n		local value = redis.call(\"HGET\", limiter.key, limiting_key)\n		local counter = tonumber(value) or 0\n		-- Capture exhaustion before a hit can consume the last available slot.\n		local is_exhausted = counter >= limiter.limit\n		-- No active window means there is no scheduled usage change.\n		local ts_expire = nil\n		if counter > 0 then\n			ts_expire = redis.call(\"HEXPIRETIME\", limiter.key, \"FIELDS\", 1, limiting_key)[1]\n		elseif limiter.type == \"0\" then\n			ts_expire = get_epoch_ts_end(get_epoch(limiter.ttl), limiter.ttl)\n		end\n\n		if op == 2 then\n			if is_exhausted then\n				set_block(limiter)\n			else\n				if counter == 0 then\n					if limiter.type == \"1\" then\n						ts_expire = ts + limiter.ttl\n					end\n\n					table.insert(hit_args, {\n						\"HSET\", limiter.key, limiting_key, 1,\n					})\n					table.insert(hit_args, {\n						\"HEXPIREAT\", limiter.key, ts_expire, \"FIELDS\", 1, limiting_key,\n					})\n				else\n					table.insert(hit_args, {\n						\"HINCRBY\", limiter.key, limiting_key, 1,\n					})\n				end\n				counter = counter + 1\n			end\n		end\n\n		-- Fixed-window quota fully resets at its deadline. Exhaustion recovers\n		-- then too; a separately stored block retains its own expiration.\n		local ttl_reset = -1\n		if ts_expire ~= nil then\n			ttl_reset = ts_expire - ts\n		end\n		if is_exhausted then\n			save_result(1, { limiter.name, ttl_reset })\n		else\n			save_result(0, {\n				limiter.name,\n				math.max(0, limiter.limit - counter),\n				ttl_reset,\n			})\n		end\n	-- ---------------------------------------------------\n	-- sliding window\n	-- ---------------------------------------------------\n	elseif limiter.type == \"2\" then\n		-- Reads ignore expired members without changing the sorted set.\n		local active_min = \"(\" .. ts\n		local counter = redis.call(\"ZCOUNT\", limiter.key, active_min, \"+inf\")\n		local score = tonumber(redis.call(\"ZSCORE\", limiter.key, hit_id))\n		local is_unique = score == nil or score <= ts\n		if is_unique and counter >= limiter.limit then\n			set_block(limiter)\n			-- Wait until enough members expire to admit one new distinct ID.\n			local next_score = redis.call(\"ZRANGE\", limiter.key, active_min, \"+inf\", \"BYSCORE\", \"LIMIT\", counter - limiter.limit, 1, \"WITHSCORES\")[2]\n			save_result(1, { limiter.name, tonumber(next_score) - ts })\n		else\n			local ts_expire = ts\n			if counter > 0 then\n				ts_expire = tonumber(redis.call(\"ZRANGE\", limiter.key, -1, -1, \"WITHSCORES\")[2])\n			end\n			if op == 2 then\n				local hit_expire = ts + limiter.ttl\n				ts_expire = math.max(ts_expire, hit_expire)\n				-- Cleanup, insertion, and refresh commit only when every limiter accepts.\n				table.insert(hit_args, {\n					\"ZREMRANGEBYSCORE\", limiter.key, \"-inf\", ts,\n				})\n				table.insert(hit_args, {\n					\"ZADD\", limiter.key, hit_expire, hit_id,\n				})\n				table.insert(hit_args, {\n					\"EXPIREAT\", limiter.key, ts_expire,\n				})\n				if is_unique then\n					counter = counter + 1\n				end\n			end\n			-- Full recovery uses the latest deadline; a repeat costs no new slot.\n			save_result(0, {\n				limiter.name,\n				math.max(0, limiter.limit - counter),\n				ts_expire - ts,\n				is_unique and 1 or 0,\n			})\n		end\n	-- ---------------------------------------------------\n	-- sliding window with approximation\n	-- ---------------------------------------------------\n	elseif limiter.type == \"3\" then\n		local epoch = get_epoch(limiter.ttl)\n		local ttl_remaining = limiter.ttl - (ts % limiter.ttl)\n		local field_previous = epoch - 1 .. \":\" .. limiting_key\n		local field_current = epoch .. \":\" .. limiting_key\n		local resp = redis.call(\"HMGET\", limiter.key, field_previous, field_current)\n		local counter_previous = tonumber(resp[1]) or 0\n		local counter_current = tonumber(resp[2]) or 0\n		local counter = counter_previous * ttl_remaining / limiter.ttl + counter_current\n		if counter + 1 > limiter.limit then\n			set_block(limiter)\n			local ttl_retry\n			if counter_current < limiter.limit then\n				-- Previous usage decays enough before this window ends.\n				local capacity_previous = limiter.limit - counter_current - 1\n				ttl_retry = math.ceil(\n					(counter_previous * ttl_remaining - capacity_previous * limiter.ttl) / counter_previous\n				)\n			else\n				-- Current usage can only decay after becoming the previous window.\n				ttl_retry = ttl_remaining + math.ceil(\n					(counter_current - limiter.limit + 1) * limiter.ttl / counter_current\n				)\n			end\n			save_result(1, { limiter.name, ttl_retry })\n		else\n			if op == 2 then\n				if counter_current == 0 then\n					table.insert(hit_args, {\n						\"HSET\", limiter.key, field_current, 1,\n					})\n					table.insert(hit_args, {\n						\"HEXPIREAT\", limiter.key, get_epoch_ts_end(epoch + 1, limiter.ttl), \"FIELDS\", 1, field_current,\n					})\n				else\n					table.insert(hit_args, {\n						\"HINCRBY\", limiter.key, field_current, 1,\n					})\n				end\n				counter_current = counter_current + 1\n				counter = counter + 1\n			end\n			-- Usage reports full recovery, not the next available whole hit.\n			local ttl_reset = 0\n			if counter_current > 0 then\n				ttl_reset = ttl_remaining + limiter.ttl\n			elseif counter_previous > 0 then\n				ttl_reset = ttl_remaining\n			end\n			save_result(0, {\n				limiter.name,\n				math.max(0, math.floor(limiter.limit - counter)),\n				ttl_reset,\n			})\n		end\n	-- ---------------------------------------------------\n	-- token bucket\n	-- ---------------------------------------------------\n	elseif limiter.type == \"4\" then\n		local value = redis.call(\"HGET\", limiter.key, limiting_key)\n		local counter = tonumber(value) or 0\n		local ts_anchor = ts\n		local ts_expire = ts\n		if counter > 0 then\n			ts_expire = redis.call(\"HEXPIRETIME\", limiter.key, \"FIELDS\", 1, limiting_key)[1]\n			if ts_expire > ts then\n				ts_anchor = ts_expire - math.ceil(counter * limiter.ttl / limiter.limit)\n			else\n				counter = 0\n				ts_expire = ts\n			end\n		end\n\n		-- Rebase by one capacity without changing the represented refill progress.\n		if counter == limiter.limit then\n			counter = 0\n			ts_anchor = ts_anchor + limiter.ttl\n		end\n		local remaining = limiter.limit - counter + math.floor((ts - ts_anchor) * limiter.limit / limiter.ttl)\n		counter = counter + 1\n		-- Round the cumulative duration, not each individual token's refill time.\n		local ts_next = ts_anchor + math.ceil(counter * limiter.ttl / limiter.limit)\n		local ttl_retry = ts_next - ts - limiter.ttl\n		if ttl_retry > 0 then\n			set_block(limiter)\n			save_result(1, { limiter.name, ttl_retry })\n		else\n			if op == 2 then\n				table.insert(hit_args, {\n					\"HSET\", limiter.key, limiting_key, string.format(\"%.0f\", counter),\n				})\n				table.insert(hit_args, {\n					\"HEXPIREAT\", limiter.key, ts_next, \"FIELDS\", 1, limiting_key,\n				})\n				remaining = remaining - 1\n				ts_expire = ts_next\n			end\n			-- Usage returns full refill; exhaustion above returns the next whole token.\n			save_result(0, {\n				limiter.name,\n				math.max(0, math.min(limiter.limit, remaining)),\n				ts_expire - ts,\n			})\n		end\n	else\n		return redis.error_reply(\"UNSUP unsupported limiter type \" .. limiter.type)\n	end\nend\n\nif op == 2 then\n	if #result_blocks > 0 then\n		return { result_blocks, {} }\n	end\n	for _, args in ipairs(hit_args) do\n		redis.call(unpack(args))\n	end\n	return { {}, result_usage }\nend\n\nreturn { result_blocks, result_usage }\n";
//#endregion
//#region src/utils.ts
const REDIS_PREFIX = "@x:limiter";
//#endregion
//#region src/scripts.ts
const SCRIPTS = /* @__PURE__ */ new WeakMap();
/** Creates scripts on RedisX client. */
function createScript(redisXClient) {
	let script = SCRIPTS.get(redisXClient);
	if (!script) {
		script = redisXClient.createScript(script_default);
		SCRIPTS.set(redisXClient, script);
	}
	return script;
}
var ScriptResultError = class extends Error {
	constructor() {
		super("Script result is not valid.");
	}
};
/**
* Reads or hits limiters. Rejected hits may create blocks but never consume usage.
*/
async function runScript(redisXScript, op, key, hit_id, redis_keys, redis_args) {
	const result = await redisXScript.executeWithKeys([`${REDIS_PREFIX}:_block`, ...redis_keys], op, String(key), hit_id === void 0 ? (0, node_crypto.randomBytes)(12).toString("base64url") : String(hit_id), ...redis_args);
	if (!Array.isArray(result)) throw new ScriptResultError();
	const [result_block, result_usage] = result;
	if (!Array.isArray(result_block) || !Array.isArray(result_usage)) throw new ScriptResultError();
	const block = /* @__PURE__ */ new Map();
	for (const result_limiter of result_block) {
		if (!Array.isArray(result_limiter)) throw new ScriptResultError();
		const [limiter_name, ttl] = result_limiter;
		if (typeof limiter_name !== "string" || typeof ttl !== "number") throw new ScriptResultError();
		block.set(limiter_name, {
			name: limiter_name,
			ttl
		});
	}
	const usage = /* @__PURE__ */ new Map();
	for (const result_limiter of result_usage) {
		if (!Array.isArray(result_limiter)) throw new ScriptResultError();
		const [limiter_name, remaining, ttl, is_hit_unique] = result_limiter;
		if (typeof limiter_name !== "string" || typeof remaining !== "number" || typeof ttl !== "number" || is_hit_unique !== void 0 && is_hit_unique !== 0 && is_hit_unique !== 1) throw new ScriptResultError();
		usage.set(limiter_name, {
			name: limiter_name,
			remaining,
			ttl: ttl === -1 ? void 0 : ttl,
			is_hit_unique: is_hit_unique !== 0
		});
	}
	return {
		block,
		usage
	};
}
/** Requires every limiter to allow the hit, including active repeated IDs. */
function check(state) {
	return state.block.size === 0 && state.usage.values().every(({ remaining, is_hit_unique }) => remaining > 0 || !is_hit_unique);
}
//#endregion
//#region src/state.ts
/** Finds the longest block among the given limiters. */
function getLongestBlock(limiters, block_states) {
	let limiter_priority = -Infinity;
	let result_limiter;
	let result_block_state;
	for (const limiter of limiters) {
		const block_state = block_states.get(limiter.name);
		if (!block_state) continue;
		if (!result_block_state || limiter.priority > limiter_priority || limiter.priority === limiter_priority && block_state.ttl > result_block_state.ttl) {
			limiter_priority = limiter.priority;
			result_limiter = limiter;
			result_block_state = block_state;
		}
	}
	if (!result_limiter || !result_block_state) throw new Error(`Internal @redis-x/limiter error.`);
	return {
		limiter: result_limiter,
		ttl: result_block_state.ttl
	};
}
/** Finds the smallest limit among the given limiters. */
function getSmallestLimit(limiters, usage_states) {
	const [usage_state] = usage_states.values().toArray().toSorted((a, b) => {
		if (a.remaining !== b.remaining) return a.remaining - b.remaining;
		return (b.ttl ?? -1) - (a.ttl ?? -1);
	});
	if (!usage_state) throw new Error(`Internal @redis-x/limiter error.`);
	return {
		limiter: limiters.find((limiter) => limiter.name === usage_state.name),
		remaining: usage_state.remaining,
		ttl: usage_state.ttl,
		is_hit_unique: usage_state.is_hit_unique
	};
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
var RedisXLimiterExceededError = class extends Error {
	limiter;
	ttl;
	name = "RedisXLimiterExceededError";
	constructor(limiter, ttl) {
		super("Limit exceeded.");
		this.limiter = limiter;
		this.ttl = ttl;
	}
};
var RedisXLimiter = class {
	type;
	name;
	priority = Number.MAX_SAFE_INTEGER;
	/** @internal */
	_script;
	/** @internal */
	_redis_args;
	constructor(redisXClient, options) {
		this.type = options.type;
		this.name = options.name;
		if (!inkey_regex.test(this.name)) throw new TypeError("Invalid limiter name.");
		if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new TypeError("Invalid limit: expected a positive safe integer.");
		if (!Number.isSafeInteger(options.ttl) || options.ttl <= 0 || options.ttl > MAX_TTL_SECONDS) throw new TypeError(`Invalid ttl: expected a positive integer up to ${MAX_TTL_SECONDS}.`);
		if (options.block_ttl !== void 0 && (!Number.isSafeInteger(options.block_ttl) || options.block_ttl <= 0 || options.block_ttl > MAX_TTL_SECONDS)) throw new TypeError(`Invalid block_ttl: expected a positive integer up to ${MAX_TTL_SECONDS}.`);
		if (LIMITER_NAMES.has(this.name)) throw new TypeError("Duplicate limiter name. You can not reuse the same name for multiple limiters to avoid conflicts.");
		LIMITER_NAMES.add(this.name);
		if (options.priority !== void 0) this.priority = options.priority;
		this._script = createScript(redisXClient);
		this._redis_args = [
			options.type,
			options.name,
			options.limit.toString(),
			options.ttl.toString(),
			options.block_ttl?.toString() ?? "-1"
		];
	}
	/** @internal */
	_getRedisKey(key) {
		if (this.type === "2") return `${REDIS_PREFIX}:${this.name}:${key}`;
		return `${REDIS_PREFIX}:${this.name}`;
	}
	#runScript(op, key, hit_id) {
		return runScript(this._script, op, key, hit_id, [this._getRedisKey(key)], this._redis_args);
	}
	async check(key, hit_id) {
		return check(await this.#runScript("1", key, hit_id));
	}
	async get(key) {
		const state = await this.#runScript("1", key);
		if (state.block.size > 0) return {
			limiter: this,
			ttl: state.block.get(this.name).ttl
		};
		const { remaining, ttl, is_hit_unique } = state.usage.get(this.name);
		return {
			limiter: this,
			remaining,
			ttl,
			is_hit_unique
		};
	}
	async hit(key, hit_id) {
		if (typeof key === "string" && !inkey_regex.test(key)) throw new TypeError("Invalid key.");
		if (this.type !== "2" && hit_id !== void 0) throw new Error("Passing hit_id is only supported for sliding window limiter.");
		const state = await this.#runScript("2", key, hit_id);
		if (state.block.size > 0) throw new RedisXLimiterExceededError(this, state.block.get(this.name).ttl);
		const { remaining, ttl, is_hit_unique } = state.usage.get(this.name);
		return {
			limiter: this,
			remaining,
			ttl,
			is_hit_unique
		};
	}
};
var RedisXLimitersBatch = class {
	#limiters;
	#script;
	#redis_args = [];
	constructor(...limiters) {
		this.#limiters = [...new Set(limiters)];
		const script = this.#limiters[0]?._script;
		if (script === void 0) throw new TypeError("At least one limiter is required.");
		this.#script = script;
		for (const limiter of this.#limiters) {
			if (limiter._script !== this.#script) throw new Error("All limiters must use the same Redis client.");
			this.#redis_args.push(...limiter._redis_args);
		}
	}
	#runScript(op, key, hit_id) {
		return runScript(this.#script, op, key, hit_id, this.#limiters.map((limiter) => limiter._getRedisKey(key)), this.#redis_args);
	}
	async check(key, hit_id) {
		return check(await this.#runScript("1", key, hit_id));
	}
	async get(key) {
		const state = await this.#runScript("1", key);
		if (state.block.size > 0) return getLongestBlock(this.#limiters, state.block);
		return getSmallestLimit(this.#limiters, state.usage);
	}
	async getAll(key) {
		const state = await this.#runScript("1", key);
		const result = [];
		for (const limiter of this.#limiters) {
			if (state.block.has(limiter.name)) {
				const { ttl } = state.block.get(limiter.name);
				result.push({
					limiter,
					ttl
				});
			}
			if (state.usage.has(limiter.name)) {
				const { remaining, ttl, is_hit_unique } = state.usage.get(limiter.name);
				result.push({
					limiter,
					remaining,
					ttl,
					is_hit_unique
				});
			}
		}
		return result;
	}
	async hit(key, hit_id) {
		const state = await this.#runScript("2", key, hit_id);
		if (state.block.size > 0) {
			const { limiter, ttl } = getLongestBlock(this.#limiters, state.block);
			throw new RedisXLimiterExceededError(limiter, ttl);
		}
		return getSmallestLimit(this.#limiters, state.usage);
	}
};
//#endregion
exports.RedisXLimiter = RedisXLimiter;
exports.RedisXLimiterExceededError = RedisXLimiterExceededError;
exports.RedisXLimiterType = RedisXLimiterType;
exports.RedisXLimitersBatch = RedisXLimitersBatch;
