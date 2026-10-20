local function get_epoch(size)
    return math.floor(ts / size)
end
local function get_epoch_ts_end(epoch, size)
	return (epoch + 1) * size
end

local function set_block(limiter)
	if limiter.ttl_block > 0 then
		redis.call("HSET", key_block, limiter.field_block, "")
		redis.call("HEXPIREAT", key_block, ts + limiter.ttl_block, "FIELDS", 1, limiter.field_block)

		table.insert(
			limiters_blocked,
			{ limiter.name, limiter.ttl_block }
		)

		return true
	end
end

local hit_args = {}
for _, limiter in ipairs(limiters) do
	-- ---------------------------------------------------
	-- fixed window / fixed window with user defined start
	-- ---------------------------------------------------
	if limiter.type == "0" or limiter.type == "1" then
		local value = redis.call("HGET", limiter.key, limiting_key)
		local counter = tonumber(value) or 0
		-- if counter does not exists yet, set it to 1 and set the ttl
		if counter == 0 then
			local ts_expire = 0
			-- for fixed window, calculate end of the window
			if limiter.type == "0" then
				ts_expire = get_epoch_ts_end(get_epoch(limiter.ttl), limiter.ttl)
			-- for fixed window with user defined start, start window now
			else
				ts_expire = ts + limiter.ttl
			end

			table.insert(hit_args, {
				"HSET", limiter.key, limiting_key, 1,
			})
			table.insert(hit_args, {
				"HEXPIREAT", limiter.key, ts_expire, "FIELDS", 1, limiting_key,
			})
		elseif counter >= limiter.limit then
			if set_block(limiter) ~= true then
				table.insert(limiters_blocked, {
					limiter.name,
					redis.call("HTTL", limiter.key, "FIELDS", 1, limiting_key)[1]
				})
			end
		else
			table.insert(hit_args, {
				"HINCRBY", limiter.key, limiting_key, 1,
			})
		end
	-- ---------------------------------------------------
	-- sliding window
	-- ---------------------------------------------------
	elseif limiter.type == "2" then
		-- wipe expired
		redis.call("ZREMRANGEBYSCORE", limiter.key, "-inf", ts)
		local is_unique = redis.call('ZSCORE', limiter.key, hit_id) == false
		local ts_expire = ts + limiter.ttl
		if
			is_unique
			and redis.call("ZCARD", limiter.key) >= limiter.limit
		then
			if set_block(limiter) ~= true then
				local resp_score = redis.call("ZRANGE", limiter.key, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")[2]
				table.insert(limiters_blocked, {
					limiter.name,
					tonumber(resp_score) - ts
				})
			end
		else
			table.insert(hit_args, {
				"ZADD", limiter.key, ts_expire, hit_id,
			})
			table.insert(hit_args, {
				"EXPIREAT", limiter.key, ts_expire,
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
			if set_block(limiter) ~= true then
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
				table.insert(limiters_blocked, {
					limiter.name,
					ttl_retry
				})
			end
		elseif counter_current == 0 then
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
	else
		return redis.error_reply("UNSUP unsupported limiter type " .. limiter.type)
	end
end

if #limiters_blocked > 0 then
	return { 1, limiters_blocked }
end

for _, args in ipairs(hit_args) do
	redis.call(unpack(args))
end
