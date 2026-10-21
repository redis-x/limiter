import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import lua_script from '../script.lua' with { type: 'text' };

const prefix = `fixed-window-test-${randomUUID()}`;
const blockKey = `${prefix}:blocks`;
const ownedKeys = new Set([blockKey]);
const types = ['0', '1'];
let timestamp: number;

beforeAll(async () => {
	const time = (await redisXClient.sendCommand('TIME')) as string[];
	// Keep Redis expirations in the future and start 15 seconds into a window.
	timestamp = Math.floor((Number(time[0]) + 120) / 60) * 60 + 15;
});

afterAll(async () => {
	await redisXClient.DEL([...ownedKeys]);
});

/** Allocates state on the shared client without reusing limiter names. */
function createLimiter(type: string, block = -1) {
	const name = randomUUID();
	const key = `${prefix}:${name}`;
	ownedKeys.add(key);
	return { name, key, type, block };
}

type Limiter = ReturnType<typeof createLimiter>;
type Result = [string, number, number, number?][];

/** Uses native Redis replies with a controlled clock for exact deadline assertions. */
async function run(op: '1' | '2', limiters: Limiter | Limiter[], offset = 0) {
	const entries = Array.isArray(limiters) ? limiters : [limiters];
	const script = lua_script.replace(
		/^local ts = [^\n]+/u,
		() => `local ts = ${timestamp + offset}`,
	);
	const response = await redisXClient.EVAL(
		script,
		[blockKey, ...entries.map((limiter) => limiter.key)],
		[
			op,
			'subject',
			'hit',
			...entries.flatMap((limiter) => [
				limiter.type,
				limiter.name,
				'3',
				'60',
				String(limiter.block),
			]),
		],
	);
	return response as Result;
}

/** Seeds a partly elapsed window with 25 seconds remaining. */
async function seed(limiter: Limiter, used: number) {
	await redisXClient.HSET(limiter.key, 'subject', String(used));
	await redisXClient.sendCommand(
		'HEXPIREAT',
		limiter.key,
		timestamp + 25,
		'FIELDS',
		1,
		'subject',
	);
}

/** Reads the counter and its absolute deadline to detect unintended writes. */
function state(limiter: Limiter) {
	return Promise.all([
		redisXClient.HGET(limiter.key, 'subject'),
		redisXClient.sendCommand(
			'HEXPIRETIME',
			limiter.key,
			'FIELDS',
			1,
			'subject',
		),
	]);
}

/** Reads stored block deadlines independently of quota reset times. */
function blockDeadlines(...limiters: Limiter[]) {
	return redisXClient.sendCommand(
		'HEXPIRETIME',
		blockKey,
		'FIELDS',
		limiters.length,
		...limiters.map((limiter) => `${limiter.name}:subject`),
	);
}

test.each(types)(
	'get leaves an unused type %s window unstarted',
	async (type) => {
		const limiter = createLimiter(type, 90);
		expect(await run('1', limiter)).toEqual([
			type === '0' ? [limiter.name, 0, 3, 45] : [limiter.name, 0, 3],
		]);
		expect(await state(limiter)).toEqual([null, [-2]]);
		expect(
			await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`),
		).toBe(false);
	},
);

test.each(types)(
	'get returns type %s usage and its remaining deadline',
	async (type) => {
		const limiter = createLimiter(type);
		await seed(limiter, 1);
		expect(await run('1', limiter, 5)).toEqual([[limiter.name, 0, 2, 20]]);
		expect(await state(limiter)).toEqual(['1', [timestamp + 25]]);
	},
);

test.each(types)(
	'get reports exhaustion without persisting a block for type %s',
	async (type) => {
		const limiter = createLimiter(type, 90);
		await seed(limiter, 3);
		expect(await run('1', limiter)).toEqual([[limiter.name, 1, 25]]);
		expect(await state(limiter)).toEqual(['3', [timestamp + 25]]);
		expect(
			await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`),
		).toBe(false);
	},
);

test.each(types)(
	'hit starts a type %s window and returns usage after the hit',
	async (type) => {
		const limiter = createLimiter(type);
		const duration = type === '0' ? 45 : 60;
		expect(await run('2', limiter)).toEqual([[limiter.name, 0, 2, duration]]);
		expect(await state(limiter)).toEqual(['1', [timestamp + duration]]);
		expect(await run('1', limiter, 5)).toEqual([
			[limiter.name, 0, 2, duration - 5],
		]);
	},
);

test.each(types)(
	'hit preserves a type %s deadline and blocks only when exceeding',
	async (type) => {
		const limiter = createLimiter(type, 90);
		await seed(limiter, 1);
		expect(await run('2', limiter, 5)).toEqual([[limiter.name, 0, 1, 20]]);
		expect(await state(limiter)).toEqual(['2', [timestamp + 25]]);
		expect(await run('2', limiter, 6)).toEqual([[limiter.name, 0, 0, 19]]);
		expect(
			await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`),
		).toBe(false);
		expect(await run('2', limiter, 7)).toEqual([[limiter.name, 1, 90]]);
		expect(await state(limiter)).toEqual(['3', [timestamp + 25]]);
		expect(await blockDeadlines(limiter)).toEqual([timestamp + 97]);
	},
);

test.each(types)(
	'exhaustion-only type %s hits return recovery time without incrementing',
	async (type) => {
		const limiter = createLimiter(type);
		await seed(limiter, 3);
		expect(await run('2', limiter)).toEqual([[limiter.name, 1, 25]]);
		expect(await state(limiter)).toEqual(['3', [timestamp + 25]]);
		expect(
			await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`),
		).toBe(false);
	},
);

