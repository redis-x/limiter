import { RedisXClient } from '@redis-x/client';
import { createClient } from 'redis';

const redisClient = createClient({
	socket: {
		port: 16379,
	},
});

await redisClient.connect();
await redisClient.FLUSHDB();

export const redisXClient: RedisXClient = new RedisXClient(redisClient);
