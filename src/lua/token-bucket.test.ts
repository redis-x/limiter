// oxlint-disable no-await-in-loop -- Requests must consume and refill the same bucket in order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { redisXClient } from '../../test/redis.js';
import lua_hit from './hit.lua' with { type: 'text' };
import lua_prepare from './prepare.lua' with { type: 'text' };
import lua_time from './time.lua' with { type: 'text' };

const prefix = `token-bucket-test-${randomUUID()}`;
const blockKey = `${prefix}:blocks`;
const ownedKeys = new Set([blockKey]);
let timestamp: number;

interface LimiterOptions {
	limit: number;
	ttl: number;
	block?: number;
	type?: string;
}

beforeAll(async () => {
	const time = (await redisXClient.sendCommand('TIME')) as string[];
	timestamp = Number(time[0]) + 120;
});

afterAll(async () => {
	await redisXClient.DEL([...ownedKeys]);
});

/** Allocates isolated limiter state on the shared test client. */
function createLimiter(options: LimiterOptions) {
	const name = randomUUID();
	const key = `${prefix}:${name}`;
	ownedKeys.add(key);
	return { type: '4', block: -1, ...options, name, key };
}

type Limiter = ReturnType<typeof createLimiter>;

/** Runs the actual composed Lua for one limiter or a batch at a controlled time. */
function hit(limiters: Limiter | Limiter[], offset = 0, subject = 'subject') {
	const entries = Array.isArray(limiters) ? limiters : [limiters];
	return redisXClient.EVAL(
		[`local ts = ${timestamp + offset}`, lua_prepare, lua_hit].join('\n'),
		[blockKey, ...entries.map((limiter) => limiter.key)],
		[
			subject,
			'hit',
			...entries.flatMap((limiter) => [
				limiter.type,
				limiter.name,
				String(limiter.limit),
				String(limiter.ttl),
				String(limiter.block),
			]),
		],
	);
}

/** Reads both parts of the bucket state for mutation and deadline assertions. */
async function usage(limiter: Limiter, subject = 'subject') {
	const [value, deadlines] = await Promise.all([
		redisXClient.HGET(limiter.key, subject),
		redisXClient.sendCommand('HEXPIRETIME', limiter.key, 'FIELDS', 1, subject),
	]);
	if (value !== null) {
		expect(value).toMatch(/^[1-9]\d*$/u);
		expect(Number(value)).toBeLessThanOrEqual(limiter.limit);
	}

	return {
		used: value === null ? null : Number(value),
		deadline: (deadlines as number[])[0],
	};
}

test('allows a full burst and expires each snapshot when fully refilled', async () => {
	const limiter = createLimiter({ limit: 4, ttl: 10 });
	for (let count = 1; count <= 4; count += 1) {
		expect(await hit(limiter)).toBeNull();
		expect(await usage(limiter)).toEqual({
			used: count,
			deadline: timestamp + Math.ceil((count * 10) / 4),
		});
	}

	const before = await usage(limiter);
	expect(await hit(limiter)).toEqual([1, [[limiter.name, 3]]]);
	expect(await hit(limiter, 2)).toEqual([1, [[limiter.name, 1]]]);
	expect(await usage(limiter)).toEqual(before);
	expect(await redisXClient.HEXISTS(blockKey, `${limiter.name}:subject`)).toBe(
		false,
	);
	expect(await hit(limiter, 3)).toBeNull();
	expect(await usage(limiter)).toEqual({ used: 1, deadline: timestamp + 13 });
});

test('stores integer counts while retaining fractional refill in the deadline', async () => {
	const limiter = createLimiter({ limit: 3, ttl: 10 });
	expect(await hit(limiter)).toBeNull();
	expect(await usage(limiter)).toEqual({ used: 1, deadline: timestamp + 4 });
	expect(await hit(limiter, 1)).toBeNull();
	expect(await usage(limiter)).toEqual({ used: 2, deadline: timestamp + 7 });
	expect(await hit(limiter, 2)).toBeNull();
	expect(await usage(limiter)).toEqual({ used: 3, deadline: timestamp + 10 });
});

