import { createClient } from 'redis';

export const redisClient = createClient({
	socket: {
		port: 16379,
	},
});

await redisClient.connect();
await redisClient.FLUSHDB();
