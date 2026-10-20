local key_block = KEYS[1]
local limiting_key = ARGV[1]
local hit_id = ARGV[2]

local limiters = {}
local limiters_block_fields = {}
-- Each limiter is passed as: type, name, limit, ttl, block.
for i = 3, #ARGV, 5 do
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
local limiters_blocked = {}
for index, limiter in ipairs(limiters) do
	local ttl = resp_blocked[index]
	if ttl > 0 then
		table.insert(
			limiters_blocked,
			{ limiter.name, ttl }
		)
	end
end

if #limiters_blocked > 0 then
	return { 1, limiters_blocked }
end
