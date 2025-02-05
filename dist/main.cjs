var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/main.ts
var exports_main = {};
__export(exports_main, {
  RedisXLimiterLimitExceededError: () => RedisXLimiterLimitExceededError,
  RedisXLimiter: () => RedisXLimiter
});
module.exports = __toCommonJS(exports_main);

// src/limiter.ts
var import_client = require("@redis-x/client");
var v2 = __toESM(require("valibot"));

// src/utils/errors.ts
class RedisXLimiterLimitExceededError extends Error {
  key;
  limit_name;
  ttl;
  constructor(key, limit_name, ttl) {
    super(`[RedisXLimiter] Limit for key "${key}" exceeded.`);
    this.key = key;
    this.limit_name = limit_name;
    this.ttl = ttl;
    this.key = key;
    this.limit_name = limit_name;
    this.ttl = ttl;
  }
}

// src/utils/import-lua.ts
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_meta_url = `file://${__filename}`;
var current_dir = import_node_path.default.dirname(import_node_url.fileURLToPath(import_meta_url));
var package_root_dir_promise = (async () => {
  let current_lookup_dir = current_dir;
  while (true) {
    const package_json_path = import_node_path.default.join(current_lookup_dir, "package.json");
    try {
      await import_promises.default.stat(package_json_path);
      return current_lookup_dir;
    } catch {
      current_lookup_dir = import_node_path.default.join(current_lookup_dir, "..");
      if (current_lookup_dir === "/") {
        throw new Error("Could not find package.json");
      }
    }
  }
})();
async function importLua(path) {
  const content = await import_promises.default.readFile(import_node_path.default.join(await package_root_dir_promise, "lua", path), "utf8");
  return content.replaceAll(/--.*\n/g, "").replaceAll(/\s+/g, " ").trim();
}

// src/utils/validators.ts
var v = __toESM(require("valibot"));
var ValiHitSchema = v.union([
  v.strictTuple([]),
  v.strictTuple([
    v.pipe(v.number(), v.integer(), v.minValue(0)),
    v.pipe(v.number(), v.integer(), v.minValue(0))
  ])
]);
var ValiGetSchema = v.array(v.tuple([
  v.pipe(v.number(), v.integer(), v.minValue(-1)),
  v.pipe(v.number(), v.integer(), v.minValue(0))
]));

// src/limiter.ts
var REDIS_PREFIX = "@x:limiter";
var script_hit_promise = importLua("hit.lua");
var script_get_promise = importLua("get.lua");

class RedisXLimiter {
  redisXClient;
  namespace;
  uses_set = false;
  limit_names = [];
  redis_args = [];
  error_handlers = new Map;
  constructor(client, options) {
    if (client instanceof import_client.RedisXClient) {
      this.redisXClient = client;
    } else {
      this.redisXClient = new import_client.RedisXClient(client);
    }
    this.namespace = options.namespace;
    for (const [limit_name, data] of Object.entries(options.limits)) {
      this.limit_names.push(limit_name);
      if (data.type === "set") {
        this.uses_set = true;
      }
      this.redis_args.push(data.type === "counter" ? "0" : "1", String(data.limit), String(data.ttl), String(data.ttl_block ?? 0));
      if (typeof data.onError === "function") {
        this.error_handlers.set(limit_name, data.onError);
      }
    }
  }
  getRedisKeys(key, limit_names = this.limit_names) {
    return limit_names.map((limit_name) => `${REDIS_PREFIX}:${this.namespace}:${key}:${limit_name}`);
  }
  createError(key, limit_name, ttl) {
    const error_handler = this.error_handlers.get(limit_name);
    if (typeof error_handler === "function") {
      error_handler(ttl);
    }
    throw new RedisXLimiterLimitExceededError(key, limit_name, ttl);
  }
  async hit(key, ...elements) {
    if (this.uses_set && elements.length === 0) {
      throw new Error("Elements are required for set limiters.");
    }
    const script_hit = await script_hit_promise;
    const response = v2.parse(ValiHitSchema, await this.redisXClient.EVAL(script_hit, this.getRedisKeys(key), [
      ...this.redis_args,
      ...elements
    ]));
    if (response.length === 2) {
      const [limit_name_index, ttl] = response;
      this.createError(key, this.limit_names[limit_name_index], ttl);
    }
  }
  async get(key) {
    const script_get = await script_get_promise;
    const result = v2.parse(ValiGetSchema, await this.redisXClient.EVAL(script_get, this.getRedisKeys(key)));
    const response = {};
    for (const [index, limit_name] of this.limit_names.entries()) {
      const [counter, ttl] = result[index];
      if (counter === -1) {
        response[limit_name] = {
          ttl
        };
      } else if (ttl === 0) {
        response[limit_name] = {
          counter: 0
        };
      } else {
        response[limit_name] = {
          counter,
          ttl
        };
      }
    }
    return response;
  }
  async check(key) {
    const state = await this.get(key);
    let blocked_limit_name = "";
    let blocked_ttl = 0;
    for (const [
      limit_name,
      limit_state
    ] of Object.entries(state)) {
      if ("counter" in limit_state === false && limit_state.ttl > blocked_ttl) {
        blocked_limit_name = limit_name;
        blocked_ttl = limit_state.ttl;
      }
    }
    if (blocked_ttl > 0) {
      this.createError(key, blocked_limit_name, blocked_ttl);
    }
  }
  async reset(key, ...limit_names) {
    await this.redisXClient.DEL(...limit_names.length > 0 ? this.getRedisKeys(key, limit_names) : this.getRedisKeys(key));
  }
}
