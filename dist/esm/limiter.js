import { RedisXClient } from '@redis-x/client';
import * as v from 'valibot';
import { RedisXLimiterLimitExceededError } from './utils/errors.js';
import { importLua } from './utils/import-lua.js';
import { ValiGetSchema, ValiHitSchema, } from './utils/validators.js';
const REDIS_PREFIX = '@x:limiter';
// const SCRIPT_HIT = await readFile(
// 	new URL('hit.lua', import.meta.url).pathname,
// 	'utf8',
// );
// console.log('SCRIPT_HIT', SCRIPT_HIT);
const script_hit_promise = importLua('hit.lua');
const script_get_promise = importLua('get.lua');
export class RedisXLimiter {
    redisXClient;
    namespace;
    uses_set = false;
    limit_names = [];
    redis_args = [];
    error_handlers = new Map();
    /**
     * @param client Redis client.
     * @param {object} options Options.
     * @param {string} options.namespace Namespace of the limiter.
     * @param {L} options.limits Limits.
     */
    constructor(client, options) {
        if (client instanceof RedisXClient) {
            this.redisXClient = client;
        }
        else {
            this.redisXClient = new RedisXClient(client);
        }
        this.namespace = options.namespace;
        for (const [limit_name, data] of Object.entries(options.limits)) {
            this.limit_names.push(limit_name);
            if (data.type === 'set') {
                this.uses_set = true;
            }
            this.redis_args.push(data.type === 'counter'
                ? '0'
                : '1', String(data.limit), String(data.ttl), String(data.ttl_block ?? 0));
            if (typeof data.onError === 'function') {
                this.error_handlers.set(limit_name, data.onError);
            }
        }
    }
    getRedisKeys(key, limit_names = this.limit_names) {
        return limit_names.map((limit_name) => `${REDIS_PREFIX}:${this.namespace}:${key}:${limit_name}`);
    }
    /**
     * Creates an error.
     * @param key Limit key.
     * @param limit_name Limit name.
     * @param ttl Time-to-live.
     */
    createError(key, limit_name, ttl) {
        const error_handler = this.error_handlers.get(limit_name);
        if (typeof error_handler === 'function') {
            error_handler(ttl);
        }
        throw new RedisXLimiterLimitExceededError(key, limit_name, ttl);
    }
    /**
     * Hits the limiter.
     * @param key Limiter key to hit.
     * @param elements Elements to use instead of plain counters.
     */
    async hit(key, ...elements) {
        if (this.uses_set
            && elements.length === 0) {
            throw new Error('Elements are required for set limiters.');
        }
        const script_hit = await script_hit_promise;
        // console.log('script_hit', script_hit);
        const response = v.parse(ValiHitSchema, await this.redisXClient.EVAL(script_hit, this.getRedisKeys(key), [
            ...this.redis_args,
            ...elements,
        ]));
        // console.log('response', response);
        if (response.length === 2) {
            const [limit_name_index, ttl] = response;
            this.createError(key, this.limit_names[limit_name_index], ttl);
        }
    }
    /**
     * Gets the limiter.
     * @param key Limiter key to get.
     * @returns -
     */
    async get(key) {
        const script_get = await script_get_promise;
        // console.log('script_get', script_get);
        const result = v.parse(ValiGetSchema, await this.redisXClient.EVAL(script_get, this.getRedisKeys(key)));
        const response = {};
        for (const [index, limit_name] of this.limit_names.entries()) {
            const [counter, ttl] = result[index];
            // block
            if (counter === -1) {
                response[limit_name] = {
                    ttl,
                };
            }
            // limiter has not been hit
            else if (ttl === 0) {
                response[limit_name] = {
                    counter: 0,
                };
            }
            else {
                response[limit_name] = {
                    counter,
                    ttl,
                };
            }
        }
        return response;
    }
    /**
     * Checks if the key is within the limits.
     * @param key Limiter key to check.
     */
    async check(key) {
        const state = await this.get(key);
        let blocked_limit_name = '';
        let blocked_ttl = 0;
        for (const [limit_name, limit_state,] of Object.entries(state)) {
            if ('counter' in limit_state === false
                && limit_state.ttl > blocked_ttl) {
                blocked_limit_name = limit_name;
                blocked_ttl = limit_state.ttl;
            }
        }
        if (blocked_ttl > 0) {
            this.createError(key, blocked_limit_name, blocked_ttl);
        }
    }
    /**
     * Resets the limiter.
     * @param key Limiter key to reset.
     * @param limit_names Limit name.
     */
    async reset(key, ...limit_names) {
        await this.redisXClient.DEL(...limit_names.length > 0
            ? this.getRedisKeys(key, limit_names)
            : this.getRedisKeys(key));
    }
}
