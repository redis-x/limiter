
local results = {}

for _, redis_key in ipairs(KEYS) do
	local counter = 0
	local ttl = 0

	local redis_key_type = redis.call("TYPE", redis_key).ok

	if "none" ~= redis_key_type then
		ttl = redis.call("TTL", redis_key)
	end

	if "string" == redis_key_type then
		local redis_key_value = redis.call("GET", redis_key)
		if "x" == redis_key_value then
			counter = -1
		else
			counter = tonumber(redis_key_value)
		end
	elseif "set" == redis_key_type then
		counter = redis.call("SCARD", redis_key)
	end

	table.insert(results, { counter, ttl })
end

return results
