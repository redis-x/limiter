import { RedisXClient } from '@redis-x/client';
import { createClient } from 'redis';
import type { RedisClient } from '../src/utils.js';

export const redisClient: RedisClient = createClient({
	socket: {
		port: 16379,
	},
});

await redisClient.connect();
await redisClient.FLUSHDB();

export const redisXClient: RedisXClient = new RedisXClient(redisClient);

/** Returns Redis's clock in the whole seconds used by the limiter. */
export async function redisTime(): Promise<number> {
	const [seconds] = (await redisXClient.sendCommand('TIME')) as [
		string,
		string,
	];
	return Number(seconds);
}

/** Prepares a field and its deadline as a test's starting state. */
export async function setHashField(
	key: string,
	field: string,
	state: { value: string | number; deadline: number },
): Promise<void> {
	await redisXClient.HSET(key, field, state.value);
	await redisXClient.sendCommand(
		'HEXPIREAT',
		key,
		state.deadline,
		'FIELDS',
		1,
		field,
	);
}

/** Reads an absolute deadline, or Redis's missing/persistent field sentinel. */
export async function hashFieldExpiration(
	key: string,
	field: string,
): Promise<number> {
	const [deadline] = (await redisXClient.sendCommand(
		'HEXPIRETIME',
		key,
		'FIELDS',
		1,
		field,
	)) as [number];
	return deadline;
}
