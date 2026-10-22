local ts = tonumber(redis.call('TIME')[1])

-- 1=get, 2=hit
local op = tonumber(ARGV[1])
local key_block = KEYS[1]
local limiting_key = ARGV[2]
local hit_id = ARGV[3]

local limiters = {}
local limiters_block_fields = {}
for i = 4, #ARGV, 5 do
	local name = ARGV[i + 1]
	local field_block = name .. ":" .. limiting_key
	table.insert(limiters, {
		type = ARGV[i],
		name = name,
		key = KEYS[#limiters + 2],
		field_block = field_block,
		limit = tonumber(ARGV[i + 2]),
		ttl = tonumber(ARGV[i + 3]),
		ttl_block = tonumber(ARGV[i + 4]),
	})
	table.insert(limiters_block_fields, field_block)
end

local resp_blocked = redis.call('HTTL', key_block, "FIELDS", #limiters_block_fields, unpack(limiters_block_fields))
local result_blocks = {}
local result_usage = {}
local result_names = {}
local function save_result(type, value)
	local limiter_name = value[1]
	if result_names[limiter_name] == nil then
		if type == 0 then
			table.insert(result_usage, value)
		elseif type == 1 then
			table.insert(result_blocks, value)
		end
		result_names[limiter_name] = true
	end
end
for index, limiter in ipairs(limiters) do
	local ttl = resp_blocked[index]
	if ttl > 0 then
		save_result(1, { limiter.name, ttl })
	end
end

local function get_epoch(size)
	return math.floor(ts / size)
end
local function get_epoch_ts_end(epoch, size)
	return (epoch + 1) * size
end

local hit_args = {}
local function set_block(limiter)
	if op == 2 and limiter.ttl_block > 0 then
		-- Blocks persist even when the batch discards all queued usage changes.
		redis.call("HSET", key_block, limiter.field_block, "")
		redis.call("HEXPIREAT", key_block, ts + limiter.ttl_block, "FIELDS", 1, limiter.field_block)
		save_result(1, { limiter.name, limiter.ttl_block })
	end
end

for _, limiter in ipairs(limiters) do
	-- Skip iterating limiters that already blocked
	if result_names[limiter.name] ~= nil then
	-- ---------------------------------------------------
	-- fixed window / fixed window with user defined start
	-- ---------------------------------------------------
	elseif limiter.type == "0" or limiter.type == "1" then
		local value = redis.call("HGET", limiter.key, limiting_key)
		local counter = tonumber(value) or 0
		-- Capture exhaustion before a hit can consume the last available slot.
		local is_exhausted = counter >= limiter.limit
		-- No active window means there is no scheduled usage change.
		local ts_expire = nil
		if counter > 0 then
			ts_expire = redis.call("HEXPIRETIME", limiter.key, "FIELDS", 1, limiting_key)[1]
		elseif limiter.type == "0" then
			ts_expire = get_epoch_ts_end(get_epoch(limiter.ttl), limiter.ttl)
		end

		if op == 2 then
			if is_exhausted then
				set_block(limiter)
			else
				if counter == 0 then
					if limiter.type == "1" then
						ts_expire = ts + limiter.ttl
					end

					table.insert(hit_args, {
						"HSET", limiter.key, limiting_key, 1,
					})
					table.insert(hit_args, {
						"HEXPIREAT", limiter.key, ts_expire, "FIELDS", 1, limiting_key,
					})
				else
					table.insert(hit_args, {
						"HINCRBY", limiter.key, limiting_key, 1,
					})
				end
				counter = counter + 1
			end
		end

		-- Fixed-window quota fully resets at its deadline. Exhaustion recovers
		-- then too; a separately stored block retains its own expiration.
		local ttl_reset = -1
		if ts_expire ~= nil then
			ttl_reset = ts_expire - ts
		end
		if is_exhausted then
			save_result(1, { limiter.name, ttl_reset })
		else
			save_result(0, {
				limiter.name,
				math.max(0, limiter.limit - counter),
				ttl_reset,
			})
		end
	-- ---------------------------------------------------
	-- sliding window
	-- ---------------------------------------------------
	elseif limiter.type == "2" then
		-- Reads ignore expired members without changing the sorted set.
		local active_min = "(" .. ts
		local counter = redis.call("ZCOUNT", limiter.key, active_min, "+inf")
		local score = tonumber(redis.call("ZSCORE", limiter.key, hit_id))
		local is_unique = score == nil or score <= ts
		if is_unique and counter >= limiter.limit then
			set_block(limiter)
			-- Wait until enough members expire to admit one new distinct ID.
			local next_score = redis.call("ZRANGE", limiter.key, active_min, "+inf", "BYSCORE", "LIMIT", counter - limiter.limit, 1, "WITHSCORES")[2]
			save_result(1, { limiter.name, tonumber(next_score) - ts })
		else
			local ts_expire = ts
			if counter > 0 then
				ts_expire = tonumber(redis.call("ZRANGE", limiter.key, -1, -1, "WITHSCORES")[2])
			end
			if op == 2 then
				local hit_expire = ts + limiter.ttl
				ts_expire = math.max(ts_expire, hit_expire)
				-- Cleanup, insertion, and refresh commit only when every limiter accepts.
				table.insert(hit_args, {
					"ZREMRANGEBYSCORE", limiter.key, "-inf", ts,
				})
				table.insert(hit_args, {
					"ZADD", limiter.key, hit_expire, hit_id,
				})
				table.insert(hit_args, {
					"EXPIREAT", limiter.key, ts_expire,
				})
				if is_unique then
					counter = counter + 1
				end
			end
			-- Full recovery uses the latest deadline; a repeat costs no new slot.
			save_result(0, {
				limiter.name,
				math.max(0, limiter.limit - counter),
				ts_expire - ts,
				is_unique and 1 or 0,
			})
		end
	-- ---------------------------------------------------
	-- sliding window with approximation
	-- ---------------------------------------------------
	elseif limiter.type == "3" then
		local epoch = get_epoch(limiter.ttl)
		local ttl_remaining = limiter.ttl - (ts % limiter.ttl)
		local field_previous = epoch - 1 .. ":" .. limiting_key
		local field_current = epoch .. ":" .. limiting_key
		local resp = redis.call("HMGET", limiter.key, field_previous, field_current)
		local counter_previous = tonumber(resp[1]) or 0
		local counter_current = tonumber(resp[2]) or 0
		local counter = counter_previous * ttl_remaining / limiter.ttl + counter_current
		if counter + 1 > limiter.limit then
			set_block(limiter)
			local ttl_retry
			if counter_current < limiter.limit then
				-- Previous usage decays enough before this window ends.
				local capacity_previous = limiter.limit - counter_current - 1
				ttl_retry = math.ceil(
					(counter_previous * ttl_remaining - capacity_previous * limiter.ttl) / counter_previous
				)
			else
				-- Current usage can only decay after becoming the previous window.
				ttl_retry = ttl_remaining + math.ceil(
					(counter_current - limiter.limit + 1) * limiter.ttl / counter_current
				)
			end
			save_result(1, { limiter.name, ttl_retry })
		else
			if op == 2 then
				if counter_current == 0 then
					table.insert(hit_args, {
						"HSET", limiter.key, field_current, 1,
					})
					table.insert(hit_args, {
						"HEXPIREAT", limiter.key, get_epoch_ts_end(epoch + 1, limiter.ttl), "FIELDS", 1, field_current,
					})
				else
					table.insert(hit_args, {
						"HINCRBY", limiter.key, field_current, 1,
					})
				end
				counter_current = counter_current + 1
				counter = counter + 1
			end
			-- Usage reports full recovery, not the next available whole hit.
			local ttl_reset = 0
			if counter_current > 0 then
				ttl_reset = ttl_remaining + limiter.ttl
			elseif counter_previous > 0 then
				ttl_reset = ttl_remaining
			end
			save_result(0, {
				limiter.name,
				math.max(0, math.floor(limiter.limit - counter)),
				ttl_reset,
			})
		end
	-- ---------------------------------------------------
	-- token bucket
	-- ---------------------------------------------------
-- 	elseif limiter.type == "4" then
-- 		local value = redis.call("HGET", limiter.key, limiting_key)
-- 		local counter = tonumber(value) or 0
-- 		local ts_anchor = ts
-- 		if counter > 0 then
-- 			local ts_expire = redis.call("HEXPIRETIME", limiter.key, "FIELDS", 1, limiting_key)[1]
-- 			if ts_expire > ts then
-- 				ts_anchor = ts_expire - math.ceil(counter * limiter.ttl / limiter.limit)
-- 			else
-- 				counter = 0
-- 			end
-- 		end
--
-- 		-- Rebase by one capacity without changing the represented refill progress.
-- 		if counter == limiter.limit then
-- 			counter = 0
-- 			ts_anchor = ts_anchor + limiter.ttl
-- 		end
-- 		counter = counter + 1
-- 		-- Round the cumulative duration, not each individual token's refill time.
-- 		local ts_expire = ts_anchor + math.ceil(counter * limiter.ttl / limiter.limit)
-- 		local ttl_retry = ts_expire - ts - limiter.ttl
-- 		if ttl_retry > 0 then
-- 			if set_block(limiter) ~= true then
-- 				table.insert(limiters_blocked, {
-- 					limiter.name,
-- 					ttl_retry
-- 				})
-- 			end
-- 		else
-- 			table.insert(hit_args, {
-- 				"HSET", limiter.key, limiting_key, string.format("%.0f", counter),
-- 			})
-- 			table.insert(hit_args, {
-- 				"HEXPIREAT", limiter.key, ts_expire, "FIELDS", 1, limiting_key,
-- 			})
-- 		end
	else
		return redis.error_reply("UNSUP unsupported limiter type " .. limiter.type)
	end
end

if op == 2 then
	if #result_blocks > 0 then
		return { result_blocks, {} }
	end
	for _, args in ipairs(hit_args) do
		redis.call(unpack(args))
	end
	return { {}, result_usage }
end

return { result_blocks, result_usage }
