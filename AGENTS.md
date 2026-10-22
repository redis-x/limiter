# Limiter redesign: agent instructions and design record

Last updated: 2026-10-22.

## Working agreement

- Keep this file current as the user makes requests and decisions about the redesign. Update it during subsequent design discussions.
- Do not write or change implementation code until the user explicitly asks. Maintaining this design document is authorized.
- Distinguish user decisions and proposals from assistant recommendations, technical findings, and unresolved questions. Do not turn an assistant suggestion into an accepted requirement without user agreement.
- Treat this as the intended new design, not documentation of behavior already implemented. Preserve unrelated existing work.
- Prefer the latest explicit user decision when it supersedes an earlier discussion.
- Tests must import and use the shared `redisXClient` from `test/redis.ts`. Create additional clients only when the test specifically exercises behavior involving different clients. Individual suites must not connect or disconnect the shared instance.
- Organize tests by limiter type, rather than public method. Keep tests minimal and exercise the public product API, not Redis behavior or isolated script parts. The current fixed-window suites cover single limiters only; batching is outside this request.
- Latest batch-test request (2026-10-22): add one mixed batch scenario verifying class execution, returned objects, and persisted Redis state. Reuse the individual suites for algorithm-specific conditions instead of duplicating their matrices in batch tests.
- Tests must assert both public method results and Redis state: hash fields, values, field expirations, and key expiration where applicable, including `_block`. Prepare starting state directly in Redis, then exercise real public methods. Verify deadlines written by the library and handling of expired state; test obsolete sorted-set member removal when those types are implemented.
- Use one test per condition, with two reusable, descriptively named limiter instances per type (with and without block_ttl). Wipe the dedicated Redis database between tests and set up each condition from scratch inside its test. Keep shared-database tests sequential; UUID names and long lifecycle waits are unnecessary for these suites.

## Terminology

| Term | Meaning |
| --- | --- |
| Limiter name | Identifies a limiter and its rules, such as the hits limit, window size, blocking TTL, and reporting priority. The blocking TTL can be longer than the counting window. |
| Limiting ID | Identifies what is being limited under a limiter name: an IP address, user ID, or another subject. |
| Hit ID | Identifies a hit or resource. It can be randomly generated or supplied by the caller. Reusing a caller-defined resource ID allows repeated access without counting it as another distinct ID while it remains in the relevant window. |
| Limiter priority | Determines which active block is reported by a batch. Higher priority wins; among blocks at that priority, the largest remaining block TTL wins. Priority does not exempt lower-priority limiters from enforcement. |

The user's storage descriptions also use "limiter ID." In the layouts below this denotes the identifier of the named limiter, not the limiting ID. Whether "limiter name" and "limiter ID" are exact aliases in the public API remains to be confirmed.

A fresh random hit ID for each recorded event enables ordinary hit counting in the sliding-window representation; a stable caller-defined hit ID enables distinct-value counting. ID generation details and public property names are not finalized.

## Motivation and scope