test('rounds cumulative refill durations to 4, 7, and 10 seconds', async () => {
	const limiter = createLimiter({ limit: 3, ttl: 10 });
	for (const [index, duration] of [4, 7, 10].entries()) {
		expect(await hit(limiter)).toBeNull();
		expect(await usage(limiter)).toEqual({
			used: index + 1,
			deadline: timestamp + duration,
		});
	}

	expect(await hit(limiter)).toEqual([1, [[limiter.name, 4]]]);
	expect(await usage(limiter)).toEqual({ used: 3, deadline: timestamp + 10 });
});

test('rebases repeated cycles without losing refill progress or growing the counter', async () => {
	const limiter = createLimiter({ limit: 3, ttl: 10 });
	for (let count = 0; count < 3; count += 1) {
		expect(await hit(limiter)).toBeNull();
	}

	for (let count = 4; count <= 300; count += 1) {
		const elapsed = Math.ceil(((count - 3) * 10) / 3);
		expect(await hit(limiter, elapsed - 1)).toEqual([1, [[limiter.name, 1]]]);
		expect(await hit(limiter, elapsed)).toBeNull();
		expect(await usage(limiter)).toEqual({
			used: ((count - 1) % 3) + 1,
			deadline: timestamp + Math.ceil((count * 10) / 3),
		});
	}
});

test.each([10, 100])(
	'restores full capacity after %i seconds idle',
	async (offset) => {
		const limiter = createLimiter({ limit: 3, ttl: 10 });
		for (let count = 0; count < 3; count += 1) {
			expect(await hit(limiter)).toBeNull();
		}

		for (let count = 1; count <= 3; count += 1) {
			expect(await hit(limiter, offset)).toBeNull();
			expect(await usage(limiter)).toEqual({
				used: count,
				deadline: timestamp + offset + Math.ceil((count * 10) / 3),
			});
		}

		expect(await hit(limiter, offset)).toEqual([1, [[limiter.name, 4]]]);
	},
);

test.each([
	{ limit: 1, ttl: 1 },
	{ limit: 1, ttl: 5 },
	{ limit: 3, ttl: 10 },
	{ limit: 3, ttl: 14 },
	{ limit: 7, ttl: 3 },
	{ limit: 10, ttl: 60 },
])(
	'matches continuous refill for $limit tokens per $ttl seconds',
	async (options) => {
		const limiter = createLimiter(options);
		let available = options.limit * options.ttl;
		for (let elapsed = 0; elapsed <= options.ttl * 2; elapsed += 1) {
			if (elapsed > 0) {
				available = Math.min(
					options.limit * options.ttl,
					available + options.limit,
				);
			}

			for (let attempt = 0; attempt <= options.limit; attempt += 1) {
				const result = await hit(limiter, elapsed);
				if (available >= options.ttl) {
					expect(result).toBeNull();
					available -= options.ttl;
				} else {
					expect(result).toEqual([
						1,
						[
							[
								limiter.name,
								Math.ceil((options.ttl - available) / options.limit),
							],
						],
					]);
				}
			}
		}
	},
);

test('keeps independent buckets for limiting IDs in one hash', async () => {
	const limiter = createLimiter({ limit: 1, ttl: 10 });
	expect(await hit(limiter, 0, 'first')).toBeNull();
	expect(await hit(limiter, 0, 'first')).toEqual([1, [[limiter.name, 10]]]);
	expect(await hit(limiter, 0, 'second')).toBeNull();
	expect(await redisXClient.HLEN(limiter.key)).toBe(2);
});

test('keeps a separate block active after the bucket refills', async () => {
	const limiter = createLimiter({ limit: 1, ttl: 5, block: 30 });
	expect(await hit(limiter)).toBeNull();
	const before = await usage(limiter);
	expect(await hit(limiter)).toEqual([1, [[limiter.name, 30]]]);
	expect(
		await redisXClient.sendCommand(
			'HEXPIRETIME',
			blockKey,
			'FIELDS',
			'1',
			`${limiter.name}:subject`,
		),
	).toEqual([timestamp + 30]);
	const blocked = await hit(limiter, 10);
	expect(blocked).toEqual([1, [[limiter.name, expect.any(Number)]]]);
	expect(await usage(limiter)).toEqual(before);
});