test.each([
	{ op: '1' as const, used: false },
	{ op: '1' as const, used: true },
	{ op: '2' as const, used: false },
	{ op: '2' as const, used: true },
])(
	'preserves an existing block for op=$op with usage=$used',
	async ({ op, used }) => {
		const limiter = createLimiter('1', 90);
		if (used) {
			await seed(limiter, 1);
		}

		const field = `${limiter.name}:subject`;
		await redisXClient.HSET(blockKey, field, '');
		await redisXClient.sendCommand(
			'HEXPIREAT',
			blockKey,
			timestamp + 300,
			'FIELDS',
			1,
			field,
		);
		const before = await state(limiter);
		const result = await run(op, limiter);
		expect(result).toEqual([[limiter.name, 1, expect.any(Number)]]);
		expect(result[0]?.[2]).toBeGreaterThan(300);
		expect(await state(limiter)).toEqual(before);
		expect(await blockDeadlines(limiter)).toEqual([timestamp + 300]);
	},
);

test.each(types)(
	'expired type %s windows return full capacity before starting again',
	async (type) => {
		const limiter = createLimiter(type);
		await seed(limiter, 3);
		await redisXClient.sendCommand(
			'HEXPIREAT',
			limiter.key,
			1,
			'FIELDS',
			1,
			'subject',
		);
		expect(await run('1', limiter)).toEqual([
			type === '0' ? [limiter.name, 0, 3, 45] : [limiter.name, 0, 3],
		]);
		expect(await run('2', limiter)).toEqual([
			[limiter.name, 0, 2, type === '0' ? 45 : 60],
		]);
	},
);

test('get reports both fixed-window types without modifying either', async () => {
	const aligned = createLimiter('0');
	const started = createLimiter('1');
	await seed(aligned, 1);
	await seed(started, 2);
	expect(await run('1', [aligned, started])).toEqual([
		[aligned.name, 0, 2, 25],
		[started.name, 0, 1, 25],
	]);
	expect(await state(aligned)).toEqual(['1', [timestamp + 25]]);
	expect(await state(started)).toEqual(['2', [timestamp + 25]]);
});

test.each([
	{ block: -1, exhaustedFirst: false },
	{ block: -1, exhaustedFirst: true },
	{ block: 90, exhaustedFirst: false },
	{ block: 90, exhaustedFirst: true },
])(
	'rejected hit discards all usage with block=$block, exhaustedFirst=$exhaustedFirst',
	async ({ block, exhaustedFirst }) => {
		const exhausted = createLimiter('1', block);
		const active = createLimiter('0');
		const unused = createLimiter('1');
		await seed(exhausted, 3);
		await seed(active, 1);
		const entries = exhaustedFirst
			? [exhausted, active, unused]
			: [active, unused, exhausted];

		expect(await run('1', entries)).toEqual([
			[exhausted.name, 1, 25],
			[active.name, 0, 2, 25],
			[unused.name, 0, 3],
		]);
		expect(await run('2', entries)).toEqual([
			[exhausted.name, 1, block > 0 ? block : 25],
		]);
		expect(await state(exhausted)).toEqual(['3', [timestamp + 25]]);
		expect(await state(active)).toEqual(['1', [timestamp + 25]]);
		expect(await state(unused)).toEqual([null, [-2]]);
		expect(await blockDeadlines(exhausted)).toEqual([
			block > 0 ? timestamp + block : -2,
		]);
	},
);

test('existing blocks do not hide other exhausted limiters or consume companion usage', async () => {
	const blocked = createLimiter('1', 90);
	const exhausted = createLimiter('0', 120);
	const active = createLimiter('1');
	await seed(exhausted, 3);
	await seed(active, 1);
	const field = `${blocked.name}:subject`;
	await redisXClient.HSET(blockKey, field, '');
	await redisXClient.sendCommand(
		'HEXPIREAT',
		blockKey,
		timestamp + 300,
		'FIELDS',
		1,
		field,
	);
	const entries = [active, blocked, exhausted];

	expect(await run('1', entries)).toEqual([
		[blocked.name, 1, expect.any(Number)],
		[exhausted.name, 1, 25],
		[active.name, 0, 2, 25],
	]);
	expect(
		await redisXClient.HEXISTS(blockKey, `${exhausted.name}:subject`),
	).toBe(false);
	expect(await run('2', entries)).toEqual([
		[blocked.name, 1, expect.any(Number)],
		[exhausted.name, 1, 120],
	]);
	expect(await state(active)).toEqual(['1', [timestamp + 25]]);
	expect(await state(exhausted)).toEqual(['3', [timestamp + 25]]);
	expect(await state(blocked)).toEqual([null, [-2]]);
	expect(await blockDeadlines(blocked, exhausted)).toEqual([
		timestamp + 300,
		timestamp + 120,
	]);
});

test('successful batch commits all usage, including each last allowed hit', async () => {
	const aligned = createLimiter('0', 90);
	const started = createLimiter('1');
	await seed(aligned, 2);
	await seed(started, 2);
	expect(await run('2', [aligned, started])).toEqual([
		[aligned.name, 0, 0, 25],
		[started.name, 0, 0, 25],
	]);
	expect(await state(aligned)).toEqual(['3', [timestamp + 25]]);
	expect(await state(started)).toEqual(['3', [timestamp + 25]]);
	expect(await blockDeadlines(aligned)).toEqual([-2]);
});