- Support the fixed-window, sliding-window, approximate sliding-window, and token-bucket variations discussed in [Visualizing algorithms for rate limiting](https://smudge.ai/blog/ratelimit-algorithms).
- A motivating use case is failed authentication: limiter name identifies the rule, limiting ID is the source IP, and hit ID is the attempted username. Repeated failed attempts for one username count as one distinct username while it remains active. A configured threshold controls when an IP-wide authentication block is triggered; the user's proposed block-on-exceed policy is recorded below.
- The latest user proposal restricts distinct-value counting to the exact sliding-window limiter. Earlier discussion of unique-value fixed windows, approximate windows, or token buckets is not part of the current proposed scope.
- The user accepted sorted sets for exact sliding-window storage on 2026-10-19. The other algorithms retain the proposed Redis hashes with expiring fields. Blocks use the separately accepted uniform hash described below. Repeated hits refresh their deadlines, as accepted on 2026-10-20; some blocking lifecycle details remain open.

## Execution architecture: user decisions

- Use one Lua script with an operation argument: 1=get, 2=hit. Both public check methods use GET. Latest user correction on 2026-10-22: require no blocks and every usage row to have remaining > 0 or is_hit_unique false. is_hit_unique is always a boolean in JavaScript; only active repeated sliding-window IDs return false. Lua places the sliding-window flag after TTL, with -1 replacing absent TTL in replies.
- The shared script supports all limiter types and accepts a list of limiters with their parameters.
- Latest user direction (2026-10-21): check returns false when the proposed hit cannot occur, including quota exhaustion without a stored block. Get reports current states; usage duration means full quota recovery, while unavailable states report a retry duration. Hit must inspect other limiters even when stored blocks exist, so reporting can select among all relevant blockers. Detailed decisions and the proposed admission/write sequence are recorded in the latest section below.
- Checking or hitting multiple limiters together is a first-class requirement.
- The hit script performs its own checks before the relevant writes within the same execution. A prior separate check is not required for every hit and does not reserve capacity.
- Represent each limiter as a class instance with methods. Instances prepare/expose the keys and arguments required by the shared script execution path.
- Provide another class whose constructor accepts limiter instances and whose methods operate on the group.
- Single-limiter and group calls must use the same underlying function that executes the script. A single-limiter operation is a batch of one; a group gathers inputs for one script call rather than calling each member's public hit method separately.
- When reporting a blocked batch, select the active block with highest priority, breaking priority ties by largest remaining block TTL. Lower-priority blocks remain enforced but are hidden from the reported blocking result.
- Public method signatures and final outer response encoding remain in progress; the latest operation meanings and per-limiter status fields are recorded below.

## Time and expiration: user direction

- Obtain time from Redis at the beginning of Lua execution and use that captured time consistently for the hit, window calculations, and deadlines.
- Use absolute Unix expiration timestamps for window deadlines rather than recomputing relative durations at different points in the operation.
- Confirmed by the user on 2026-10-19: TTL in hash-based layouts means expiration of individual hash fields, not expiration of the entire Redis hash key. Exact sliding windows now use sorted sets; their member scores express logical expiration, with optional whole-key expiration for idle cleanup.
- The public time units and exact commands are not finalized. Millisecond field deadlines are supported by Redis through HPEXPIREAT; HPEXPIRETIME reads field expiration timestamps.
- Counting-window expiration, retention of previous-window data, bucket-full time, and blocking expiration are different concepts and must not be conflated.

## Current storage proposal from the user

This section records the proposed layout. It does not claim that all command-level behavior has been validated.

| Algorithm | Redis key identifies | Entry identifies | Stored state | Expiration |
| --- | --- | --- | --- | --- |
| Fixed window (hash) | Named limiter | Hash field: limiting ID | Usage representation not explicitly selected | Field expires at counting-window deadline |
| Exact sliding window (sorted set, accepted) | Named limiter and limiting ID | Member: hit ID | Proposed score: individual hit's absolute deadline | Score gives logical expiration; whole-key expiration can clean up idle state |
| Approximate sliding window (hash) | Named limiter | Hash field: window/epoch ID and limiting ID | Per-window usage representation not explicitly selected | Retain field for two window lengths so the previous window remains available |
| Token bucket (hash) | Named limiter | Hash field: limiting ID | Integer cumulative hit counter, rebased by whole capacities | Field expires at the first whole second when the bucket would be full without further hits |

### Fixed window

- Both clock-aligned windows and user-defined starts are intended.
- A user-defined start changes the expiration calculation only; it does not require a different storage layout.
- Whether a user-defined start means automatically starting on the first hit or an explicitly supplied anchor still needs a precise API definition.

### Exact sliding window

- This is the only limiter type intended to support counting distinct values.
- The user accepted a sorted set per named limiter and limiting ID, superseding the original hash-per-subject proposal.
- Each hit ID is a sorted-set member. The reviewed representation uses its score as an absolute deadline and counts active scores rather than relying on physical expiration cleanup.
- Repeated use of a hit ID must not add another distinct entry while that ID is active.
- Accepted on 2026-10-20: each accepted repeated hit refreshes the member's deadline to the captured current time plus the window length, without increasing cardinality. An active ID can therefore be refreshed even when unique capacity is exhausted. Existing blocks still deny access, and a rejected batch does not apply queued refreshes.

### Approximate sliding window

- Read the fields for the current and previous epochs of the same limiting ID to calculate the result.
- Retain each epoch's field for two window lengths.
- The user's prototype reviewed on 2026-10-20 weights the previous count by `1 - (ts % ttl) / ttl`, then adds the current count. This is the standard two-window estimate.
- The user's follow-up implementation checks estimated usage including the incoming hit and retains each epoch until the end of the following window. Following explicit authorization, exhaustion-only responses now use the retry-time derivation below, rounded upward to whole seconds. Do not accidentally refresh an epoch's lifetime indefinitely on each hit.

### Token bucket

- Latest user decision: use integer hash values and adjust expiration, superseding the fractional used-token snapshots. One field per limiting ID stores a cumulative integer hit count; its expiration preserves refill progress.
- The implementation uses `limit` as capacity and `ttl` as the time to refill an empty bucket: refill rate is `limit / ttl` tokens per second. Fractional refill is represented through the counter and cumulative deadline calculation using the existing whole-second script clock.
- Recover a reference time from the count and full-refill deadline, increment the count, and round the cumulative refill duration once. The reference time is implicit; it does not need another field.
- Rebase the count by whole capacities and advance the reference time by the corresponding refill duration. This preserves refill progress and keeps stored counts between 1 and capacity. The reference time may be in the future, and the stored counter alone is not current outstanding usage.
- A candidate hit fits when its proposed full-refill deadline is at or before `ts + ttl`. Otherwise the excess seconds are its quota-recovery delay.
- Missing fields and fully refilled buckets have full capacity. Rejected hits do not update usage or extend its deadline. Existing block handling and deferred batch writes apply.
- Existing state assumes unchanged capacity and refill configuration. Clear the field before changing those parameters; migration across different configurations is not implemented.

## Blocking: user decisions

Confirmed on 2026-10-19.

| Part | Accepted meaning |
| --- | --- |
| Redis key | One separate, uniform library-wide blocking hash |
| Hash field | Combination of limiter name and limiting ID |
| Field value | Empty string; no payload is needed |
| Field expiration | Absolute block deadline, independent of counting-window expiration |

- All library instances use consistent naming rules without collisions.
- Confirmed on 2026-10-20: the current restricted name/ID syntax is intentional. Callers must replace prohibited characters, including colons in IPv6 addresses; do not relax the regex.
- Block presence denies access for the corresponding limiter and limiting ID even if the counting window has already expired. Empty string is an intentional value; presence or expiration metadata determines blocking, not a nonempty payload.
- A motivating use case is CAPTCHA enforcement for peers/bots exceeding a limit. A one-minute limiter may impose a one-hour block, with early release after successful CAPTCHA completion.
- The intended timed flow releases access when the block expires or a successful CAPTCHA clears it earlier. A CAPTCHA-only indefinite block is not part of this decision.
- The user wants access to resume with a fresh limiter window/usage after release, rather than immediately rejecting the peer because of pre-block usage. The exact reset/anchor behavior for clock-aligned windows and token buckets remains to be specified.
- Ordinary counting-window rollover must never clear an active block or restore access. CAPTCHA verification can cause an explicit early unblock; the public API and execution path for this operation are not yet selected.
- Confirmed on 2026-10-20: a future separate `reset` method will remove both the corresponding block and its usage counter. Keep counters when creating blocks for now; implementing reset is deferred.
- Clarified on 2026-10-20: when supplied, `block_ttl` is a strictly positive integer duration, just like `ttl`. Omission means the limiter supports quota exhaustion only, without a separate timed block. Pass -1 to Lua exclusively as the internal sentinel for this mode; neither -1 nor 0 is a valid public `block_ttl` value.

### Earlier assistant recommendation for the fresh-start lifecycle

The later user decision is to keep current block/counter behavior and add a separate reset method. The recommendations below are historical analysis, not authorization to clear usage when blocking.

- Clear the relevant limiter/subject usage atomically when creating its block, then leave that subject's usage untouched while the block is active. This is a proposed policy, not yet a user decision on handling blocked calls.
- With that policy, both natural block expiration and early CAPTCHA removal leave fresh quota for the next allowed hit. No expiration callback is needed to reset usage.
- Reset only the affected limiter/subject state, including all algorithm-specific usage that could influence the next decision; do not clear other subjects or unrelated limiters.
- If usage is retained or recorded during the block instead, early unblock must reset it atomically with removing the block, and automatic expiration needs a separate explicit reset strategy. Removing/expiring a field in the blocking hash does not itself reset state elsewhere.
- A fresh quota does not by itself define a new clock anchor: first-hit windows, clock-aligned windows, sliding windows, and token buckets need their respective restart semantics. Do not silently change existing alignment rules.
- The proposed lifecycle does not decide whether blocking one limiter affects recording for other limiters in the same batch.

## Batch block selection: user decisions

Confirmed on 2026-10-20 as a design decision. Implementation of priority has not been requested.

- Each limiter has a reporting priority. Among the active blocks relevant to the operation, find the highest priority, then select the largest remaining block TTL only within that priority.
- Return the selected limiter's identity with its own block deadline/remaining TTL. Do not combine the identity of one limiter with another limiter's TTL. Exact result field names are still undecided.
- Consider only active blocks when finding the highest priority. An unblocked higher-priority limiter must not hide a lower-priority block or make a blocked operation appear allowed.
- Lower-priority active blocks remain fully enforced and retain their expiration, but are invisible in the batch's reported blocking result. When higher-priority blocks expire or are explicitly lifted, the next evaluation may report a previously hidden block.
- Priority controls reporting, not permission to skip other limiter checks, clear their blocks, or bypass enforcement. It does not settle the outstanding policy for recording hits when any limiter rejects a batch.
- Use the same selection rule whenever check or hit reports blocked state, including any blocks newly created under the eventual hit policy. Compare deadlines/remaining TTLs against the same captured Redis time.
- The motivating use case is a CAPTCHA-removable block with a longer TTL than an unconditional waiting block. Returning only the globally largest TTL could prompt a CAPTCHA while waiting is still required. Priorities let the application present the waiting requirement first.
- The reported TTL describes the selected block, not necessarily the latest expiration of every active block. Expiration or removal of the selected block is not a promise that the entire batch becomes allowed.

### Recommended configuration and unresolved details

- Assistant recommendation: give unconditional waiting blocks higher priority than CAPTCHA-removable blocks when the CAPTCHA should only be presented after waiting is no longer required. Equal priorities still choose by TTL and can reproduce the original problem.
- Example configuration: an unconditional block with priority 100 and 120 seconds remaining wins over a CAPTCHA block with priority 10 and 3,600 seconds remaining. Once the unconditional block ends, the CAPTCHA block can become visible.
- Assistant recommendation: use an optional integer priority defaulting to zero, with larger values winning. The numeric domain and default are not yet user decisions. Equal default priorities preserve the largest-TTL selection rule.
- If both priority and remaining TTL are equal, the representative limiter needs deterministic tie-breaking. Using batch order is an assistant suggestion, not an accepted policy.
- Priority belongs to the limiter's configuration. Passing it with each limiter's script arguments is a proposed integration; keep the accepted blocking hash values empty. No priority argument or change to the existing five-field parser has been implemented.

## Quota exhaustion and block-on-exceed proposal (2026-10-20)

Status: the user proposed this policy and asked whether it is sound. The boundary rule is recommended by the assistant; the implications and refinements below are not yet finalized API decisions. No implementation changes were requested.

- The limit represents the number of hits allowed. Consuming exactly the limit exhausts capacity but does not itself create a block.
- With no existing active block, a read-only check at usage equal to the limit reports zero remaining hits and no block. It must not create a block, and absence of a block is not a guarantee that another hit fits.
- An attempted hit whose incremental cost exceeds available capacity triggers the configured block. For admission before an action, the exceeding hit is rejected; it is not an additional allowed hit.
- Example with limit 3: the first three unit-cost hits are accepted, leaving 2, 1, and 0 hits respectively. A check then reports zero and no active block. A fourth attempt before capacity recovers is rejected and creates the block.
- Evaluate incremental cost, not just whether the remaining count is zero. An already-active distinct hit ID costs zero additional unique capacity, while a new/expired ID costs one. An existing block still denies repeated IDs. Continuous refill or fractional approximate usage must also be considered at the hit's captured time.
- Creating a block does not require first storing a counter greater than the limit. Computing whether the candidate hit fits before mutation is sufficient; usage retention/reset remains a separate decision.
- A check is a snapshot and reserves no capacity. The hit must reevaluate capacity atomically. Blocked state, available capacity, and whether a proposed hit would fit are separate concepts.
- For post-event recording, such as a failed authentication already performed, the exceeding event has already occurred; the resulting block affects subsequent attempts. This differs from rejecting an action before it happens.

### Interaction with priority and CAPTCHA

- Selecting only existing active blocks can reintroduce the wasted-CAPTCHA problem under this proposal: a high-priority unconditional limiter can be exhausted but unblocked, while a lower-priority CAPTCHA block is active. After the CAPTCHA is solved, the next hit can exceed the high-priority limiter and create an unconditional block.
- Assistant recommendation: expose quota exhaustion or whether the proposed hit fits separately from persisted block state. When deciding which requirement to present, a higher-priority limiter that would deny that hit should take precedence over a lower-priority CAPTCHA, without making the read-only check create a block.
- A capacity-recovery deadline and a stored block deadline represent different reasons for waiting. Do not invent a block TTL merely because remaining capacity is zero.
- This is a proposed refinement of the earlier active-block-only reporting rule, not an accepted change to it. Exact check inputs/results, whether a hit ID is supplied for a prospective check, and how exhaustion participates in the reported priority remain unresolved.
- Batch usage mutation and creation of blocks for multiple simultaneously exceeded limiters remain separate outstanding policies.

## Outstanding behavior decisions

- Confirm the user's block-on-exceed proposal and define how higher-priority quota exhaustion interacts with lower-priority active blocks and CAPTCHA presentation.
- What exactly does check report: remaining usage, block state, whether proposed hits fit, or a combination?
- When one limiter rejects a batch, do the other limiters still record the hit? Distinguish admission of a proposed action from recording an event that already occurred. No policy has been selected.
- A separate reset method will remove both block and counter. Automatic block-expiration behavior and how a fresh start interacts with clock-aligned epochs and token-bucket refill remain unspecified; do not change current behavior while reset is deferred.
- Are blocked calls ignored or recorded, and can they extend the block?
- How are compound identifiers encoded without collisions, and how are duplicate limiter/subject entries in one batch handled?
- What is the priority's numeric domain/default, and which limiter represents an exact tie in priority and block expiration?
- What are the minimum supported Redis version, Cluster requirements, and per-limiter result/error conventions?

## Technical findings to preserve and validate

These are implementation constraints or findings, not additional user-selected features.

- Redis hash-field expiration and absolute field-expiration queries are available from Redis 7.4. A design using them needs a compatible Redis baseline or a separately agreed fallback. References: [HPEXPIREAT](https://redis.io/docs/latest/commands/hpexpireat/) and [HPEXPIRETIME](https://redis.io/docs/latest/commands/hpexpiretime/).
- Historical finding motivating the accepted sorted-set replacement: do not assume HLEN is an exact count of unexpired hit fields. In the Redis 7.4 source, hlenCommand calls hashTypeLength with subtractExpiredFields disabled, so expired fields awaiting removal can contribute to its result. Exact sliding-window checks now use the proposed active-score count instead. Reference: [Redis 7.4 hash implementation](https://github.com/redis/redis/blob/7.4/src/t_hash.c).
- Redis HSET overwrites clear the affected hash field's expiration. Reapply the intended absolute deadline after such a write; do not silently make the field persistent or accidentally start a new fixed window. Commands that modify a field without replacing it preserve its expiration. Reference: [Redis hash-field expiration rules](https://redis.io/docs/latest/commands/hexpire/).
- EVAL/EVALSHA scripts cannot invoke other scripts. Shared Lua logic can be assembled into both entry points; Redis Functions are another option. No packaging mechanism has been selected. Reference: [Redis Functions](https://redis.io/docs/latest/develop/programmability/functions-intro/).
- Redis executes a script atomically with respect to other clients, but a runtime error does not automatically roll back earlier writes. Validate inputs and expected state before mutation. Reference: [Redis rollback discussion](https://redis.io/blog/you-dont-need-transaction-rollbacks-in-redis/).
- Redis Cluster's normal script execution requires the declared keys to share a hash slot. The grouping/key-layout strategy must account for this if Cluster support is required. Reference: [Redis Lua API](https://redis.io/docs/latest/develop/programmability/lua-api/).

## Design review and sliding-window alternative (2026-10-19)

Status: the user requested a review of other logic/design flaws and an explanation of a sliding window without hashes, then accepted sorted-set storage. The detailed policies below remain analysis and recommendations unless separately confirmed.

### Findings and semantic decisions

- A block's deadline must be independent of the counting window or bucket-full deadline. The user selected a separate uniform block hash. Replacement was technically possible but is not the chosen design. The intended CAPTCHA flow resumes with fresh usage; cleanup timing and exact per-algorithm reset semantics remain to be specified.
- For a true count of distinct IDs seen during the preceding window, each repeated ID must refresh its last-seen time/deadline. Keeping only the first occurrence's deadline implements a different policy: deduplication for a fixed period after first observation. Example: with a ten-minute window, an ID hit at minute 0 and again at minute 9 must still count at minute 11 under last-seen semantics. The user subsequently selected deadline refresh on repeated hits on 2026-10-20.
- Capacity checks for distinct values must account for the incoming hit IDs. An already-active ID costs zero additional distinct capacity; a new or expired ID costs one. Deduplicate repeated IDs within a single call. An explicit block can still reject every hit regardless of its incremental cost. Public check inputs and threshold semantics remain undecided.
- A caller-defined hit ID used for resource deduplication is not automatically an idempotency key for the whole batch. Other counters might still increment and the sliding deadline might refresh. Fresh generated IDs should be sufficiently unique; timestamps alone can collide for separate hits occurring at the same instant.
- Batch mutation policy is still essential: admission may require checking every limiter before consuming any quota, while recording an observed failure may require updating every applicable limiter even if one triggers a block. Validate/coalesce or reject duplicate entries for the same limiter and limiting ID so that independently evaluated entries cannot overconsume shared capacity.
- Fixed-window deadlines must remain anchored to the intended window; resetting expiration to current time plus window length on every hit would instead extend the window indefinitely under traffic.
- For the ordinary approximate sliding counter, current and previous counts require overlap weighting, not an unweighted sum. A proposed deterministic field-retention deadline is epoch start plus two window lengths. Approximation can undercount or overcount clustered traffic; this is an algorithmic tradeoff rather than a guarantee of an exact sliding quota. No weighting formula has yet been accepted.
- The token bucket's full-time representation is mathematically valid for a fixed capacity C and a constant continuous refill rate r. If F is the absolute time when the bucket becomes full, current tokens at time t are C minus r times (F minus t), clamped to the range zero through C. Thus F can encode the balance for this model, with a missing/expired field meaning a full bucket. Stored balance versus deadline authority, precision, discrete refill, and configuration changes must still be specified. This formula is an analysis result, not a finalized implementation.
- One hash per limiter name concentrates all its limiting IDs in one Redis key and therefore one Cluster slot. Arbitrary atomic groups across different keys still require a same-slot placement strategy. This is a deployment/scaling tradeoff, not a standalone correctness defect.

### Accepted storage: sorted set per limiter and limiting ID

| Part | Proposed meaning |
| --- | --- |
| Redis key | Collision-safe encoding of limiter name and limiting ID |
| Sorted-set member | Hit ID |
| Sorted-set score | Absolute expiration timestamp in milliseconds |
| Optional whole-key expiration | Latest remaining member deadline, for idle cleanup |
| Block state | Accepted separate uniform hash, with one expiring field per limiter name and limiting ID |

A sorted-set member has no native individual TTL in this design. Its score expresses logical expiration.

- A hit is active when its score is strictly greater than the captured current time. A score equal to now is inactive. Keep this boundary consistent in both entry points.
- Read-only check: count active scores using ZCOUNT. Expired members awaiting cleanup cannot inflate this count, and the check need not delete anything or extend expiration.
- During the hit's mutation phase, remove scores at or before now with ZREMRANGEBYSCORE and add/update recorded members with ZADD.
- For the last-seen semantics accepted on 2026-10-20, update an accepted repeated member's score to now plus the window length. Membership remains unique while its deadline advances.
- Fresh random hit IDs count ordinary events; stable resource/username IDs count distinct values. Different members may share an identical score without being merged.
- Set the whole key's expiration no earlier than the maximum remaining member deadline. This removes idle state after all members become irrelevant. Keep a longer block independently alive.
- Use the same shared batch executor and captured time as the other algorithms. Choosing a different Redis data type does not require another public execution path.
- ZADD and ZCOUNT are O(log N); removing M expired members is O(log N + M). The tradeoff is one key per limiter/subject pair plus explicit cleanup during writes. Measure memory and latency before claiming an improvement over hashes.
- For an admission-style operation, read candidate membership and compute incremental distinct cost before deciding whether to mutate. For failure recording, apply the eventual observed-event policy. This alternative does not settle the existing batch policy question.

References: [ZADD](https://redis.io/docs/latest/commands/zadd/), [ZCOUNT](https://redis.io/docs/latest/commands/zcount/), and [ZREMRANGEBYSCORE](https://redis.io/docs/latest/commands/zremrangebyscore/).

The user accepted sorted-set storage and the separate uniform block hash on 2026-10-19, then accepted deadline refresh on repeated hits on 2026-10-20. Some batch policies and block lifecycle details remain open.

## Blocking-storage comparison and follow-up (2026-10-19)

### User assumptions and alternatives

- All library instances follow the same naming rules and do not collide. Evaluate the options under that assumption.
- Option A: replace a subject's hash-field counter with an "x" marker and give that field a block deadline; for exact sliding windows, replace the subject's entire sorted-set key with an "x" string and give the string key a block deadline.
- Option B: maintain a separate library-wide hash with fields identifying limiter name plus limiting ID, each with its own blocking expiration.
- The user selected option B, with an empty string value instead of the originally suggested marker. The comparison below records the reasoning; the accepted layout and CAPTCHA behavior are specified above.

### Comparison rationale and remaining implementation recommendations

- Option B provides uniform blocking behavior across all algorithms. Its now-accepted layout uses one library-wide hash, a field combining limiter name and limiting ID, an empty string value, and field expiration as the block deadline.
- A read-only lookup of the relevant fields or their expiration timestamps can detect blocks and report deadlines before algorithm-specific evaluation. HPEXPIRETIME supports multiple fields; no scan or total field count is needed.
- Keep block creation and the associated usage changes inside the existing atomic hit script. A separate Redis key does not require another client round trip.
- Earlier assistant advice favored preserving usage by default. The user's subsequent CAPTCHA use case requires a fresh window/usage when access resumes, so that advice is superseded for this flow. Separate storage still allows cleanup timing to be chosen independently of the block deadline.
- Example of a semantic difference: a quota is exhausted at second 10 in a window ending at second 60, and the block lasts five seconds. Replacement discards the old count and restores fresh capacity at second 15. Preservation keeps the old usage until second 60, so the next attempt may be rejected or blocked again under the eventual policy.
- The subsequent CAPTCHA requirement selects fresh usage on release for that flow. Even when the configured block is longer than the counting window, early CAPTCHA release makes explicit reset behavior necessary.
- Option A is valid when blocking intentionally discards history. It saves separate block entries and can release a sliding window's member storage immediately, at the cost of special marker/type handling and lost history.
- For hash counters, replace only the subject's field and set field expiration; converting the shared hash itself to a string would destroy other subjects' state. A sliding-window key belongs to one subject and can be replaced as a whole.
- Approximate sliding counters have epoch-specific fields. A marker only in the current epoch's field is not a durable subject-level block: after the epoch changes it can be missed. Option A would need a stable subject block location or additional handling that outlives all epoch transitions during the block.
- A single library-wide block hash is reasonable for a standalone Redis deployment. Under ordinary Redis Cluster script execution, the block hash and all usage keys touched by the script must share a slot. A universal block hash therefore concentrates those operations in one slot; if horizontal distribution becomes a requirement, partition block hashes together with the usage keys and atomic groups. Shared naming rules do not remove this placement constraint.
- Blocking storage is settled. Block extension on rejected calls, whether blocked events are recorded, cleanup timing, and public unblock/reset operations remain unresolved.

References: [HPEXPIREAT](https://redis.io/docs/latest/commands/hpexpireat/), [HPEXPIRETIME](https://redis.io/docs/latest/commands/hpexpiretime/), [SET](https://redis.io/docs/latest/commands/set/), and [Redis Cluster key placement](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/).

## Prototype review: batch clients and Lua imports (2026-10-20)

The user has started prototyping classes and Lua scripts and requested advice on client compatibility in batches and importing Lua as bundled text. The initial discussion did not authorize implementation changes. The user subsequently authorized the Lua build configuration and declaration described below; batch client compatibility remains a recommendation.

### Batch client compatibility

- The current prototype binds a Redis client to each RedisXLimiter instance through a private field. The proposed RedisXLimitersBatch constructor is currently commented out.
- Assistant recommendation for this API: require every limiter in a batch to reference the exact same Redis client object. Validate reference identity in the batch constructor, retain that client, and execute the shared hit/check script through it. No Redis round trip or comparison of credentials is needed for this guard.
- Provide an internal accessor or comparison method so batch construction can inspect client identity while preserving the private field. A separate batch class cannot directly access another class's JavaScript private field.
- Do not infer compatibility from matching host/port or connection URLs. Different objects can have different selected databases, authentication, or connection behavior even when they reach the same server. Rejecting distinct but otherwise compatible clients is a deliberate conservative API restriction, not a Redis requirement.
- A Lua invocation executes using one caller's authorization. It cannot combine permissions from the different clients bound to individual limiters. The executing client must be authorized for all commands and keys used by the batch, including the shared block hash.
- If support for distinct clients is later required, an explicit batch execution client is an alternative contract: the caller deliberately selects the authority and database for the entire operation. Do not silently substitute the first limiter's client for differently bound clients. Separate executions preserve individual credentials but lose the single atomic batch.
- Client identity does not replace the existing Redis Cluster same-slot requirement.

Reference: [Redis Lua ACL checks](https://redis.io/docs/latest/develop/programmability/lua-api/#redisacl_check_cmdcommand-arg).

### Importing Lua as bundled strings

- The prototype imports src/lua/time.lua from src/main.ts using a text import attribute. The package currently uses tsdown 0.23.0 and TypeScript 6.0.3; its build command produces ESM and CommonJS bundles plus declarations.
- Two independent issues were reproduced: TypeScript reports TS2307 because the Lua module has no corresponding declaration; the installed Rolldown backend attempts to parse the Lua file as JavaScript when only the text import attribute is supplied.
- Assistant recommendation: configure tsdown's loader mapping so the .lua extension uses the text loader. An ordinary default import can then supply the Lua source string; no custom file-reading plugin or runtime filesystem lookup is needed.
- Independently, include an ambient module declaration for the .lua extension whose default export is a string, or use per-file declarations with TypeScript's arbitrary-extension support. An import attribute alone does not provide the missing TypeScript module declaration.
- Verification used in-memory bundling with file writing and output cleanup disabled. With the text loader configured, tsdown generated the current library's ESM/CommonJS and declaration outputs. The currently unused Lua binding was eliminated; successful bundling alone therefore did not prove its string contents survived.
- A separate in-memory build using the existing Lua file as the entry verified that the text loader exports a string exactly matching the file contents in both ESM and CommonJS output. No source, build configuration, or generated distribution files were changed.
- Standalone TypeScript checking still needs the declaration even though the current declaration bundler can emit the public API without the unused internal Lua import. Do not equate successful bundling with successful type checking.
- Running unbundled source through another runtime or test runner requires that environment's own text-import support; tsdown's loader applies to its build.

References: [tsdown loader option](https://tsdown.dev/reference/api/Interface.UserConfig#loader), [Rolldown module types](https://rolldown.rs/in-depth/module-types), and [TypeScript arbitrary extensions](https://www.typescriptlang.org/tsconfig/allowArbitraryExtensions.html).

### Authorized Lua build setup

- On 2026-10-20, the user explicitly requested configuring tsdown to inline Lua imports as strings and adding the TypeScript declaration. Limiter logic must remain unchanged.
- Added tsdown.config.ts with the .lua-to-text loader mapping. The existing package build command continues to select the entry point, ESM/CommonJS formats, declaration output, and validation options.
- Added src/lua.d.ts declaring the default export of every .lua module as a string. The existing tsconfig includes this declaration through src/.
- The prototype's Lua source, limiter classes, and execution logic are unchanged.
- Validation: standalone TypeScript checking passes. In-memory builds using the saved tsdown configuration generate ESM/CommonJS and declarations, and a consumed Lua import exports the exact source text in both formats. No distribution files were written during verification. The existing unused-dependency checker reports valibot and redis in the unfinished prototype; dependencies were not changed as part of this build-only request.

### Authorized Lua argument parsing

- On 2026-10-20, the user requested that src/lua/parse.lua convert the bulk script arguments into an array of limiter objects with keys type, name, ttl, limit, and block.
- The existing producer reserves ARGV[1] for the limiting key and ARGV[2] for the hit ID, then sends groups of five arguments in the order type, name, limit, ttl, block. Preserve this wire order; the requested object-field order does not change it.
- The parser appends one Lua table per group to the local limiters array. Type and name remain strings; ttl, limit, and block are converted to numbers, including the existing -1 block sentinel.
- This change implements argument parsing only. It does not select new blocking semantics, change the argument producer, or implement limiter enforcement.
- Verified the parser directly in the local Redis Lua runtime with zero, one, and multiple limiter groups, including reserved arguments, numeric field conversion, and block values -1 and 0. Verification did not modify database keys.
- The user subsequently added Redis key calculation and passes one key per limiter through EVAL's key arguments. As requested, the parser includes a key field immediately after name. The five-field ARGV layout remains unchanged.
- The user then reserved the first EVAL key for the shared blocking hash, currently @x:limiter:_block. EVAL's key count is the number of limiter keys plus one; KEYS[1] becomes local key_block, and limiter number n uses KEYS[n + 1]. The parser's KEYS[#limiters + 2] lookup is correct because the new limiter has not yet been inserted. ARGV still starts with limiting key and hit ID.
- Naming constraint identified during review: with the current key generator, a non-sliding limiter named _block would share the blocking hash key. Reserve that name under the agreed non-overlapping naming rules, or separate internal and limiter key namespaces. No naming validation was added during this review.

## Fixed-window implementation review (2026-10-20)

The user requested a review of their fixed-window implementation, not fixes. The current prototype composes time.lua, prepare.lua (which now contains argument parsing and existing-block checks), and hit.lua. Findings below describe the reviewed code, not newly accepted policies.

### Confirmed findings

- Clock-aligned expiration uses ceil(ts / ttl) times ttl. When ts lies on an epoch boundary, this produces the start of the current epoch rather than the next boundary. Since ts contains integer seconds, ttl=1 always produces an already-due deadline. Reproduced with limit 1 and four consecutive hits: all were accepted and no counter survived. A next-boundary calculation must advance even at exact multiples.
- The TypeScript script wrapper logs the Redis result and returns void, and RedisXLimiter.hit also returns void. A blocked Redis response therefore resolves to undefined without signaling rejection to the caller. Reproduced with a stub client returning a known blocked response.
- The hit loop mutates each limiter before knowing whether the whole batch is admitted. Reproduced with fresh limiter A and exhausted limiter B: the script reported B's block but incremented A. This contradicts the current wrapper comment that exceeding any limiter does nothing, and differs from the no-mutation fast path for already-existing blocks. The broader batch policy is still unresolved; admission without partial quota consumption requires deciding before usage writes.
- Numeric options are not validated before Redis mutation. With a first-hit window and ttl=1.5, HSET created a counter before HEXPIREAT rejected the fractional deadline, leaving the counter persistent (HTTL -1). With limit=0, the missing-counter branch still accepted the first hit and wrote 1. Validate/normalize the permitted numeric domain before writes; either reject zero limits or implement zero-capacity behavior.
- Creating a block leaves the exhausted usage counter in place. Reproduced by removing a CAPTCHA block while its counting window remained active: the very next hit created another full-duration block. The same retained-state issue applies if a shorter block expires before the counting window. The agreed fresh-start flow requires resetting usage at an appropriate point; simply removing the block field is insufficient.
- The limiting-ID regex rejects colons, so an IPv6 address such as 2001:db8::1 throws Invalid key before reaching Redis. This prevents the motivating per-IP use case for IPv6 clients. The name namespace restriction does not itself justify applying the same restricted syntax to subject IDs.

### Incomplete behavior and validation notes

- Priority is present on the TypeScript limiter instance but is not passed to Lua or used in result selection. The script returns all blocked entries in input order; the agreed priority-first, largest-TTL result remains unimplemented.
- TIME currently discards microseconds. First-hit and block deadlines based on these integer seconds can be almost one second shorter than their configured elapsed durations; decide whether that precision is acceptable or retain finer timestamps.
- The existing smoke test has no assertions about admission, counters, expiration, or blocks, so it does not detect these regressions.
- Verified the Lua scenarios on Redis 7.4.5 using isolated temporary keys and removed only those keys afterward. Did not run the test helper's FLUSHDB. The normal first-hit window accepted two hits at limit 2, rejected the third, and kept its counter at 2.
- Checked HTTL's subsecond behavior on this Redis version: a field with 250 milliseconds remaining returned 1 second. The ttl > 0 existing-block condition was not found to skip a normal subsecond block in this test.
- Standalone TypeScript checking passed. The public-result and IPv6 cases were reproduced with a stub Redis client. Implementation files were not changed during this review.

## Authorized review follow-up (2026-10-20)

The user selected the following scope using the review's finding numbers:

1. Fix clock-aligned expiration. The deadline now uses `(floor(ts / ttl) + 1) * ttl`, so even an exact boundary advances to the next window.
2. Leave the public hit result unchanged because it is work in progress.
3. Leave batch partial-consumption fixes to the user.
4. Validate numeric configuration inside the JavaScript constructor. Redis Lua trusts these arguments; do not add redundant script-side validation.
5. Leave current block/counter retention unchanged. A separate future reset method will remove both the block and counter.
6. Keep the intentional name/ID restrictions. Callers replace prohibited characters.

Constructor validation implemented for the current Redis numeric arguments:

- `limit`: a positive safe integer; zero-capacity limiters are rejected.
- `ttl`: an integer from 1 to 2,147,483,647 seconds.
- `block_ttl`: omitted or an integer from 1 to 2,147,483,647 seconds, matching the `ttl` duration domain. Omission sends the internal -1 sentinel to Lua to indicate exhaustion-only behavior. Explicit -1 and 0 are rejected by the constructor, following the user's clarification.
- Reject fractional, non-finite, unsafe, and non-number values with a TypeError before producing script arguments. Priority behavior is unchanged.
- The duration cap is an implementation choice of about 68 years, not Redis's exact maximum. Redis 7.4 limits absolute hash-field expiration to `(2^48 - 1) >> 2` milliseconds; merely allowing any JavaScript safe integer in seconds could still produce a failing expiration command after a write. This conservative duration bound leaves ample room for the current Unix timestamp. References: [Redis hash expiration validation](https://github.com/redis/redis/blob/7.4/src/t_hash.c) and [expiration timestamp representation](https://github.com/redis/redis/blob/7.4/src/ebuckets.h).

Regression coverage uses a disconnected client for constructor checks and isolated, uniquely named Redis keys for Lua scenarios. Lua checks cover one-second windows, exact boundaries, in-window hits, and unchanged first-hit window deadlines. The integration tests delete only their own keys and do not import the existing FLUSHDB helper.

Validation: all 15 targeted tests passed under Bun (57 assertions), including the Redis integration scenarios. TypeScript, ESLint, Oxlint, and Biome checks passed for the changes. In-memory tsdown builds emitted ESM/CommonJS and declarations without modifying distribution files. Vitest could not start because the installed Vite package does not export `./module-runner`; dependency changes were left outside this fix.

## Vitest diagnosis (2026-10-20)

The user asked why Vitest cannot test the code and how to fix it. This investigation did not change implementation, dependencies, or saved test configuration.

- The earlier `vite/module-runner` startup error no longer reproduces with the current installation: Vitest 5.0.3 and Vite 8.3.4. The installed Vite now exports that entry point.
- The current failure occurs while importing `src/lua/hit.lua`: Vite parses its Lua source as JavaScript and fails on `local function`. The constructor tests therefore never start.
- The tsdown text loader only applies to tsdown builds. Vitest loads source through Vite and reads Vite/Vitest configuration, not `tsdown.config.ts`. The TypeScript module declaration supplies types only; the current Vite pipeline does not turn these `.lua` imports into strings based on the import attribute.
- Recommended fix: add a `vitest.config.ts` with a small Vite plugin that loads `.lua` files as JavaScript modules exporting their UTF-8 contents as strings. This preserves the current source imports and does not require another package.
- Verified the recommendation by supplying the loader through Vitest's programmatic API in memory. All nine constructor tests passed under Vitest. No Redis integration tests or the FLUSHDB helper were run.

References: [Vitest configuration](https://vitest.dev/config/) and [Vite plugin API](https://vite.dev/guide/api-plugin).

### Authorized Vitest Lua loader

- The user approved implementing the proposed configuration.
- Added `vitest.config.ts` with an inline `lua-text` Vite plugin. Its pre-load hook reads `.lua` files as UTF-8 and exports their contents as a JavaScript string using JSON encoding.
- Existing Lua imports, limiter logic, tsdown configuration, dependencies, and test selection remain unchanged. Vitest discovers this configuration automatically.
- Verification: `npm run test:vitest -- src/main/options.test.ts` passes all nine constructor tests using the saved configuration. TypeScript and config lint/format checks pass. The Redis integration test that imports the FLUSHDB helper was not run for this configuration change.

## Review of the user's batch write deferral (2026-10-20)

The user asked whether their change fixes finding #3. This was a review only; implementation was not modified.

- The original rejected-batch quota-consumption issue is fixed for distinct limiter states: `hit.lua` collects counter/expiration writes in `hit_args`, returns before executing them when any limiter rejects, and executes them only after every limiter passes.
- Verified 16 rejection scenarios on local Redis: both fixed-window types, both limiter orders, fresh or partially used companion counters, and explicit blocking or exhaustion-only behavior. The companion counter and its absolute expiration remained unchanged, and the exhausted counter remained at its limit. An accepted-batch control updated both counters.
- Blocking fields are still created during the checking loop when a limiter exceeds its quota. This does not consume quota from other limiters; the wrapper comment saying an exceeded batch “does nothing” is broader than the implementation.
- A duplicate-entry edge case remains: when the same limiter/subject appears twice, both entries read the same pre-write counter. Reproduced with counter 1 and limit 2: two queued increments produced counter 3 and a successful result with no block. The eventual batch API should reject or coalesce duplicate limiter identities in JavaScript, or explicitly account for their combined cost. This is a recommendation; duplicate handling has not been selected.
- All verification used unique temporary Redis keys and deleted only those keys afterward. The existing FLUSHDB test helper was not run.

## Review of the proposed global name registry (2026-10-20)

The user added a module-level `LIMITER_NAMES` set and asked for a review. Implementation was not modified.

- Constructor-level name uniqueness does not prevent the same existing instance from appearing twice in one batch. Verified with a stub Redis client: collecting keys/arguments from `[limiter, limiter]` still sends duplicate entries through the shared EVAL executor. The previously reproduced overcount scenario is therefore not prevented.
- The constructor adds the name before validating numeric configuration. A failed construction reserves its name for the lifetime of the loaded module. Reproduced an invalid limit followed by a corrected configuration with the same name: the second construction throws a duplicate-name error.
- The global set also rejects repeated names across independent limiter lifecycles or separate Redis clients. That restriction is broader than preventing duplicate entries in an individual batch.
- Recommendation: validate duplicate names using a set local to the batch constructor, with the separately recommended same-client check. This catches both repeated references to one instance and distinct instances with the same name, while allowing reuse across separate batches. A global registry would be a separate configuration policy, not a substitute for batch validation.
- Verification: all nine existing constructor tests now fail with duplicate-name errors. No Redis writes were performed during this review.

### Follow-up: registration after validation and batch deduplication

- The user moved name registration after numeric validation and added `RedisXLimitersBatch`, whose constructor deduplicates limiter references with `new Set(limiters)` before collecting arguments.
- Both previously identified concrete issues are addressed in the current construction path. Verified that failed limit, ttl, and block_ttl validation permits a corrected construction with the same name. Verified that a batch containing repeated references reads each unique limiter's arguments once, in first-occurrence order.
- The module-wide name registry remains and still forbids a second instance with the same name even on another Redis client. This remains a broader naming policy than batch deduplication.
- Current constructor tests: five pass and four fail because successful fixtures reuse the name `validation`. If module-wide name uniqueness is intentional, successful fixtures need distinct names or module isolation.
- `RedisXLimitersBatch.hit` is still a stub, so this review verifies batch argument construction rather than end-to-end batch execution. When keys are added, derive keys and arguments from the same deduplicated list.
- Implementation was not changed and no Redis writes were performed during this follow-up review.

### Batch client initialization

- The user added storage of the deduplicated limiter list, client identity checks, and batch hit execution, then asked how to resolve TS2564 without making the client nullable.
- The current constructor assigns `#redisClient` only inside a loop. An empty batch skips that loop, so construction can complete without a client. TypeScript reports TS2564 at the field declaration.
- Recommendation: reject an empty batch, directly assign the first limiter's client before the loop, then compare every limiter's client against it while collecting arguments. Keep the field typed as `RedisClient`; a definite-assignment assertion would hide the empty-batch problem.
- This is advice only; no implementation change or empty-batch policy was applied. Reference: [TypeScript strict property initialization](https://www.typescriptlang.org/tsconfig/strictPropertyInitialization.html).

### Authorized options-test fixture update

- The user requested updating `src/main/options.test.ts` so limiter names are not reused.
- Added a fixture factory that gives every constructor attempt a distinct `validation-N` name, including invalid-input cases. Argument-serialization assertions use the name from that case's fixture.
- The module-wide name registry and limiter implementation are unchanged.
- Validation: all nine options tests pass under both Vitest and Bun. ESLint, Oxlint, Biome, and whitespace checks pass for the fixture update.

## Sliding-window implementation review (2026-10-20)

The user requested a review, then updated the missing-member check during the review. Implementation was not changed by the assistant.

- The initial comparison of ZSCORE's missing-member reply with nil would skip new hits because Redis's default Lua response mapping uses false. The user changed the comparison to false; the tested version correctly records new unique IDs.
- Confirmed expiration bug: `ts_expire` is an absolute Unix timestamp, but the queued command is EXPIRE, which expects a relative duration. A 60-second window produced a key TTL of 1,792,518,054 seconds. Use EXPIREAT with this deadline. Logical member cleanup still works, but idle subject keys otherwise remain for decades.
- Confirmed response bug: the exhaustion-only branch returns the first member's score directly. That is an absolute timestamp string, whereas fixed-window and explicit-block results return remaining seconds as numbers. The same test returned `"1792518054"` instead of approximately 60. Convert the score to a number and subtract the captured ts.
- At the initial review, repeat-ID semantics were undecided and the code left an active member's deadline unchanged: a repeat with 20 seconds remaining still had 20 seconds remaining under a 60-second configuration. The user subsequently accepted and implemented refresh behavior, as recorded below.
- Passing controls on the updated script: two distinct IDs accepted at limit 2; a third rejected without increasing cardinality; an existing ID allowed at capacity when unblocked; explicit block creation and rejection of repeated IDs during the block; cleanup of scores at or before the captured timestamp; and no new sliding hit recorded when a fixed limiter rejects a mixed batch, in either order.
- Cleanup before the batch decision removes only logically expired members and does not consume quota. No new partial-consumption issue was found in these scenarios.
- Verification used the actual composed Lua script and unique temporary keys on local Redis, with only those keys deleted afterward. No FLUSHDB helper was used. Standalone TypeScript checking passed.

References: [Redis Lua response conversion](https://redis.io/docs/latest/develop/programmability/lua-api/), [EXPIRE](https://redis.io/docs/latest/commands/expire/), [EXPIREAT](https://redis.io/docs/latest/commands/expireat/), and [ZRANGE](https://redis.io/docs/latest/commands/zrange/).

### Sliding-window deadline follow-up

- The user changed the key expiration command to EXPIREAT, correctly matching the absolute `ts_expire` value.
- The exhaustion calculation was changed to `ts - score`, which reverses the required subtraction and produces a negative duration for an active member. Remaining TTL must be `tonumber(score) - ts`.
- This follow-up was verified by inspecting the updated source; implementation was not changed.

### Accepted repeat refresh and verified deadline fixes

- The user explicitly selected extending expiration on repeated hits and updated the implementation. This establishes last-seen semantics for accepted sliding-window hits.
- Confirmed `tonumber(resp_score) - ts` now returns a positive numeric remaining TTL. A fresh 60-second window returned 60 seconds on exhaustion, and EXPIREAT gave its key the intended expiration.
- Confirmed a repeat at capacity refreshes both the member score and key expiration to now plus the window length without adding a member or creating a block. The tested member had 20 seconds remaining before the refresh and 60 afterward.
- Active explicit blocks prevent refresh. If another limiter rejects a batch, neither the repeated member's deadline nor its key expiration changes; verified in both limiter orders.
- Once an ID expires, attempting it again costs new unique capacity. Verified rejection when another active member already filled that capacity.
- Tested the actual updated Lua on local Redis using unique temporary keys and removed only those keys. No implementation files were changed by the assistant.

## Approximate sliding-window review (2026-10-20)

The user requested review of the approximate sliding-window implementation and an explanation of when the next request can be allowed. This is review and mathematical analysis; implementation was not changed.

- The overlap weight and weighted-count expression are correct for a two-window approximation.
- Confirmed enforcement bypass: HMGET reads `epoch:limitingID` fields, but HSET, HINCRBY, and HEXPIREAT use the bare limiting ID. Starting empty, five hits at limit 2 all succeeded and the bare field stayed at 1. All usage writes and expiration must address the current epoch's field.
- The admission condition needs an explicit fractional-count policy. Under the intended maximum-usage interpretation, require `estimatedUsage + 1 <= limit`; checking only `estimatedUsage >= limit` permits a hit at 9.5 with limit 10, taking estimated usage to 10.5. The current script entered the success path with seeded previous count 1 and current count 9 halfway through a window.
- The retention deadline is one window too late. Because getEpoch returns `floor(ts / ttl) + 1`, epoch start is `(epoch - 1) * ttl`. Retaining through the end of the following window requires `(epoch + 1) * ttl`; the current `(epoch + 2) * ttl` retains an extra window. Verified the extra 60 seconds for a 60-second window.
- HTTL on the bare limiting ID returns -2 when only the expected epoch fields exist. Even looking up the correct epoch field would give data-retention time, not capacity-recovery time; capacity can recover during a window or after the next boundary.
- Redis reproductions used the existing prepare/hit Lua with a controlled timestamp substituted for time.lua in memory, unique temporary keys, and cleanup limited to those keys. The repository's FLUSHDB helper was not run.

### Derived retry time: assistant recommendation

Assume no further accepted hits, unchanged configuration, and no independent active block. Define window length W, elapsed seconds e = ts % W, remaining seconds R = W - e, previous count P, current count C, and limit L. Estimated usage is U = C + P * R / W. One more hit fits when U <= A, where A = L - 1.

- If U <= A, the delay is zero.
- Otherwise, if C <= A, the previous contribution can decay enough within this window. Delay is `(U - A) * W / P`; P is necessarily positive in this branch.
- If C > A, current usage alone prevents admission until rollover. Wait R seconds, then C becomes the previous count and decays from C to A. Total delay is `R + W * (C - A) / C`.
- Round the delay upward for integer-second Retry-After values. For the script's integer clock, the middle expression can equivalently be calculated as `ceil((C * W + P * R - A * W) / P)`, and the last as `R + ceil(W * (C - A) / C)`.
- Example: W=60, L=10, e=15, P=8, C=4 gives U=10 and a 7.5-second delay, rounded up to 8. With the same W, L, and e but P=0 and C=10, wait 45 seconds to rollover plus 6 seconds of decay, totaling 51.
- The result is the earliest quota recovery under the approximation and no further traffic; it is not a reservation. An independent block still prevents access until it expires or is lifted, and reset can change usage.
- Verified the rounded formula against an integer-second simulation for 1,428,480 states covering both sides of rollover, limit 1, zero previous counts, and counts above the configured limit.

References: [two-window weighting](https://smudge.ai/blog/ratelimit-algorithms) and [HTTL return values](https://redis.io/docs/latest/commands/httl/).

### Follow-up verification of the user's fixes

- The user requested verification of the four review comments. Three are resolved; the exhaustion-only retry result remains unfinished.
- HSET, HINCRBY, and HEXPIREAT now consistently use `field_current`. Two hits at limit 2 accumulate in the epoch field; the third rejects without changing the count.
- The condition `counter + 1 > limiter.limit` rejects fractional over-capacity usage and permits equality. Verified rejection with estimated usage 9.5 at limit 10 and acceptance with estimated usage 9.
- The user changed get_epoch to the zero-based `floor(ts / ttl)` and added get_epoch_ts_end. Consequently, `get_epoch_ts_end(epoch + 1, ttl)` correctly expires approximate counters at epoch start plus two windows. HINCRBY preserves that deadline.
- Fixed-window expiration still lands at the next boundary after this shared helper change; verified at the boundary, one second after it, and one second before the following boundary.
- The exhaustion-only branch still calls HTTL on the bare limiting ID and returns -2. With window 60, limit 2, two current hits and 15 seconds elapsed, the derived quota-recovery delay is 75 seconds; the current result remains -2.
- Verified eight scenarios on local Redis using controlled script timestamps and unique temporary keys, including explicit blocking and previous-window usage at rollover. Removed only those keys; implementation files were not changed by the assistant.

### Authorized retry-time implementation

- The user explicitly requested implementing the seconds until another hit can fit.
- Replaced the approximate limiter's exhaustion-only HTTL lookup with the derived delay. When current usage is below the limit, calculate how long the previous contribution needs to decay; otherwise, wait for rollover and subsequent decay of current usage. Round up with math.ceil.
- Explicit blocking continues to return the configured block duration. The calculated retry delay assumes unchanged configuration and no additional accepted hits; it reserves no capacity.
- Calculate weighted previous usage as `previous * remaining / window`, multiplying before dividing. The former `previous * (1 - elapsed / window)` expression could reject exact fits due to floating-point drift: window 3, elapsed 1, previous 9, current 3, limit 10.
- Added `src/lua/approximate-window.test.ts` with deterministic script timestamps and isolated Redis keys. The tests assert rejection one second before the returned delay and acceptance at that delay, without recording rejected hits or creating blocks in exhaustion-only mode.
- Coverage includes fractional and exact recovery, recovery at and after rollover, empty current windows, limit 1, one-second windows, counts above a reduced limit, exact-fit precision, and unchanged explicit-block reporting.
- Validation: all 13 tests passed under both Vitest and Bun (59 assertions under Bun). TypeScript, ESLint, Oxlint, Biome, and whitespace checks passed. The existing FLUSHDB test helper was not run.

## Authorized token-bucket implementation (2026-10-20)

- The user requested implementing token buckets in the same style as the other limiter branches, explicitly choosing one field containing used tokens and an expiration representing full refill. This supersedes the earlier stored-remaining-tokens proposal.
- Added type 4 handling to hit.lua. It reads HGET and HEXPIRETIME, checks capacity, uses the existing set_block helper or returns whole-second quota recovery time, and queues HSET plus HEXPIREAT only for an accepted batch. No extra metadata fields or keys are needed.
- Let L be capacity, W the full-refill duration, U the stored used-token count, and F the absolute field deadline. In the existing integer-second clock, the previous write time is `F - ceil(U * W / L)`. Current usage is `max(0, U - elapsed * L / W)`, and available tokens are L minus that usage. An accepted hit adds one token of usage and sets the new deadline to `ts + ceil(newUsage * W / L)`.
- Internally, refill arithmetic scales usage by W so elapsed whole seconds subtract integral multiples of L. Round the deserialized scaled usage back to an integer to prevent accumulated floating-point drift at exact-fit boundaries. Store the actual token count, not the scaled value, using 17 significant digits.
- Preserve the stored count when no time has elapsed, and compare admission in token units so large scaled values cannot hide the cost of another hit. Exhaustion-only delays are rounded upward and are at least one second.
- A capacity of 10 with ttl 60 refills one token every six seconds. One accepted hit from full capacity expires after six seconds; consuming all ten tokens produces a 60-second full-refill deadline.
- Added 22 Redis regression tests covering bursts, fractional refill and expiration rounding, exact retry boundaries, full refill after idle, refill rates above and below one token per second, repeated traffic against a reference model, independent limiting IDs, explicit blocks, rejected and accepted mixed batches in both orders, actual Redis TIME/expiration, and maximum supported capacity/duration boundaries.
- Validation: all 35 targeted token-bucket and approximate-window tests passed in both Vitest and Bun (1,757 assertions under Bun). TypeScript, ESLint, Oxlint, Biome, and whitespace checks passed. Tests used isolated temporary keys and deleted only those keys; the existing FLUSHDB test helper was not run.

### Integer token-counter alternative under discussion

- The user questioned storing fractional usage and proposed adjusting the field expiration instead. This is a design discussion; no implementation change is authorized by the question alone.
- The current fractional value is an implementation choice: it snapshots outstanding used tokens after refill, keeping the stored count at or below capacity. Fractional storage is not required by the token-bucket algorithm.
- An alternative integer value N can count accepted hits since a refill anchor A. For capacity L and refill duration W, store the full-refill deadline `F = A + ceil(N * W / L)`. The integer-second anchor can be recovered from the field value and deadline as `A = F - ceil(N * W / L)`.
- Current outstanding usage is `max(0, N - (ts - A) * L / W)`. If another hit fits, increment N and recompute the deadline from A and the cumulative count. Reset the count/anchor once fully refilled.
- Round the cumulative refill duration, not every individual extension. With three tokens per ten seconds, three simultaneous hits have deadlines at offsets 4, 7, and 10 seconds; repeatedly adding ceil(10/3) would instead produce 4, 8, and 12 and distort admission/refill.
- A continuously active bucket needs periodic rebasing to prevent its cumulative counter growing indefinitely. Advancing the anchor by whole refill periods and subtracting the corresponding whole capacities preserves the same state. This is additional bookkeeping compared with the current bounded usage snapshot.
- A sufficiently precise full-refill deadline can also represent the bucket without a meaningful field value. With second-resolution expiration alone, arbitrary fractional token intervals need a retained remainder or explicit quantization policy.
- The user subsequently accepted this representation; the authorized implementation is recorded below.

### Authorized integer counter and cumulative expiration

- The user explicitly requested switching hash values to integers and adjusting TTL.
- Replaced fractional usage snapshots in the token-bucket branch with the integer counter and implicit reference time. With counter N, capacity L, duration W, and stored deadline F, recover `A = F - ceil(N * W / L)`. Missing or fully refilled state starts at N=0 and A=ts.
- Before incrementing a counter equal to L, replace it with zero and advance A by W. This rebasing preserves the state, prevents unbounded counter growth, and avoids incrementing beyond the supported safe-integer capacity.
- For the proposed hit, increment N and calculate `F_next = A + ceil(N * W / L)`. Accept when `F_next <= ts + W`; otherwise return `F_next - ts - W` seconds in exhaustion-only mode, or use the existing explicit-block helper.
- Accepted batches queue HSET with a decimal integer string and HEXPIREAT with F_next. Rejected operations do not apply counter increments, rebasing, or expiration changes.
- Fractional token usage is no longer stored. Full refill, admission, and retry behavior remain equivalent under the integer-second clock, with cumulative rounding rather than per-hit duration rounding.
- Added regression assertions that stored values are decimal integers bounded by capacity, explicit 4/7/10-second cumulative deadlines for three tokens per ten seconds, and 300 accepted hits across repeated rebasing cycles with rejection one second before every retry.
- Validation: all 37 targeted Lua tests passed under Vitest and Bun (3,309 assertions under Bun); TypeScript, ESLint, Oxlint, Biome, and whitespace checks passed. The tests used isolated Redis keys and did not run the FLUSHDB helper.
- Existing fractional snapshot fields must expire or be cleared before using this representation. Automatic migration of the prototype's fractional state is not implemented, and existing Redis data was not modified by this change.

## Shared RedisX test-client migration (2026-10-21)

- The user requested migrating all tests to the shared redisXClient exported by test/redis.ts, allowing additional clients only for explicit different-client behavior tests.
- Updated the main smoke test, constructor-option tests, and both Lua integration suites to import that instance. Removed test-local createClient calls and connection/disconnection hooks.
- Adapted command calls to RedisXClient's uppercase methods and its EVAL(script, keys, args) signature. Commands without dedicated wrappers use sendCommand(command, ...args), with typed raw replies where needed.
- Lua suites retain unique key namespaces and delete their own keys after completion without closing the shared connection. The shared fixture owns client initialization and its existing database reset.
- Before running the shared fixture, verified its destination was the dedicated test-redis container on port 16379 and database 0 was empty. The test runs used the fixture's existing FLUSHDB behavior; the fixture itself was not changed by this migration.
- All 47 tests passed under both Vitest and Bun (3,346 assertions under Bun). TypeScript, ESLint, Oxlint, Biome, and whitespace checks passed. Constructor tests now use the same RedisX client as integration tests; no current test needs a separate client.

## Read-only get architecture discussion (2026-10-21)

The user asked how to expose current usage without recording a hit, whether disabling queued writes and set_block is sufficient, and whether to split reading from mutation. This is a design discussion; the following are assistant recommendations, not authorization to implement or a finalized response format.

- Extract shared read/calculation logic that produces current per-limiter state using the captured Redis time. Retain algorithm-specific raw state needed by hit, such as previous/current epoch counters and the token-bucket reference time, to avoid repeating reads.
- Compose two Lua entry points from shared fragments. Get returns the calculated state; hit evaluates the proposed hit, queues mutations, and applies usage writes only after the whole batch passes. Each operation remains one script execution; hit must not call get separately from JavaScript.
- Preserve the existing distinction between newly justified blocks and usage writes: a rejected hit can create blocks, but a rejected batch must not increment counters or refresh repeated-hit deadlines. A second limiter loop must not immediately apply successful increments before discovering another limiter's rejection. The existing final hit_args command loop can remain the commit stage.
- Simply suppressing hit_args and set_block commands is insufficient. Exact sliding currently issues ZREMRANGEBYSCORE immediately; prepare.lua returns early for existing blocks; token-bucket code calculates a prospective increment; successful hit currently returns no usage response.
- For exact sliding, read active usage with ZCOUNT over scores strictly greater than ts, using an exclusive lower bound. Keep cleanup in the hit path. Once reads no longer depend on cleanup, repeated-hit membership must require ZSCORE > ts, and earliest-expiration queries must also exclude expired scores.
- Fixed-window usage is the stored count or zero. Approximate usage is the current count plus the weighted previous count. Token usage must be derived from the stored integer N and deadline F: with capacity L and refill duration W, recover A = F - ceil(N * W / L), then usage = max(0, N - (ts - A) * L / W). Missing or expired state has zero usage. Do not clamp elapsed time to zero: the rebased reference time can be in the future.
- Get must not invent a block or return configured block_ttl merely because a hypothetical next hit would exceed quota. At exact capacity, it can report zero remaining capacity without a new block. If existing block metadata is included, report only an actual block's remaining lifetime, separately from quota-recovery delay. If the API returns only usage, it can skip block reads entirely. In either case, shared preparation must not return before gathering requested usage; hit can retain its own existing-block shortcut.
- A usage-only query does not need a hit ID. Determining whether a particular hit would fit is a separate question: an active repeated ID can fit at exhausted unique capacity. Get is a snapshot and does not reserve capacity or guarantee permission to hit.
- Approximate and token usage can be fractional even though stored values are integers. Choose explicitly between fractional capacity and whole additional hits in the public response. Fractional Lua results need suitable serialization, such as decimal strings parsed in TypeScript, because ordinary numeric replies truncate fractions. Return per-limiter results in batch order rather than combining unrelated quotas.

References: [ZCOUNT bounds](https://redis.io/docs/latest/commands/zcount/) and [Lua response conversion](https://redis.io/docs/latest/develop/programmability/lua-api/#lua-to-resp2-type-conversion).

## Single-script operations and iteration review (2026-10-21)

The user consolidated the Lua fragments into src/script.lua and explicitly selected one operation argument. The user requested explanation only; no implementation changes were authorized.

### User-defined operation contracts

- Check (0): return only already-blocked limiters, or nothing if none are blocked. The TypeScript method returns a boolean indicating whether the limiter/batch is already blocked; quota exhaustion alone is not an existing block.
- Get (1): return every limiter. A blocked entry includes status 1 and its actual remaining block duration. An unblocked entry includes status 0, hits left, and seconds until hits left changes.
- Hit (2): return existing blocked-limiters data if any; otherwise process the hit and return each limiter's outcome, either a newly blocked state or remaining usage in the same form as get.
- The user proposes guarding queued mutations with op=hit and adjusting exhaustion branches so get does not manufacture blocks. This supersedes the previous separate-script recommendation.

### Findings and assistant recommendations

- One algorithm loop can serve get and hit, with a final mutation loop restricted to hit. Separate read/evaluate loops are optional; correctness depends on separating current state, proposed hit effects, and returned state inside each branch.
- Guarding queue insertion avoids writes and unnecessary allocation for get, but the entire mutation stage should also be hit-only. ZREMRANGEBYSCORE is still an immediate write outside hit_args and needs hit-only handling. A read-only exact-window get must count only active deadlines; skipping cleanup while retaining ZCARD would overcount.
- The proposed combined condition and else are insufficient: when op=hit and set_block returns true, the condition is false and the else could overwrite the newly blocked result with status 0. Treat get, hit with a newly created block, and hit without blocking support as distinct outcomes. Never call set_block for get; a successful set_block result must remain blocked.
- For get, preserve entries already populated from the blocking hash and skip usage processing for those limiters. Otherwise their actual block lifetime could be replaced by usage or a fresh configured block duration.
- Current result entries use limiter-name keys. Lua's length operator does not count those entries, and ordinary Redis Lua array replies omit string-keyed fields. Track block presence explicitly and return an indexed array (or explicitly serialize the map). The current hit shortcut using #result cannot detect these blocks. An empty Lua table returns an empty array, not the requested absence of a check result. Remaining references to the removed limiters_blocked table also need migration.
- Guarding Redis writes does not guard local arithmetic: the token branch still rebases/increments its local counter for get. Compute current usage from the stored counter and deadline, and prospective/post-hit usage separately. Every unblocked branch needs a result, including empty and partially used limiters. Get returns pre-hit usage; an accepted hit returns post-hit usage, with active repeated IDs adding no unique usage.
- The requested next-change duration differs from time until another hit fits. It must be calculated even with capacity remaining. Fixed windows use an active counter's deadline; exact sliding uses the earliest active deadline, accounting for hit-induced refreshes; approximate and token types need a consistent choice of whole-hit or fractional remaining capacity. Full idle capacity has no scheduled change and needs an explicit sentinel. These are recommendations; rounding and sentinel values remain undecided.
- Block writes now share hit_args with usage writes, and the final loop executes all of them. This permits another limiter to consume quota when one newly exceeds its limit. The new wording may intentionally change earlier whole-batch rejection semantics; do not silently impose either policy. If whole-batch rejection still applies, separate block writes from usage writes and decide whether to discard usage writes before executing commands. If newly triggered blocks allow other limiters to record the hit, document that policy explicitly. The existing block-on-exceed boundary has not been explicitly changed to block-on-last-allowed-hit.

Source inspection only; no scripts or tests were executed, and implementation files were not changed by the assistant.

## Authorized fixed-window get/hit support (2026-10-21)

- The user authorized updating only the fixed-window branch for get and hit, with shared calculations rather than duplicated response branches. Other algorithms and response-encoding/batch work remain WIP and are outside this implementation request.
- The user explicitly requires both get and hit to skip limiters already present in result. Added a guard around algorithm dispatch that preserves those block entries without reading or mutating their usage. Removed the unused continue label as part of using the guard.
- The user decided that approximate sliding windows and token buckets will report available whole hits rounded down and time until the next hit is permitted. Implementing that policy is deferred; it supersedes the earlier unresolved rounding discussion for these types.
- Fixed-window processing now reads current usage and the existing field deadline once, queues mutations only for hit, and builds an unblocked result in one shared place. Get returns current capacity; accepted hits return capacity after the increment. Remaining time is HEXPIRETIME minus the captured script timestamp.
- First hits establish either the next clock-aligned boundary or a full duration starting now. Subsequent accepted hits preserve that deadline. Get never creates a counter, extends a window, or calls set_block.
- Consuming the last allowed hit returns status 0 and zero remaining hits. An exceeding hit creates the configured block, preserving its status-1 result; exhaustion-only mode returns status 0, zero remaining hits, and the window's remaining duration without incrementing. Remaining capacity is clamped to zero if stored usage already exceeds the configured limit.
- Implementation choice: an unused/expired fixed-window limiter returns full capacity with duration -1, indicating no active window and no scheduled capacity change. This sentinel was stated during implementation; it is not a separately confirmed user preference.
- Added 19 fixed-window regression tests using the shared redisXClient. They cover both window alignments, read-only get for empty/partly used/exhausted state, post-hit usage, deadline preservation, the block-on-exceed boundary, exhaustion without blocking, existing-block preservation with and without usage, expired state, and a get batch.
- Because the outer response encoding remains WIP, the tests replace only the final map return with JSON encoding to inspect the internal result and use a controlled script timestamp. They do not claim the public TypeScript get/check methods or production map serialization are complete.
- Verified the dedicated test Redis database was empty before using the shared fixture and its existing FLUSHDB. All 19 tests passed under Vitest and Bun (65 Bun assertions). TypeScript, ESLint, Oxlint, Biome, and whitespace checks passed for the change. The full existing Lua suites still reference removed fragments and were not run as part of this focused change.
- The build generated bundles and declarations but its checks failed on the existing unused valibot dependency and local @redis-x/client tarball dependency. Those packaging changes were left to the ongoing WIP.

## Review of result-array and fixed-window deadline changes (2026-10-21)

- The user selected an indexed result array plus a separate result_names membership table. save_result should append only the first result for each limiter, preserving a block against a later attempted usage result. This is the intended design; the reviewed implementation does not yet fully implement it.
- The user explicitly changed unused-window reporting: clock-aligned fixed windows report time until the next boundary even before a hit; unused first-hit/user-defined-start windows have no deadline and report nil. This supersedes the assistant's -1 sentinel for both types. Existing active windows continue to report their retained deadline minus the captured timestamp.
- Review finding: save_result still assigns result[limiter_name] instead of appending, so result is still a string-keyed map. Its length remains zero, native replies omit its entries, and hit fails to short-circuit on existing blocks. Reproduced an existing-block check returning an empty array and a blocked batch incrementing a companion counter to 1 while returning an empty array.
- Review finding: the algorithm-dispatch guard still checks result[limiter.name]. Once result is converted to an array, it must consult result_names to skip existing entries; suppressing duplicate output does not skip the associated processing.
- Review finding: the unused first-hit branch always assigns ts + ttl, including for get. An internal-result probe returned full capacity with duration 60 for an unused 60-second limiter rather than an absent deadline. Assign that new deadline only when starting the window on a hit.
- Review finding: ts_expire == nil and nil or ts_expire - ts is not a safe nil guard. If ts_expire is nil, the and expression produces nil and the or expression evaluates subtraction anyway. Reproduced Redis's arithmetic-on-nil error. A trailing nil in a returned Lua array omits that element; it does not return an explicit null slot.
- The clock-aligned next-boundary calculation and result_names first-result-wins behavior are sound. Existing test instrumentation replaces the final native return with JSON encoding and therefore cannot verify the intended Redis array response; those expectations need migration with the response design.
- Verification used the shared redisXClient after confirming its dedicated test database was empty, isolated temporary keys, and cleanup of only those keys. Native-response probes executed the actual source; an in-memory final-return replacement inspected the otherwise hidden first-hit result. No implementation or test files were changed during this review.

### Follow-up verification of the result and deadline fixes

- Confirmed save_result now appends to the indexed result array and records membership in result_names; the iteration guard also uses result_names. Redis returns the actual array, and #result now correctly triggers the existing-block shortcut for hit.
- Confirmed get for an unused first-hit limiter no longer constructs a deadline. Its first hit creates the deadline; later hits retain it. Deadline subtraction is now guarded explicitly, eliminating arithmetic on nil.
- One response-contract difference remains: local ttl defaults to -1, so an unused first-hit get returns [name, 0, limit, -1], not the previously requested absent/nil TTL. Record this as observed behavior pending clarification, not an accepted change to the user's nil preference.
- Direct Redis assertions verified native array replies, read-only gets for both empty window types, empty and blocked checks, the first-hit deadline, preserved deadlines on subsequent hits, the last allowed hit remaining unblocked, a single blocked result on an exceeding hit, existing blocks preventing all companion usage in a hit batch, mixed blocked/unblocked get results, and exhaustion-only hits returning zero without incrementing or creating blocks.
- All assertions passed using the unchanged source and its real Redis TIME. The shared test client used the dedicated database after an empty-database check; probes allocated unique keys and removed those keys afterward. Existing test files still use the older map-oriented expectations and were not changed or run for this review.

## Exhaustion responses without a stored block (2026-10-21)

- The user wants status 1 with a recovery duration for both get and hit when fixed-window quota is exhausted, including when block_ttl is omitted. No blocking-hash entry should be created in exhaustion-only mode. This supersedes the earlier status-0 response for an already-exhausted limiter in that mode.
- Status 1 therefore can describe quota unavailability as well as a separately persisted block. For fixed-window exhaustion, its duration is the remaining window lifetime; for an actual stored block, it is that block's remaining lifetime. Get remains read-only, and a hit that finds no capacity must not increment the counter.
- Confirmed by the user: distinguish a hit rejected because it found no capacity from a successful hit consuming the last available slot. With limit 3 and prior usage 2, the third hit returns status 0 with zero remaining hits; a subsequent get or fourth hit returns status 1 with the remaining window lifetime in exhaustion-only mode. Determine hit rejection from capacity before incrementing, rather than treating zero capacity after an accepted hit as rejection.
- The current check operation reads only the blocking hash, so it still reports no stored block for exhausted limiters without block_ttl. It must not be interpreted as a capacity/admission check. The user has not requested changing its scope.
- For future exact sliding-window work, exhausted unique capacity prevents new IDs, while an already-active hit ID can still be accepted and refreshed in the absence of a stored block. Do not generalize fixed-window unavailability into rejecting all repeated IDs.
- This turn is a design discussion; implementation and tests were not changed or executed.

### Authorized fixed-window exhaustion response update

- The user explicitly authorized implementing the agreed responses in the fixed-window branch only. Other algorithm branches and shared helpers were left unchanged.
- Capture exhaustion before any increment. Get and a hit that finds exhausted capacity now save [name, 1, remainingWindowTTL]; a successful hit consuming the last slot still saves [name, 0, 0, remainingWindowTTL]. No usage is incremented on rejection.
- A configured block is still created only by an exceeding hit. Its result is saved first and takes precedence over the quota-recovery fallback through save_result. Get does not create a block; exhaustion-only hits do not write the blocking hash.
- Verified both fixed-window types with and without block_ttl using the shared RedisX test client and native replies. Assertions covered unused windows, the last accepted hit, exhausted get, repeated rejected hits, unchanged counter/deadline, configured block duration/deadline, and check remaining limited to persisted blocks. All assertions and whitespace checks passed.
- Confirmed the dedicated Redis test database was empty before using the shared fixture. Verification used unique temporary keys and removed them afterward. The existing temporary debug rows were preserved and filtered by limiter name in assertions. No test files or other limiter implementations were modified.

## Draft TypeScript response API and selection (2026-10-21)

The user requested inspecting the current TypeScript and drafting response processing before updating other algorithms. This is a design draft; implementation changes have not been requested for this turn.

### User proposal

- get returns one representative state: the strongest reported block, or the weakest remaining quota if no limiter is unavailable.
- getAll returns all limiter states, including active quota and blocked/exhausted states.
- hit returns the weakest remaining quota after acceptance, or throws an error containing the strongest reported block on rejection.
- Block selection first considers the highest priority among unavailable limiters, then the longest duration within that priority. Lower-priority limiters remain enforced but are hidden from the selected response.
- The motivation is reporting remaining capacity/reset information on successful HTTP responses and Retry-After on HTTP 429 responses. check remains a boolean operation over stored blocks.

### Assistant draft: decoder and public methods

- Keep runScript as the shared Redis execution and validation boundary returning every parsed state. Its existing Map<string, State> is appropriate; recommend exposing a ReadonlyMap<string, LimiterState> contract rather than reducing the result inside the decoder. It should throw Redis/protocol errors, not throw merely because a row has status 1.
- Retain a usage/block union close to the current shape. A UsageState contains name and usage with remaining: number and ttl?: number. A BlockState contains name and block.ttl: number. LimiterState is their union. Export public result types and the domain error through the package entry point when implementing.
- Rename the current usage.limit property to remaining: Lua returns remaining capacity in that slot, not the configured limit. Allow an omitted usage TTL, as unused first-hit windows intentionally return a three-element row. The current decoder rejects that valid row because it requires a numeric fourth element. Validate expected tuple shapes, finite integer numeric values, and unique known limiter names; require complete GET responses while permitting CHECK and rejected-HIT subsets.
- Proposed method returns on both single limiters and batches: get -> Promise<LimiterState>; getAll -> Promise<ReadonlyMap<string, LimiterState>>; hit -> Promise<UsageState>, throwing an exported LimiterBlockedError carrying the selected BlockState. Redis and malformed-response errors remain distinguishable from quota rejection.
- get and getAll use the existing GET operation; getAll requires no new Lua operation. get applies shared TypeScript selection to that response. hit applies the same selection to its HIT response, throws only if the selected state is a BlockState, and does not issue a second get. Preserve successful status-0 results with remaining zero.
- Both classes should use the same pure selection helper supplied with their limiter metadata. Priority already exists on limiter instances and does not need a Redis argument for presentation selection. Use constructor/batch order for deterministic ties, and retain the selected limiter's own remaining count and TTL together.
- Proposed weakest-quota ordering: smallest remaining whole quota count, then longest known usage TTL, then original batch order. For a TTL tie-break, prefer a known TTL over an absent one without inventing a deadline. Compare absolute remaining units, not percentage of configured capacity; priority filtering applies only to blocks. This ordering is an assistant recommendation awaiting user agreement.
- Strongest-block ordering: highest numeric priority among status-1 states, then longest block/recovery TTL, then original batch order. An active higher-priority limiter must not hide an unavailable lower-priority one. Status 1 includes both persisted blocks and quota exhaustion; the current Lua tuple does not identify which cause produced the row.

### Contract details that must remain explicit

- Confirmed by the user: presenting blocking requirements in priority order is intentional. Library users can assign higher priority to unconditional waiting blocks and lower priority to conditional blocks such as CAPTCHA. A priority-100 block lasting 60 seconds is reported before a priority-10 conditional block lasting 3,600 seconds. Once the higher-priority block expires, a retry can receive HTTP 429 identifying the still-active conditional block, allowing the client to satisfy that condition. Lower-priority blocks remain enforced throughout. Treat this sequence as accepted behavior.
- The selected duration belongs to the reported block; it does not promise that every limiter will be available afterward. The library provides priority selection, limiter identity, and duration. Application authors own the condition semantics, response presentation, verification, and lifting of conditional blocks. This decision does not require built-in CAPTCHA handling or automatic clearing of lower-priority blocks.
- get/hit must keep the selected limiter's identity and duration together. Do not attach a maximum TTL from another limiter to the selected name just to imply all blocks will expire together.
- The current HIT existing-block shortcut returns only persisted blocks without inspecting other quotas. GET can therefore discover a higher-priority exhaustion state that HIT does not report. Consistent selection across all unavailable limiters will require quota inspection before HIT returns, without recording usage when an existing block has already rejected the batch; TypeScript alone cannot select information omitted by Lua.
- Throwing in TypeScript cannot roll back Redis writes. The current script may increment other limiters when one newly exhausts/blocks. A promise that every rejected batch consumes no usage requires a separate Lua admission/write policy; this draft does not silently change the user's ongoing batch WIP.
- The current check implementation returns true when its map is empty (no stored block), whereas earlier prose described true when blocked. Boolean polarity must be explicit; either way it is not a guarantee that a hit fits because CHECK does not inspect exhausted quota.
- Missing usage TTL stays absent and should not be converted to zero or a fabricated deadline. For approximate windows and buckets, the earlier 'time until another hit is permitted' value is not automatically a reset time: it can be zero while remaining capacity is positive. An HTTP adapter must document algorithm-specific timing or the usage timing contract must be refined before mapping it to a reset header. Full bucket refill and next-token availability are distinct times.
- Keep HTTP header formatting outside the limiter's core state API. The current IETF draft uses RateLimit and RateLimit-Policy; the user's RateLimit-Remaining/RateLimit-Reset naming is from earlier conventions. Header-format selection should not determine the Redis protocol or core return types.
- Reviewed source only; no implementation or test files changed, and no Redis scripts/tests were run for this draft.

References: [Retry-After semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) and [current IETF rate-limit field draft](https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-11.html).

## Response timing, batch admission, and check clarification (2026-10-21)

This continues the design discussion. Implementation changes have not been requested for this turn. The following decisions supersede earlier stored-block-only check semantics and next-hit timing for usage states.

### Confirmed user decisions

- Hit throws a quota rejection only for a returned block state. A usage state with zero remaining hits is a successful last accepted hit and must not trigger that exception. Redis/protocol errors remain separate errors.
- Remove the HIT shortcut that omits other relevant blockers. Every limiter without an already-reported stored block needs evaluation, even after another limiter has rejected the batch, so priority selection sees all relevant unavailable states.
- Usage TTL means time until full quota recovery assuming no further hits: an exact sliding window has zero active members, an approximate sliding window has zero estimated usage, and a token bucket is full. An accepted hit reports the recovery time after that hit, including an accepted repeated sliding-window ID's refreshed deadline.
- Block-state TTL supplies the retry duration. Quota exhaustion uses time until the proposed hit fits; a persisted block uses its remaining block lifetime. Fixed-window timing and the previously accepted absent deadline for an unused first-hit window remain unchanged.
- Check must return false when the proposed hit cannot occur and true when it can at the evaluation time. Merely finding no entry in the blocking hash is insufficient.

### User proposals and assistant recommendations

- The user proposed writing new blocks immediately, tracking an is_blocked flag, and executing hit_args only when the flag remains false. This supports batch admission without consuming quota for a rejected hit, provided hit_args contains only usage mutations. A separate block_args queue executed after evaluation is also possible, but is not required by the proposed policy.
- Assistant recommendation: name the flag rejected or can_hit to make clear that exhaustion without block_ttl also rejects a batch. Initialize it from stored blocks, then set rejection for every failed capacity check, independently of whether a new block is persisted. Never infer rejection from a successful post-hit usage count of zero.
- Continue evaluation after rejection. For HIT only, create configured blocks for newly exceeded limiters, including when another limiter already has a stored block; retain existing block deadlines without refreshing them. This treatment of newly exceeded limiters during an already-blocked batch is an assistant recommendation for the proposed sequence, not a separately confirmed user decision.
- On rejection, discard all queued usage increments, insertions, and repeated-ID refreshes and return only block states. Usage values computed for candidate hits describe changes that will not be committed and must not be returned as actual post-hit usage. When every limiter accepts, execute usage mutations and return their post-hit usage states.
- Get must remain read-only and must not create or extend blocks. The exact sliding-window branch currently performs unconditional expired-member cleanup; when adapting it, read only active members for GET and defer physical cleanup to an appropriate write path.
- The user proposed removing Lua CHECK and implementing the public check method through GET. Recommend this: one GET evaluation followed by testing that no state is a block, without a second Redis call. The public method can reuse get selection because any unavailable state takes precedence over usage. The current result.size === 0 test must change because GET returns usage rows for allowed limiters.
- Check should accept and forward the optional hit ID just as get/hit do. For exact sliding windows, an active repeated ID may be accepted with zero remaining unique capacity. Without an ID, check tests capacity for a new unique hit. GET must report usage for an admissible repeated ID even at capacity, and report block for a new ID that cannot fit; stored blocks still reject both. Determine check from state kind, not remaining > 0.
- Check is a read-only snapshot and reserves no capacity; hit still performs its own evaluation before writing.

### Assistant derivation of full-recovery timing

- Exact sliding window: the greatest active member deadline minus the captured time. Use the candidate post-hit state for an accepted hit, including refreshed repeated IDs. The earliest active deadline is used for an exhausted new-ID retry, not for full recovery.
- Approximate sliding window: if the current epoch has usage, full recovery is at the end of the following epoch; if only the previous epoch has usage, it is at the end of the current epoch. In terms of seconds until the current epoch ends, the values are that duration plus one window, or that duration alone, respectively. Use counts after an accepted hit for its response.
- Token bucket: the stored full-refill deadline minus the captured time, or the candidate committed deadline after an accepted hit. A whole-token retry duration remains a separate calculation for exhaustion.
- Recommend zero full-recovery duration when these three algorithms are already empty/full. This is an assistant recommendation for the idle case and does not replace the existing fixed-window deadline conventions.
- Source inspection and design-document updates only; no implementation or test files changed and no Redis scripts or tests were run.

## Authorized result separation and check update (2026-10-21)

### User decisions and implemented scope

- The user explicitly authorized removing CHECK from Lua and TypeScript, updating fixed-window response timing, and implementing check by scanning the result map for blocks or zero remaining usage. Their updated SCRIPT_OP enum already contained only GET and HIT; the Lua CHECK path and stored-block HIT shortcut were removed.
- Keep separate result_blocks and result_usage arrays and use the block array's length for batch admission. There is no separate global rejection boolean. Preserve result_names deduplication so stored or newly created block results cannot be overwritten by fallback quota results.
- HIT evaluates every limiter without an existing stored block, including when another limiter has already rejected. Newly configured blocks are written immediately, independently of queued usage. Existing blocks retain their deadlines. If any block result exists, return only block results and execute no queued usage mutations; otherwise commit all queued usage and return post-hit usage.
- GET combines block and current-usage rows into one native array, with block rows first. It does not create fixed-window counters or blocks. Exhaustion without a persisted block still contributes a block result and therefore prevents batch increments.
- Fixed-window usage TTL is the remaining time until its full window reset. Exhaustion-only block TTL uses that same quota-recovery deadline; a persisted or newly created timed block uses its independent block expiration. Unused aligned windows retain the next-boundary duration; unused first-hit windows omit the duration. The last accepted hit remains a usage row with zero remaining.
- Both public check methods now forward the optional hit ID, execute GET once, and return false if any map entry contains block or usage.remaining <= 0. They return true only when every entry has positive remaining usage. This explicit user rule supersedes the earlier assistant recommendation to test state kind alone. Sliding-window repeated-ID behavior must be reconciled when that WIP branch is adapted; no exception to the requested zero-usage check was introduced here.
- Scope was the shared result/commit plumbing, fixed-window timing, and public check methods. Other algorithm branches and unfinished public get/getAll/hit selection/error handling were not migrated.

### Verification

- Updated the existing fixed-window tests to assert native Redis array replies, including omitted trailing TTL, instead of rewriting returns to JSON. Added batch cases covering exhausted limiters in either order, with and without configured blocks, discarded increments and first-hit initialization, discovery of additional blockers despite an existing block, independent block deadlines, and successful last-slot hits across a batch.
- Added single/batch check tests against Redis for available capacity, exhaustion, existing blocks, and read-only behavior. Focused reply stubs on the shared script exercise zero-remaining usage and optional hit-ID forwarding without introducing another client or adapting the WIP sliding-window implementation.
- All 31 focused tests passed under Vitest and Bun (122 Bun assertions), using redisXClient from test/redis.ts. Confirmed the dedicated database was empty before each runner; tests clean up their own keys and block fields. TypeScript passed. The full algorithm suite and package build were not run because unrelated algorithm/test and packaging WIP remains.
- ESLint, Biome, and whitespace checks passed. Oxlint reported only existing unused-result warnings in the unfinished get/getAll methods and the existing debug console in the response decoder.

## Authorized public hit response selection (2026-10-21)

### User request and implementation

- The user explicitly requested implementing both public hit methods: throw RedisXLimiterExceededError with the strongest block TTL selected from the highest blocked priority, or return the weakest remaining quota independently of priority.
- Both methods execute HIT once and use the same TypeScript selection helper. They do not issue a GET or move presentation priority into Lua. Preserve the user's commented-out get/getAll WIP and existing argument validation.
- Export RedisXLimiterExceededError from the main entry point. It retains the user's limiter instance and ttl properties, and has the error name RedisXLimiterExceededError. The selected limiter and its own TTL always travel together.
- Block selection considers only returned block states: highest numeric priority first, then longest remaining block duration at that priority. An available limiter with a higher configured priority does not hide a lower-priority block. Exact ties use original batch order, independently of Redis reply order.
- Successful hits return the existing UsageState shape: name plus usage.remaining and optional usage.ttl. Export UsageState through the main entry point. A usage state with zero remaining is successful and must not become an exceeded error.
- Weakest usage is the smallest absolute remaining count with no priority filtering. Implementation tie-breaks follow the prior assistant draft: longest known reset duration, then batch order. A known reset duration outranks an absent one in a remaining-count tie; an omitted TTL stays absent in the returned state. These tie-breaks are implementation choices, not a newly explicit user specification.
- Redis failures propagate unchanged. Empty replies, unknown limiter names, and incomplete successful replies fail with ScriptResultError rather than reporting quota rejection or fabricating usage. Rejected replies may contain only the relevant blocked subset.
- Added an explicit boolean return annotation to the user's shared check helper for isolated declaration generation; its runtime behavior is unchanged. No Lua changes were made for this request.

### Verification and separate current-code finding

- All 15 HIT tests passed under Vitest and Bun (33 Bun assertions), using the shared redisXClient. Coverage includes real fixed-window last-slot success and subsequent exhaustion, batch increments, newly created blocks with no companion increments, priority/TTL ordering, unblocked higher-priority metadata, stable ties, optional TTL and hit-ID forwarding, one HIT call, invalid replies, and Redis-error propagation.
- Updated the prior three-hit smoke test to assert returned usage and the newly required exceeded error, with a unique limiter name and cleanup. New tests also clean up only their own keys/block fields. Confirmed the dedicated database was empty before each runner.
- TypeScript, ESLint, Biome, and whitespace checks passed. Oxlint reports the pre-existing decoder console log. Full algorithm suites and package build remain outside this focused validation.
- Separately verified an existing GET regression in the user's current script: return { unpack(result_usage), unpack(result_blocks) } expands only the final unpack fully. It truncates multiple usage rows, and an empty usage array introduces a leading nil that hides subsequent blocks in the Redis reply. The existing test 'single check rejects an existing block even with unused quota' fails because GET decodes to an empty map and check returns true. The HIT branch returns before this expression and is unaffected. Recorded this finding without changing the unrelated GET Lua WIP.

## Review of the user's reusable state implementation (2026-10-21)

- The user replaced the preceding implementation and requested review comments only. No implementation or test files were changed for this review.
- Observed new structure: Lua always returns two arrays, blocks and usage, without per-row status tags. The decoder produces separate maps. Public results use limiter instances with ttl and, for usage, remaining. Shared getLongestBlock/getSmallestLimit functions support the batch get/hit methods, and getAll returns both categories in batch order. These observations supersede the earlier response shapes as a description of the current code.
- Confirmed the new nested-array Lua reply fixes the previous GET unpack/truncation problem. A real mixed-state getAll returned both an available limiter with two hits remaining and a blocked limiter. Fixed-window hit processing still preserves the final accepted hit and separates blocks from discarded usage writes.
- Review finding: check compares the boolean returned by Iterator.some to undefined, so an available limiter with two remaining hits returns false. Negate the some result or positively require every remaining count to be greater than zero, while retaining the no-blocks condition.
- Review finding: getLongestBlock throws for an unblocked limiter that has no entry in block_states. This is normal for a partially blocked batch; both batch.get and batch.hit reproduced a generic internal error when an available limiter preceded a blocked one. Skip missing block states before considering priority.
- Review finding: a higher-priority candidate only replaces the selected block if its TTL is also larger. A priority-10 block lasting 3,600 seconds selected first defeats a priority-100 block lasting 60 seconds. Reversing batch order changes the result. Higher priority must replace unconditionally; compare TTL only for equal priorities.
- Policy difference: getSmallestLimit sorts reset TTL ascending for equal remaining counts. A real batch with one remaining hit in each of 60- and 120-second windows selected the 60-second window. The previous assistant tie-break selected the longest known reset duration. Retain descending known TTL if that prior policy is intended; the user has not separately specified a new tie policy. Exact usage ties currently follow map insertion/reply order rather than the supplied limiter order, although the current Lua usage order normally matches the input.
- Compatibility finding: the new Iterator.some/toArray and Array.toSorted calls exceed the package's declared Node >=16 support. Either retain that support through older APIs or update the supported runtime contract. Iterator helpers shipped in [Node 22's V8 update](https://nodejs.org/en/blog/announcements/v22-release-announce); TypeScript compilation does not add runtime polyfills. A probe with toArray unavailable reproduced a TypeError in usage selection.
- Test maintenance: main.test.ts now performs three hits for a limit of two at module scope, so the third throws before tests can be collected; test assertions and cleanup are commented out. Existing hit/fixed-window tests and reply stubs still use the previous flat Lua reply or name/usage result shape. Migrate fixtures and assertions to the new intentional protocol before interpreting those failures as implementation defects.
- Verification: TypeScript and targeted ESLint checks passed; Oxlint reported the existing debug console and an unused type import. Targeted temporary probes used the real implementation and shared redisXClient against an initially empty dedicated test database, with unique limiter names and cleanup of their own keys and block fields. They reproduced the functional findings above and the corrected GET encoding. No full suite or build was run because test fixtures are not yet migrated to the replacement protocol.

### Concrete replacement guidance

- The user followed up by asking which code needs changing. Provide replacement snippets within their existing helper structure: negate Array.some over Array.from(map.values()) for check, skip absent blocks and compare priority before TTL in getLongestBlock, and use Array.from(...).sort(...) for runtime-compatible usage selection. Recommend descending known reset TTL if retaining the prior weakest-quota tie policy.
- Move the three smoke-test hits into a test, assert the third rejection, use the new flat limiter/remaining/ttl result shape, and restore owned-key cleanup. This follow-up supplies guidance; implementation and test files remain unchanged.

## Verification after fixes and Node 22 minimum (2026-10-21)

- The user explicitly raised the minimum supported Node version; package.json now declares >=22.0.0. Iterator.every/some/toArray and Array.toSorted are supported under this minimum, so the earlier Node 16 compatibility finding is resolved. Native iterator methods may remain; no conversion to Array.from is required for compatibility. References: [Node 22 iterator helpers](https://nodejs.org/en/blog/announcements/v22-release-announce) and [Node 20 copy-by-value array methods](https://nodejs.org/en/blog/announcements/v20-release-announce).
- Confirmed check now uses every(remaining > 0) with an empty-block-map condition. Confirmed getLongestBlock skips unavailable map entries, prefers higher priority independently of TTL, and compares TTL only within equal priorities. Direct selector assertions passed for mixed blocked/available metadata, reversed input order, and same-priority durations.
- Confirmed main.test.ts restores a test and owned-key cleanup; it now asserts two accepted hits followed by RedisXLimiterExceededError. Five focused live Redis tests passed for this smoke case and single/batch check capacity and stored-block behavior. Two old-protocol stub cases were excluded. TypeScript passed.
- Remaining policy difference: getSmallestLimit still selects the shortest known reset TTL when remaining counts tie. A probe with equal remaining counts and reset durations 60/120 selected 60. To retain the prior assistant recommendation of longest known reset first, the comparator must be reversed while placing missing TTL last. No new user decision about the tie-break was inferred.
- Review only: implementation and tests were not edited. The full test suite has not been validated against the new response protocol.

## Public fixed-window test suites (2026-10-22)

- The user requested separate tests for the two fixed-window types in `src/main`, covering every single-limiter method without batching. They removed the method-oriented check/hit suites and requested minimal tests of the resulting product, with no Redis or script-part assertions.
- Added `src/main/fixed-window.test.ts` and `src/main/fixed-window-user-defined-start.test.ts`. Each contains two lifecycle tests using `check`, `get`, and `hit`: quota consumption, exhaustion and recovery; and a configured block that outlasts the counting window without being extended by rejected retries. The quota tests also verify limiting-ID isolation and the distinct clock-aligned/first-hit reset semantics.
- Tests use the shared `redisXClient`, unique limiter names, and real short expiration waits. Direct Redis commands are limited to cleaning up each suite's own keys and block fields. There are no script imports, mocks, Redis-state assertions, or additional clients. `getAll` belongs only to the batch API and is outside this scope.
- Replaced the superseded fixed-window Lua suite and duplicate smoke test with these public API suites. Preserved the user's deleted method suites and left unrelated algorithm/constructor tests and implementation code unchanged.
- Verification: all four new tests passed under Vitest and Bun (60 assertions per runner). TypeScript and targeted Biome, ESLint, Oxlint, and whitespace checks passed. The dedicated test database was empty before each runner. Full-suite validation remains outside this focused request because other algorithm tests still target WIP script interfaces.

### Expiration coverage refinement

- The user additionally requested checking deletion of old hash fields/sorted-set members for every limiter type, including fields in `_block`. This supersedes the earlier restriction against all Redis-state assertions for this specific purpose.
- Both fixed-window suites now verify that a hit creates its usage field and that the field is absent after the window deadline, before another public limiter call. Existing block lifecycle tests verify no stored block before an exceeding hit, block creation on rejection, usage-field expiration while the block remains present, and removal of the block field after its independent deadline. Reuse the existing waits and four lifecycle tests.
- Apply the same requirement when the other limiter types receive public API suites; their script branches remain WIP and were not changed here. For sorted sets, test obsolete-member removal at the algorithm's cleanup point while newer hits remain, as well as idle key expiration; do not assume Redis expires individual members automatically.
- Verification after this refinement: all four tests passed under Vitest and Bun (74 Bun assertions). TypeScript and targeted Biome, ESLint, Oxlint, and whitespace checks passed. No limiter implementation changes were needed.

### Proposal to reduce expiration-test waits

- The user proposed preparing Redis state directly before public API assertions: missing usage, seeded counters, and block state, then exercising check/get/hit immediately. They also proposed reusing two named instances per type, one with block_ttl and one without, instead of generating UUID names. This turn asks for design feedback; no test rewrite is authorized yet.
- Assistant recommendation: use independent prepared states for most cases, including one remaining slot, exhaustion, and an active block even when usage is missing. Seed both the counter and a valid expiration deadline; reset owned usage and block fields before each case. Use descriptive names unique across suites, construct the two instances once, and keep cases sharing a limiting ID sequential.
- Manually deleting a field verifies recovery from absent state but cannot establish that the production script scheduled expiration correctly. Verify deadlines written by real public hits using HEXPIRETIME, including independent block deadlines and preservation on later/rejected hits. Retain a small real-expiration smoke test if actual automatic deletion remains required; seeded-state tests alone do not replace that coverage.
- For exact sliding windows, preparing both expired and live member scores can exercise script-driven cleanup without waits. Other algorithms require internally consistent counter/epoch/deadline fixtures. These recommendations do not change the current tests or the previously requested deletion coverage.

## Authorized state-based fixed-window tests (2026-10-22)

- The user accepted preparing state in Redis and explicitly requested assertions on fields, values, field expiration, and key expiration where relevant. Rewrite the two fixed-window suites with one test per condition, reusable instances, and a database wipe between tests. This supersedes the prior restriction to creating state only through public hits.
- Each suite now creates exactly two named instances once and has seven independent cases: empty window, partially used window with another subject, final available hit, exhaustion without a stored block, creation of a configured block, an existing block with absent usage, and expired usage/block state. Every condition exercises check/get/hit and verifies the resulting database state.
- Added shared test helpers for Redis time, setting a field with a deadline, and reading field expiration. Successful hits must write the correct aligned or first-hit deadline; subsequent hits must preserve it. Blocks retain an empty value and an independent field deadline; rejected retries must not extend it. Hash keys themselves must remain without whole-key expiration.
- Expired-state fixtures set deadlines in the past and verify absence and recovery immediately. The suites separately inspect actual deadlines written by public hits. They contain no sleeps and do not claim to observe the original deadlines elapsing naturally; this replaces the previous long lifecycle waits.
- Each fixed-window case flushes the dedicated test database before setup, and each suite flushes after completion. Vitest now disables file parallelism in its configuration so a normal vitest run also respects this shared-database isolation. Existing constructor tests remain unchanged; no batching or limiter implementation changes were introduced.
- Verification: all 23 current tests passed under Vitest in 605 ms and Bun in 100 ms (209 Bun assertions), including 14 fixed-window conditions. TypeScript, Biome, ESLint, Oxlint, and whitespace checks passed. The dedicated Redis test database was empty after both runners.

## Restored exact sliding-window implementation (2026-10-22)

- The user requested restoring the exact sliding-window Lua branch for the current operation/result protocol and adding a test file matching the fixed-window suites. Approximate sliding windows and token buckets remain unchanged WIP.
- The branch counts only scores strictly greater than the captured Redis timestamp. Missing or expired hit IDs consume one distinct slot; active repeated IDs consume none and refresh their deadlines on accepted hits. The user explicitly confirmed that check(subject, existingHitId) must return true at full unique capacity when no stored block exists. The shared check helper now uses the GET block map to preserve that admission meaning; fixed-window exhaustion still returns a block.
- GET ignores stale members without deleting them, refreshing scores, or changing key expiration. Accepted HIT queues stale-member removal, ZADD, and EXPIREAT in the existing deferred write list, so rejection of the operation discards all usage changes. Existing blocks deny repeated IDs too and retain their deadlines; new configured blocks are written through the existing uniform blocking helper.
- Usage TTL describes full recovery at the latest active deadline, including the accepted hit/refresh. An empty window returns full capacity with TTL zero. Exhaustion-only block TTL uses the deadline that frees a slot for the requested new ID (normally the earliest active score). Stored/new block TTL remains independent of sorted-set expiration.
- Added src/main/sliding-window.test.ts with nine independent conditions and two reusable named limiter instances, using the shared client and database resets. Cases cover empty windows, expired-member cleanup and limiting-ID isolation, refreshing a repeated ID at capacity, rejecting expired/new IDs, independent block creation, blocks overriding repeats, blocks outliving the sorted-set key, recovery from expired state, and generated distinct IDs. Assertions inspect full member/score maps, key expiration, block field value/deadline, and public results without sleeps or batch tests.
- Verification: all 32 current tests passed under Vitest (745 ms) and Bun (162 ms, 307 assertions). TypeScript, Biome, ESLint, Oxlint, and whitespace checks passed. ESM/CommonJS bundles and declarations compiled, and the tracked distribution bundles were refreshed. The build command's publishing check still fails because the existing @redis-x/client dependency points to a local /tmp/devpack tarball; no dependency changes were made.

## Restored check guard and planned hit-uniqueness metadata (2026-10-22)

- The user requested restoring check's previous behavior because accepting any usage state solely from an empty block map gives incorrect admission information for other limiter types. Restore the remaining-capacity guard now and plan an explicit script flag for hits that do not increment usage. Only the guard, corresponding test expectation, and distribution bundles change now; the Lua reply/type extension is deferred.
- Current behavior after restoration: check returns true only with no blocks and positive remaining capacity for every usage row. At full unique capacity it temporarily returns false even for an active repeated ID; the actual sliding-window hit still succeeds and refreshes the member. The existing repeated-ID test records this interim distinction.
- Latest user decision: replace the proposed increment field with is_hit_unique and place it after TTL. Exact sliding-window usage rows become [name, remaining, ttl, is_hit_unique]; other limiter types emit [name, remaining, ttl], leaving is_hit_unique undefined in JavaScript. Use -1 instead of nil for an absent TTL in the Lua usage reply, keeping the TTL position occupied. This supersedes the assistant's earlier increment-before-optional-TTL proposal.
- Assistant encoding recommendation: send is_hit_unique as 1 or 0 and validate/decode it into an optional boolean. Preserve absence as undefined instead of coercing it to false. True means a new or expired ID; false means an already-active repeated ID. For TTL, normalize -1 back to undefined if retaining the current optional JavaScript/public TTL API; this normalization is a recommendation rather than a separately confirmed user requirement.
- Implementation plan: make each usage-producing Lua branch supply a numeric TTL (including the -1 sentinel); append uniqueness only for exact sliding windows; update UsageState and the decoder; then make check require an empty block map and every row to satisfy remaining > 0 OR is_hit_unique === false. Missing flags must not bypass the capacity guard. This is per-limiter metadata, so an admissible repeated ID cannot bypass exhaustion elsewhere in a batch. Block rows retain precedence and their existing format.
- GET determines uniqueness without mutations; HIT determines it from pre-hit membership and still refreshes an accepted repeated ID's score and key deadline. A non-unique hit does not mean no Redis writes. Remaining stays the real quota count and may stay zero; never inflate it to signal admission. Successful last-slot HIT results remain successful usage even when their post-hit remaining count is zero.
- Planned regression coverage: zero remaining with is_hit_unique true or undefined rejects; zero remaining with is_hit_unique false permits an unblocked repeat; stored blocks reject either; expired IDs are unique; capacity-positive ordinary hits still permit access; accepted repeats retain zero remaining while refreshing deadlines; absent first-hit-window TTL uses -1 on the wire and other types omit the flag. Retain limiter-type-oriented tests. This turn refines the protocol plan; Lua, TypeScript, tests, and bundles remain unchanged.
- Verification of the restoration: all 32 tests passed under Vitest and Bun. TypeScript, Biome, ESLint, Oxlint, and whitespace checks passed. Rebuilt ESM/CommonJS bundles and declarations directly with tsdown; the previously reported publishing-validation issue was not rechecked or changed. Existing staged changes were preserved.

### Authorized usage type update (2026-10-22)

- The user requested updating types for the planned hit-uniqueness behavior. Added optional is_hit_unique: boolean after ttl to both internal UsageState and public RedisXLimiterUsage, documenting pre-operation membership: true for a new/expired sliding-window ID, false for an active repeat, and omitted for other limiter types.
- This change prepares the types only. Lua encoding, reply decoding, public result mapping, and check's capacity guard remain pending. JavaScript TTL remains optional; the proposed Lua -1 sentinel does not require changing the existing public TTL type.
- Verification: TypeScript, targeted Biome/ESLint/Oxlint, and whitespace checks passed. Regenerated ESM/CommonJS declarations with tsdown. No runtime tests or publishing validation were run for this type-only change.

### Required boolean and completed runtime integration (2026-10-22)

- The user clarified that the previous type-only update was insufficient: is_hit_unique must be used throughout the implementation and in check. It is a required boolean for every JavaScript usage result. It can be false only for active repeated sliding-window IDs; all other limiter types always report true. This supersedes the earlier optional/undefined JavaScript metadata plan.
- Sliding-window Lua usage rows append 1 for a new/expired ID or 0 for an active repeat, after TTL. Other types may omit this wire slot. The decoder validates the flag and uses is_hit_unique !== 0, preserving true for omitted flags. The user explicitly confirmed this decoding rule.
- Lua uses -1 for absent first-hit-window reset TTL; the decoder preserves the existing public undefined TTL. Single get/hit, batch get/hit selection, and batch getAll carry the required boolean through to callers. Both check methods use the shared no-blocks AND every(remaining > 0 OR !is_hit_unique) predicate.
- Existing limiter-type tests now assert true/false usage metadata, acceptance of repeated IDs at capacity, rejection of expired IDs at capacity, and true metadata for both fixed-window types. Stored blocks still reject repeated IDs; the last accepted unique hit still returns successful usage with zero remaining. Sequential awaits are intentional in tests; the user approved keeping the loop and added its lint exception.
- Verification: all 32 tests passed in Vitest and Bun (308 Bun assertions). TypeScript, Biome, ESLint, and whitespace checks passed. Oxlint completed successfully with one max-lines warning for the sliding-window suite (315 nonblank/noncomment lines; configured limit 300). Regenerated ESM/CommonJS bundles and declarations with tsdown; publishing validation was not rerun. Approximate sliding windows and token buckets remain WIP.

## Restored approximate sliding-window implementation (2026-10-22)

- The user requested restoring the approximate sliding-window Lua branch and adding a limiter-type test suite. The branch now uses the current GET/HIT operations, separate usage/block results, uniform blocking helper, and deferred usage writes. Token buckets remain unchanged WIP.
- Estimate usage from the current epoch count plus the previous epoch count weighted by the remaining fraction of the current window. Admit a new hit only when estimated usage plus one fits. Return whole remaining hits rounded down, and preserve successful last-slot HIT results as usage with zero remaining. Omitted Lua uniqueness metadata decodes to is_hit_unique true, as for other ordinary-hit limiters.
- GET and check do not create fields or blocks. Accepted HIT creates or increments only the current epoch/subject field; its expiration is the end of the following epoch. Incrementing an existing field preserves its deadline. Queued usage changes are still discarded if any limiter rejects.
- Usage TTL reports full recovery: zero for empty state, time to the current epoch's end for previous-only usage, or time to the following epoch's end when the current epoch has usage, including a newly accepted hit. Exhaustion TTL uses the previously derived rounded-up time until one whole hit fits, covering decay within the current epoch and rollover followed by decay. A configured block created by HIT retains its independent duration.
- Added src/main/sliding-window-approximate.test.ts with eight prepared-state cases and two reusable limiter instances. Coverage includes every single-limiter method, empty and previous-only state, weighted last-slot admission, both retry paths, configured and existing blocks, subject isolation, and recovery from expired epoch/block fields. Tests assert counters, field deadlines, key expiration where relevant, and read/rejection preservation without sleeps, additional clients, or batching.
- Verification: all 40 tests passed under Vitest and Bun (404 Bun assertions). TypeScript and targeted Biome, ESLint, Oxlint, and whitespace checks passed. Regenerated ESM/CommonJS bundles and declarations directly with tsdown; publishing validation was not rerun.

## Restored integer token-bucket implementation (2026-10-22)

- The user requested restoring the token-bucket Lua branch and adding a limiter-type test suite. Restored the accepted integer counter/cumulative expiration representation for the current GET/HIT operations, separate usage/block results, uniform blocking helper, and deferred writes. Other limiter branches remain unchanged.
- Recover the implicit refill anchor from the integer counter and field deadline. Rebase a counter equal to capacity by advancing the anchor one refill duration before incrementing; this preserves refill progress while keeping stored integers bounded. The anchor may be in the future after rebasing. Round cumulative refill duration once when calculating the candidate hit's new deadline.
- Return whole available tokens rounded down from the counter and elapsed refill time, with is_hit_unique true. Usage TTL is the existing full-refill deadline minus Redis time for GET, or the candidate committed deadline minus Redis time for an accepted HIT. An unused/fully refilled bucket returns full capacity and TTL zero. A successful last-token hit still returns usage with zero remaining.
- Exhaustion returns time until the next whole token fits, or the configured independent block duration when HIT creates a block. GET/check remain read-only; rejected hits do not increment, rebase, or refresh usage. Accepted hits queue HSET of an integer string and HEXPIREAT through the existing batch commit path.
- Added src/main/token-bucket.test.ts with eight prepared-state conditions and two reusable limiter instances. Coverage includes every single-limiter method, partial refill and subject isolation, rebasing with a future anchor, cumulative expiration rounding, last-slot acceptance, exhaustion, independent blocks, and expiration/recovery of both usage and block fields. Tests assert public results plus stored integers and deadlines, use the shared Redis client, and contain no sleeps or batch cases. Sequential awaits intentionally verify successive accepted hits.
- Verification: all 48 tests passed under Vitest and Bun (504 Bun assertions). TypeScript and targeted Biome, ESLint, Oxlint, and whitespace checks passed. Regenerated ESM/CommonJS bundles and declarations directly with tsdown; publishing validation was not rerun.

## Query API and focused batch coverage (2026-10-22)

- The user requested removing hit IDs from get and getAll because these methods query the current limit rather than a caller-specified hit. Both single/batch get and batch getAll now accept only the limiting ID and call the shared GET path without a caller-provided hit ID. Check and hit retain their optional hit IDs; the Lua operation/result protocol is unchanged.
- Updated sliding-window tests to query get(subject). At full distinct capacity get reports exhaustion and its retry TTL, while check(subject, activeHitId) still permits an active repeat and hit refreshes it without consuming another slot. This keeps general capacity reporting separate from testing permission for a particular repeated ID.
- The user additionally authorized batch tests focused on class execution and returned objects in one representative case. Added src/main/batch.test.ts with one mixed scenario spanning all five types, using the shared redisXClient and isolated database resets. It verifies read-only queries, ordered getAll results, duplicate-instance deduplication, one successful atomic hit, every resulting counter/member/deadline, and rejection without partial usage writes.
- The same scenario verifies weakest-usage selection independently of priority, successful zero-remaining usage, repeated-ID checks still respecting other exhausted limiters, discovery/creation of all applicable blocks, and selection of the longest block at the highest blocked priority. Higher-priority available limiters do not hide blocks. No algorithm edge-case matrices or additional Redis clients were added.
- Verification: all 49 tests passed under Vitest and Bun (540 Bun assertions); the batch test was rechecked after extracting its state assertions into a helper. TypeScript, Biome, ESLint, and whitespace checks passed. The new batch test passes Oxlint without warnings; the existing sliding-window suite retains its max-lines warning. Regenerated ESM/CommonJS bundles and declarations, confirming get/getAll expose only the limiting ID. Publishing validation was not rerun.