test.each([
	{ reverse: false, used: false },
	{ reverse: true, used: false },
	{ reverse: false, used: true },
	{ reverse: true, used: true },
])(
	'does not write token state in a rejected batch ($reverse, $used)',
	async (options) => {
		const bucket = createLimiter({ limit: 3, ttl: 10 });
		const fixed = createLimiter({ type: '1', limit: 1, ttl: 60 });
		expect(await hit(fixed)).toBeNull();
		if (options.used) {
			expect(await hit(bucket)).toBeNull();
		}

		const before = await usage(bucket);
		const entries = options.reverse ? [fixed, bucket] : [bucket, fixed];
		expect(await hit(entries, 1)).toEqual([
			1,
			[[fixed.name, expect.any(Number)]],
		]);
		expect(await usage(bucket)).toEqual(before);
	},
);

test.each([false, true])(
	'does not consume companion quota when tokens are exhausted (%s)',
	async (reverse) => {
		const bucket = createLimiter({ limit: 1, ttl: 10 });
		const fixed = createLimiter({ type: '1', limit: 1, ttl: 60 });
		expect(await hit(bucket)).toBeNull();
		const entries = reverse ? [fixed, bucket] : [bucket, fixed];
		expect(await hit(entries)).toEqual([1, [[bucket.name, 10]]]);
		expect(await redisXClient.HGET(fixed.key, 'subject')).toBeNull();
	},
);

test('records an accepted mixed batch', async () => {
	const bucket = createLimiter({ limit: 2, ttl: 10 });
	const fixed = createLimiter({ type: '1', limit: 2, ttl: 60 });
	expect(await hit([bucket, fixed])).toBeNull();
	expect(await usage(bucket)).toEqual({ used: 1, deadline: timestamp + 5 });
	expect(await redisXClient.HGET(fixed.key, 'subject')).toBe('1');
});

test('uses Redis time and naturally expired fields in the normal script', async () => {
	const limiter = createLimiter({ limit: 2, ttl: 10 });
	await redisXClient.HSET(limiter.key, 'subject', '2');
	await redisXClient.sendCommand(
		'HEXPIREAT',
		limiter.key,
		'1',
		'FIELDS',
		'1',
		'subject',
	);
	expect(await redisXClient.HGET(limiter.key, 'subject')).toBeNull();
	const before = (await redisXClient.sendCommand('TIME')) as string[];
	expect(
		await redisXClient.EVAL(
			[lua_time, lua_prepare, lua_hit].join('\n'),
			[blockKey, limiter.key],
			['subject', 'hit', '4', limiter.name, '2', '10', '-1'],
		),
	).toBeNull();
	const after = (await redisXClient.sendCommand('TIME')) as string[];
	const current = await usage(limiter);
	expect(current.used).toBe(1);
	expect(current.deadline).toBeGreaterThanOrEqual(Number(before[0]) + 5);
	expect(current.deadline).toBeLessThanOrEqual(Number(after[0]) + 5);
});

test.each([1, 2_147_483_647])(
	'preserves the final token at maximum capacity with ttl %i',
	async (ttl) => {
		const limiter = createLimiter({ limit: Number.MAX_SAFE_INTEGER, ttl });
		await redisXClient.HSET(limiter.key, 'subject', String(limiter.limit - 1));
		await redisXClient.sendCommand(
			'HEXPIREAT',
			limiter.key,
			String(timestamp + ttl),
			'FIELDS',
			'1',
			'subject',
		);

		expect(await hit(limiter)).toBeNull();
		expect(await redisXClient.HGET(limiter.key, 'subject')).toBe(
			String(limiter.limit),
		);
		expect(await hit(limiter)).toEqual([1, [[limiter.name, 1]]]);
	},
);
