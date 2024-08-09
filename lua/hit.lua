
local limits = {}

local blocked_limit_index = -1
local blocked_ttl = 0

for index_lua, redis_key in ipairs(KEYS) do
	local index = index_lua - 1

	local type = table.remove(ARGV, 1)
	local limit = tonumber(table.remove(ARGV, 1))
	local ttl_counter = tonumber(table.remove(ARGV, 1))
	local ttl_block = tonumber(table.remove(ARGV, 1))

	local counter_value = redis.pcall(
		"GET",
		redis_key
	)
	if "x" == counter_value then
		local ttl_block_current = redis.call(
			"TTL",
			redis_key
		)
		if ttl_block_current > blocked_ttl then
			blocked_limit_index = index
			blocked_ttl = ttl_block_current
		end
	end

	limits[redis_key] = {
		index = index,
		type = type,
		limit = limit,
		ttl_counter = ttl_counter,
		ttl_block = ttl_block
	}
end

if blocked_ttl > 0 then
	return {
		blocked_limit_index,
		blocked_ttl
	}
end

local elements = ARGV

for redis_key, limit_state in pairs(limits) do
	local counter_value_new = 0

	local is_key_existed = redis.call(
		"EXISTS",
		redis_key
	)

	if limit_state.type == "0" then
		if #elements == 0 then
			counter_value_new = redis.call(
				"INCR",
				redis_key
			)
		else
			counter_value_new = redis.call(
				"INCRBY",
				redis_key,
				#elements
			)
		end
	elseif limit_state.type == "1" then
		if #elements == 0 then
			error("Limit type 'set' is found, but no elements are provided")
		end

		redis.call(
			"SADD",
			redis_key,
			--- @diagnostic disable-next-line: deprecated
			unpack(elements)
		)

		counter_value_new = redis.call(
			"SCARD",
			redis_key
		)
	else
		error("Unknown limit type '" .. limit_state.type .. "'")
	end

	if is_key_existed == 0 then
		redis.call(
			"EXPIRE",
			redis_key,
			limit_state.ttl_counter
		)
	end

	if counter_value_new > limit_state.limit then
		redis.call(
			"SET",
			redis_key,
			"x",
			"KEEPTTL"
		)

		if limit_state.ttl_block > 0 then
			redis.call(
				"EXPIRE",
				redis_key,
				limit_state.ttl_block
			)

			if limit_state.ttl_block > blocked_ttl then
				blocked_ttl = limit_state.ttl_block
				blocked_limit_index = limit_state.index
			end
		else
			local ttl_block_current = redis.call(
				"TTL",
				redis_key
			)

			if ttl_block_current > blocked_ttl then
				blocked_ttl = ttl_block_current
				blocked_limit_index = limit_state.index
			end
		end
	end
end

if blocked_ttl > 0 then
	return {
		blocked_limit_index,
		blocked_ttl
	}
end

return {}
