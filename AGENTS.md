# Limiter redesign: agent instructions and design record

Last updated: 2026-10-20.

## Working agreement

- Keep this file current as the user makes requests and decisions about the redesign. Update it during subsequent design discussions.
- Do not write or change implementation code until the user explicitly asks. Maintaining this design document is authorized.
- Distinguish user decisions and proposals from assistant recommendations, technical findings, and unresolved questions. Do not turn an assistant suggestion into an accepted requirement without user agreement.
- Treat this as the intended new design, not documentation of behavior already implemented. Preserve unrelated existing work.
- Prefer the latest explicit user decision when it supersedes an earlier discussion.

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
- The user accepted sorted sets for exact sliding-window storage on 2026-10-19. The other algorithms retain the proposed Redis hashes with expiring fields. Blocks use the separately accepted uniform hash described below; repeat-hit behavior and some blocking lifecycle details remain open.

## Execution architecture: user decisions

- Have two Lua entry-point scripts: a read-only check script and a hit script.
- Each script supports all limiter types and accepts a list of limiters with their parameters.
- Checking or hitting multiple limiters together is a first-class requirement.
- The hit script performs its own checks before the relevant writes within the same execution. A prior separate check is not required for every hit and does not reserve capacity.
- Represent each limiter as a class instance with methods. Instances prepare/expose the keys and arguments required by the shared script execution path.
- Provide another class whose constructor accepts limiter instances and whose methods operate on the group.
- Single-limiter and group calls must use the same underlying function that executes the script. A single-limiter operation is a batch of one; a group gathers inputs for one script call rather than calling each member's public hit method separately.
- When reporting a blocked batch, select the active block with highest priority, breaking priority ties by largest remaining block TTL. Lower-priority blocks remain enforced but are hidden from the reported blocking result.
- Exact class names, method signatures, argument encoding, and returned result format are not yet selected.

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
| Token bucket (hash) | Named limiter, subject to the wording clarification below | Hash field: limiting ID | Remaining token count | Field expires when the bucket would become full without further hits |

### Fixed window

- Both clock-aligned windows and user-defined starts are intended.
- A user-defined start changes the expiration calculation only; it does not require a different storage layout.
- Whether a user-defined start means automatically starting on the first hit or an explicitly supplied anchor still needs a precise API definition.

### Exact sliding window

- This is the only limiter type intended to support counting distinct values.
- The user accepted a sorted set per named limiter and limiting ID, superseding the original hash-per-subject proposal.
- Each hit ID is a sorted-set member. The reviewed representation uses its score as an absolute deadline and counts active scores rather than relying on physical expiration cleanup.
- Repeated use of a hit ID must not add another distinct entry while that ID is active.
- Whether repeats refresh the member's deadline remains unresolved; last-seen semantics is the assistant recommendation.

### Approximate sliding window

- Read the fields for the current and previous epochs of the same limiting ID to calculate the result.
- Retain each epoch's field for two window lengths.
- The exact expiration anchor and weighting/boundary calculation remain to be specified. Do not accidentally refresh an epoch's lifetime indefinitely on each hit.

### Token bucket

- Store remaining tokens in the limiting ID's field.
- Set the field's expiration to the instant when the bucket would be full if no further hits occurred.
- The user's intended design uses this expiration timestamp, current time, and the limiter's parameters to calculate the current remaining tokens.
- The original description says "hash field contains limiter id; field contains limiting id." The table interprets the first phrase as the hash key containing the named limiter's identifier. Confirm that interpretation before implementation.
- Continuous versus discrete refill, rounding, the precise role of the stored token value, and behavior when capacity/refill settings change are not yet defined.

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
- For a true count of distinct IDs seen during the preceding window, each repeated ID must refresh its last-seen time/deadline. Keeping only the first occurrence's deadline implements a different policy: deduplication for a fixed period after first observation. Example: with a ten-minute window, an ID hit at minute 0 and again at minute 9 must still count at minute 11 under last-seen semantics. The user has not selected repeat behavior.
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
- For the proposed last-seen semantics, update a repeated member's score to now plus the window length. Membership remains unique while its deadline advances.
- Fresh random hit IDs count ordinary events; stable resource/username IDs count distinct values. Different members may share an identical score without being merged.
- Set the whole key's expiration no earlier than the maximum remaining member deadline. This removes idle state after all members become irrelevant. Keep a longer block independently alive.
- Use the same shared batch executor and captured time as the other algorithms. Choosing a different Redis data type does not require another public execution path.
- ZADD and ZCOUNT are O(log N); removing M expired members is O(log N + M). The tradeoff is one key per limiter/subject pair plus explicit cleanup during writes. Measure memory and latency before claiming an improvement over hashes.
- For an admission-style operation, read candidate membership and compute incremental distinct cost before deciding whether to mutate. For failure recording, apply the eventual observed-event policy. This alternative does not settle the existing batch policy question.

References: [ZADD](https://redis.io/docs/latest/commands/zadd/), [ZCOUNT](https://redis.io/docs/latest/commands/zcount/), and [ZREMRANGEBYSCORE](https://redis.io/docs/latest/commands/zremrangebyscore/).

The user accepted sorted-set storage and the separate uniform block hash on 2026-10-19. Repeat-hit semantics, batch policies, and some block lifecycle details remain open.

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
