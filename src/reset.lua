local ts = tonumber(redis.call('TIME')[1])

local key_block = KEYS[1]
local limiting_key = ARGV[1]

-- Limiters use the same five arguments as the main script: type, name, limit, ttl, block ttl.
local fields_block = {}
for i = 2, #ARGV, 5 do
	local type = ARGV[i]
	local key = KEYS[#fields_block + 2]
	table.insert(fields_block, ARGV[i + 1] .. ":" .. limiting_key)

	if type == "2" then
		redis.call("DEL", key)
	elseif type == "3" then
		-- Only the current and previous epochs of the Redis clock are retained.
		local epoch = math.floor(ts / tonumber(ARGV[i + 3]))
		redis.call("HDEL", key, epoch - 1 .. ":" .. limiting_key, epoch .. ":" .. limiting_key)
	else
		redis.call("HDEL", key, limiting_key)
	end
end

redis.call("HDEL", key_block, unpack(fields_block))
