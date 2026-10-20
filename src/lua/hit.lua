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
				ts_expire = (math.floor(ts / limiter.ttl) + 1) * limiter.ttl
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
