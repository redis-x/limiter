# @redis-x/limiter

[![npm version](https://img.shields.io/npm/v/@redis-x/limiter.svg)](https://www.npmjs.com/package/@redis-x/limiter)
[![license](https://img.shields.io/npm/l/@redis-x/limiter.svg?color=blue)](https://github.com/redis-x/limiter/blob/main/LICENSE)

A robust rate limiter implemented with Redis for Node.js applications.

## Features

- 🚀 **High Performance**: Efficient implementation using Redis atomic operations via Lua scripts
- 🔄 **Multiple Limiter Types**: Support for both counter-based and unique elements (set-based) limiters
- ⏱️ **Configurable TTL**: Set time limits for both counter expiration and blocking periods
- 🛠️ **Flexible API**: Check, hit, get, and reset rate limits with a clean interface
- 🔒 **Type-Safe**: Written in TypeScript with full type definitions

## Installation

```bash
bun i @redis-x/limiter redis
# or with pnpm
pnpm add @redis-x/limiter redis
# or with npm
npm install @redis-x/limiter redis
```

## Usage

### Basic Example

```typescript
import { createClient } from 'redis';
import { RedisXLimiter, RedisXLimiterLimitExceededError } from '@redis-x/limiter';

// Initialize Redis client
const redisClient = createClient({
  url: 'redis://localhost:6379'
});
await redisClient.connect();

// Create a rate limiter
const limiter = new RedisXLimiter(redisClient, {
  namespace: 'my-app',
  limits: {
    requests: {
      type: 'counter',
      limit: 100,      // Allow 100 requests...
      ttl: 3600,       // ...within 1 hour (in seconds)
      ttl_block: 7200, // Block for 2 hours when limit is exceeded
    },
  },
});

// Use in your API route
async function handleRequest(userId) {
  try {
    // Will throw RedisXLimiterLimitExceededError if limit is exceeded
    await limiter.hit(userId);

    // Process request here...
    return { success: true };
  }
  catch (error) {
    if (error instanceof RedisXLimiterLimitExceededError) {
      // Handle rate limit exceeded
      return {
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: error.ttl
      };
    }
    throw error;
  }
}
```

### Using Set-Based Limiters

With set-based limiters, you can limit the number of unique elements in the time frame. For example, you can limit the number of user profiles (set elements) fetched from a single IP address (key).

```typescript
const limiter = new RedisXLimiter(redisClient, {
  namespace: 'api',
  limits: {
    // Limit total requests
    requests: {
      type: 'counter',
      limit: 1000,
      ttl: 3600,
    },
    // Limit unique user IDs fetched from a single IP address
    unique_user_ids: {
      type: 'set',
      limit: 20,  // Allow 20 unique user profiles fetched
      ttl: 86400, // Within 24 hours
    }
  }
});

// Hit the limiter with a specific element
await limiter.hit(ip_address, user_id);
```

### Custom Error Handling

You can specify custom error handling for each limit.

```typescript
const limiter = new RedisXLimiter(redisClient, {
  namespace: 'api',
  limits: {
    requests: {
      type: 'counter',
      limit: 100,
      ttl: 3600,
      onError: (ttl) => {
        // Custom error handling
        return new CustomRateLimitError('Too many requests', ttl);
      }
    }
  }
});
```

### Checking Without Incrementing

You can check if the user would exceed limits without incrementing counters. This method would throw exactly the same error as the `hit` method.

```typescript
try {
  await limiter.check(userId);
  // User is within limits
} catch (error) {
  if (error instanceof RedisXLimiterLimitExceededError) {
    // User would exceed limits
    console.log(`Limit exceeded for ${error.limit_name}, retry after ${error.ttl}s`);
  }
}
```

### Getting Current Limit State

Call `limiter.get(<key>)` to retrieve current limits for a given key.

```typescript
const limits = await limiter.get(userId);
/*
Example response:
{
  requests: {
    counter: 42,
    ttl: 1800
  },
  uniqueIps: {
    counter: 5,
    ttl: 43200
  }
}
*/
```

### Resetting Limits

```typescript
// Reset a specific limit
await limiter.reset(userId, 'requests');

// Reset all limits for a user
await limiter.resetAll(userId);
```
