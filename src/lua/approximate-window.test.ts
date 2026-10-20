import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import lua_hit from './hit.lua' with { type: 'text' };
import lua_prepare from './prepare.lua' with { type: 'text' };

const client = createClient({
	socket: { host: '127.0.0.1', port: 16379, reconnectStrategy: false },
});
const prefix = `approximate-window-test-${randomUUID()}`;
const ownedKeys = new Set<string>();
let timestamp: number;

interface WindowState {
	window: number;
	elapsed: number;
	previous: number;
	current: number;
	limit: number;
}

beforeAll(async () => {
	await client.connect();
	const time = await client.sendCommand(['TIME']);
	timestamp = Number(time[0]);
});

afterAll(async () => {
	if (client.isOpen) {
		try {
			if (ownedKeys.size > 0) {
				await client.del([...ownedKeys]);
			}
		} finally {
			await client.quit();
		}
	}
});

/** Seeds isolated counters with a deterministic script clock. */
async function createState(options: WindowState) {
	const name = randomUUID();
	const keys = [`${prefix}:${name}:blocks`, `${prefix}:${name}:usage`];
	for (const key of keys) {
		ownedKeys.add(key);
	}

	// Keep physical expirations in the future while advancing the script's clock.
	const epoch = Math.floor((timestamp + 120) / options.window);
	const fields: Record<string, string> = {};
	if (options.previous > 0) {
		fields[`${epoch - 1}:subject`] = String(options.previous);
	}

	if (options.current > 0) {
		fields[`${epoch}:subject`] = String(options.current);
	}

	if (Object.keys(fields).length > 0) {
		await client.hSet(keys[1], fields);
	}

	return {
		...options,
		name,
		keys,
		timestamp: epoch * options.window + options.elapsed,
	};
}

/** Runs the actual limiter Lua at an offset from the seeded timestamp. */
function hit(
	state: Awaited<ReturnType<typeof createState>>,
	offset = 0,
	block = -1,
) {
	return client.eval(
		[`local ts = ${state.timestamp + offset}`, lua_prepare, lua_hit].join('\n'),
		{
			keys: state.keys,
			arguments: [
				'subject',
				'hit',
				'3',
				state.name,
				String(state.limit),
				String(state.window),
				String(block),
			],
		},
	);
}

test.each([
	{
		name: 'fractional recovery within this window',
		window: 60,
		elapsed: 15,
		previous: 8,
		current: 4,
		limit: 10,
		delay: 8,
	},
	{
		name: 'exact recovery within this window',
		window: 60,
		elapsed: 6,
		previous: 10,
		current: 1,
		limit: 10,
		delay: 6,
	},
	{
		name: 'empty current window',
		window: 60,
		elapsed: 0,
		previous: 10,
		current: 0,
		limit: 10,
		delay: 6,
	},
	{
		name: 'recovery exactly at rollover',
		window: 60,
		elapsed: 30,
		previous: 1,
		current: 9,
		limit: 10,
		delay: 30,
	},
	{
		name: 'recovery after rollover',
		window: 60,
		elapsed: 15,
		previous: 0,
		current: 10,
		limit: 10,
		delay: 51,
	},
	{
		name: 'fractional recovery after rollover',
		window: 60,
		elapsed: 15,
		previous: 0,
		current: 7,
		limit: 7,
		delay: 54,
	},
	{
		name: 'exhaustion at the start of a window',
		window: 60,
		elapsed: 0,
		previous: 0,
		current: 10,
		limit: 10,
		delay: 66,
	},
	{
		name: 'limit one with previous usage',
		window: 60,
		elapsed: 15,
		previous: 1,
		current: 0,
		limit: 1,
		delay: 45,
	},
	{
		name: 'limit one with current usage',
		window: 60,
		elapsed: 15,
		previous: 0,
		current: 1,
		limit: 1,
		delay: 105,
	},
	{
		name: 'one-second windows',
		window: 1,
		elapsed: 0,
		previous: 0,
		current: 1,
		limit: 1,
		delay: 2,
	},
	{
		name: 'current count above a reduced limit',
		window: 60,
		elapsed: 15,
		previous: 0,
		current: 12,
		limit: 10,
		delay: 60,
	},
])('returns the earliest whole-second retry for $name', async (options) => {
	const state = await createState(options);
	const usageBefore = await client.hGetAll(state.keys[1]);

	expect(await hit(state)).toEqual([1, [[state.name, options.delay]]]);
	expect(await hit(state, options.delay - 1)).toEqual([1, [[state.name, 1]]]);
	expect(await client.hGetAll(state.keys[1])).toEqual(usageBefore);
	expect(await client.exists(state.keys[0])).toBe(0);
	expect(await hit(state, options.delay)).toBeNull();
});

test('allows an exact fit without floating-point weight drift', async () => {
	const state = await createState({
		window: 3,
		elapsed: 1,
		previous: 9,
		current: 3,
		limit: 10,
	});

	expect(await hit(state)).toBeNull();
});

test('reports the configured block duration when blocking is enabled', async () => {
	const state = await createState({
		window: 60,
		elapsed: 15,
		previous: 0,
		current: 10,
		limit: 10,
	});
	const usageBefore = await client.hGetAll(state.keys[1]);

	expect(await hit(state, 0, 30)).toEqual([1, [[state.name, 30]]]);
	expect(await client.hGetAll(state.keys[1])).toEqual(usageBefore);
	expect(
		await client.sendCommand([
			'HEXPIRETIME',
			state.keys[0],
			'FIELDS',
			'1',
			`${state.name}:subject`,
		]),
	).toEqual([state.timestamp + 30]);
});
