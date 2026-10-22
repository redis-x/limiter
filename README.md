# @redis-x/limiter

[![npm version](https://img.shields.io/npm/v/@redis-x/limiter.svg)](https://www.npmjs.com/package/@redis-x/limiter)
[![license](https://img.shields.io/npm/l/@redis-x/limiter.svg?color=blue)](https://github.com/redis-x/limiter/blob/main/LICENSE)

A robust rate limiter implemented with Redis for Node.js applications.

## Features

- 🚀 **High Performance**: Efficient implementation using Redis atomic operations via Lua scripts
- 🔄 **Multiple Limiter Types**: Fixed window, sliding window (exact or approximate) and token bucket
- ⏱️ **Configurable TTL**: Set time limits for both counting windows and blocking periods
- 🛠️ **Flexible API**: Check, hit, and get limits one by one or in atomic batches
- 🔒 **Type-Safe**: Written in TypeScript with full type definitions

## Installation

```bash
bun i @redis-x/limiter redis
# or with pnpm
pnpm add @redis-x/limiter redis
# or with npm
npm install @redis-x/limiter redis
```

**Requirements**:

- Node.js 22 or newer;
- `redis@^4.6`;
- (optional) [`@redis-x/client`](https://github.com/redis-x/client);
- Redis server **7.4** or newer.

## Usage

### Basic Example

```typescript
import {
  RedisXLimiter,
  RedisXLimiterExceededError,
  RedisXLimiterType,
} from '@redis-x/limiter';
import { createClient } from 'redis';

// Initialize Redis client
const redisClient = createClient({
  url: 'redis://localhost:6379'
});
await redisClient.connect();

// Create a rate limiter
const limiter = new RedisXLimiter(redisClient, {
  type: RedisXLimiterType.FixedWindow,
  name: 'requests',
  limit: 100,      // Allow 100 requests...
  ttl: 3600,       // ...within 1 hour (in seconds)
  block_ttl: 7200, // Block for 2 hours when limit is exceeded
});

// Use in your API route
async function handleRequest(userId: string) {
  try {
    // Will throw RedisXLimiterExceededError if limit is exceeded
    await limiter.hit(userId);

    // Process request here...
    return { success: true };
  }
  catch (error) {
    if (error instanceof RedisXLimiterExceededError) {
      // Handle rate limit exceeded
      return {
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: error.ttl, // in seconds
      };
    }
    throw error;
  }
}
```

Limiters accept either a plain `redis` client or a `RedisXClient` from [`@redis-x/client`](https://github.com/redis-x/client) package. If you already use `RedisXClient` in your project, pass it to the constructor to avoid duplicating `RedisXClient` instances.

Without `block_ttl`, hits are rejected only until the quota recovers.

Limiter names must be unique within a process. Names and string keys can contain only letters, digits and `._+-`, and must start and end with a letter or digit, so replace `:` in IPv6 addresses.

### Limiter Types

| Type                          | Meaning of `limit` and `ttl`                                                    |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `FixedWindow`                 | `limit` hits per `ttl`-second window, aligned to the clock                      |
| `FixedWindowUserDefinedStart` | Same, but each key's window starts with its first hit                           |
| `SlidingWindow`               | `limit` distinct hits within the last `ttl` seconds                             |
| `SlidingWindowApproximate`    | `limit` hits within the last `ttl` seconds, estimated from two fixed windows    |
| `TokenBucket`                 | `limit` tokens that refill from empty to full in `ttl` seconds                  |

### Counting Distinct Hits

With a `SlidingWindow` limiter, you can limit the number of distinct elements in the time frame. For example, you can limit the number of user profiles (hit IDs) fetched from a single IP address (key). Repeating a hit ID that is still in the window doesn't use another slot.

```typescript
const profiles = new RedisXLimiter(redisClient, {
  type: RedisXLimiterType.SlidingWindow,
  name: 'profiles',
  limit: 20,  // Allow 20 unique user profiles fetched
  ttl: 86400, // Within 24 hours
});

// Hit the limiter with a specific element
const { is_hit_unique } = await profiles.hit(ip_address, user_id);
// is_hit_unique is false if this user ID is still counted in the window
```

### Combining Limiters

`RedisXLimitersBatch` runs several limiters in one atomic Redis script. A hit counts for all limiters or for none: if any limiter rejects it, no quota is used, but limiters with `block_ttl` that this hit exceeds still start their blocks.

```typescript
import { RedisXLimitersBatch } from '@redis-x/limiter';

const requests = new RedisXLimiter(redisClient, {
  type: RedisXLimiterType.TokenBucket,
  name: 'api-requests',
  limit: 1000,
  ttl: 3600,
});
const batch = new RedisXLimitersBatch(requests, profiles);

await batch.hit(ip_address, user_id);
```

All limiters in a batch must be created with the same client. A successful hit returns the limiter with the fewest remaining hits. A rejected hit reports one blocked limiter, chosen by priority.

### Priority

When several limiters in a batch are blocked, `error.limiter` and `error.ttl` describe the one with the highest `priority`, or the longest `ttl` among equal priorities. Limiters without `priority` rank highest. Priority only changes what is reported: every block stays enforced.

Use it to report the most important block first. For example, give a short block that users must wait out a higher priority than a long block that your app presents as a CAPTCHA. Users see the CAPTCHA only after the short block expires.

```typescript
const attempts = new RedisXLimiter(redisClient, {
  type: RedisXLimiterType.FixedWindow,
  name: 'login-attempts',
  priority: 100,
  limit: 10,
  ttl: 60,
  block_ttl: 60,
});
const usernames = new RedisXLimiter(redisClient, {
  type: RedisXLimiterType.SlidingWindow,
  name: 'login-usernames',
  priority: 10,
  limit: 5,
  ttl: 3600,
  block_ttl: 3600,
});

try {
  await new RedisXLimitersBatch(attempts, usernames).hit(ip_address, username);
} catch (error) {
  if (error instanceof RedisXLimiterExceededError && error.limiter === usernames) {
    // Show a CAPTCHA
  }
}
```

### Checking Without Incrementing

`check()` returns whether a hit would be accepted right now, without counting it. It doesn't reserve anything, so a later `hit()` can still fail.

```typescript
if (await limiter.check(userId)) {
  // User is within limits
}
```

### Getting Current Limit State

Call `limiter.get(<key>)` to retrieve the current state for a given key without changing it.

```typescript
const state = await limiter.get(userId);
/*
Example response within limits, where `ttl` is seconds until the quota fully recovers:
{ limiter, remaining: 58, ttl: 1800, is_hit_unique: true }

Example response when limited, where `ttl` is seconds until a hit can succeed:
{ limiter, ttl: 120 }
*/
```

For a batch, `get()` selects a limiter the same way as `hit()`, and `getAll()` returns the state of every limiter.
