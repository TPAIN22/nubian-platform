● Notification Queue Migration — Design                                                                                                                      
                                                                                                                                                             
  Before any code changes, here's the architecture proposal. After you sign off (or redirect), I'll implement in clearly separated commits.
                                                                                                                                                             
  Verified state: backend is ESM (Express 5, Node 18+), no BullMQ/ioredis/Redis yet, single process, no separate workers. Resend, axios, Winston, MongoDB    
  already wired.                                                                                                                                             
                                                                                                                                                             
  ---                                                       
  1. Architecture changes

  Today (synchronous)

  HTTP request ──▶ controller ──▶ notificationService.createNotification()
                                    │
                                    ├─ check prefs / dedup / rate-limit
                                    ├─ insert Notification doc
                                    └─ axios.post() to Expo  ◀── blocks the request
  Failure modes: Expo slow → API request slow. Expo down → notification lost (status=failed, no retry). Broadcast to 100k users → 100k axios calls in one
  IIFE that the Node event loop has to babysit.

  After (queue-based)

  HTTP request ──▶ controller ──▶ notificationService.createNotification()
                                    │
                                    ├─ check prefs / dedup        (cheap, Mongo)
                                    ├─ insert Notification (status=queued)
                                    └─ enqueue job ──▶ Redis ──▶ returns
                                                         │
                                                         ▼
                                                ┌────────────────┐
                                                │  Workers       │
                                                │  (separate     │
                                                │   processes)   │
                                                └─ push  ─ Expo  │
                                                └─ email ─ Resend│
                                                └─ sms   ─ TBD   │
                                                └─ fanout ─ splits broadcasts

  Producer side (API process):
  - notificationService.createNotification() becomes thin: prefs check + Mongo insert + queue.add(). No HTTP I/O. Returns the persisted doc with
  status='queued'.
  - Broadcasts (batchCreateNotifications) bulkWrite the docs, then enqueue a single fanout job carrying recipient IDs in chunks. The fanout worker
  re-enqueues per-channel send jobs.

  Consumer side (workers):
  - Standalone Node processes, each subscribing to one or more queues. Same codebase, different entrypoint (src/workers/index.js).
  - Workers import the same Mongoose models and reuse the existing sendPushNotification logic — split out of notificationService.js into pure delivery
  functions in services/channels/*.

  Key invariants preserved:
  - Existing REST API contracts unchanged — POST /notifications/broadcast still returns { status: 'processing' }; inbox GETs are unchanged; mark-read is
  unchanged.
  - The Notification document is still the source of truth. Workers update its status on each terminal outcome.
  - Notification preferences, dedup key, quiet hours, anti-spam — all still evaluated. Quiet hours move from "check inside push send and silently shelve" to
  "compute delayUntil at enqueue time and use BullMQ's delay option" — much cleaner.

  ---
  2. Worker topology

  One worker entrypoint, multiple roles selected by env, so the same image deploys differently:

  src/workers/index.js   <- read WORKER_ROLES env, instantiate the listed Workers
  src/workers/push.worker.js
  src/workers/email.worker.js
  src/workers/sms.worker.js
  src/workers/fanout.worker.js
  src/workers/maintenance.worker.js   <- DLQ retries, token cleanup, expired notifs

  WORKER_ROLES=push,email,fanout       # one combined worker (small deploys)
  WORKER_ROLES=push                    # dedicated push worker (scale-out)
  WORKER_ROLES=fanout,maintenance      # control-plane worker

  Concurrency (BullMQ concurrency per Worker):

  ┌─────────────┬─────────────┬───────────────────────────────────────────────────────────────────────────────────────────┐
  │   Worker    │ Concurrency │                                         Reasoning                                         │
  ├─────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ push        │ 10          │ Expo accepts 100 messages/HTTP call; we batch inside one job. CPU-light, mostly I/O-wait. │
  ├─────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ email       │ 5           │ Resend rate-limits ~10 req/s on free tier; conservative.                                  │
  ├─────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ sms         │ 2           │ Cost-sensitive; small concurrency limits blast radius on bugs.                            │
  ├─────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ fanout      │ 3           │ One fanout job emits hundreds of children — keep it modest.                               │
  ├─────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ maintenance │ 1           │ Sequential admin work; cron-ish.                                                          │
  └─────────────┴─────────────┴───────────────────────────────────────────────────────────────────────────────────────────┘

  Deployment recommendation: start with one combined worker process alongside the API. Render/Railway free tiers allow a worker dyno; if you can't afford a
  separate process yet, add WORKER_ROLES to the API process under a feature flag (RUN_WORKERS_INPROCESS=true) — same code, same Redis, just colocated.
  Default to OFF so this is opt-in until you're ready.

  ---
  3. Queue naming strategy

  Pattern: nubian:notif:<channel> — short, prefix-namespaced (so multiple Nubian environments can share a Redis instance via REDIS_PREFIX).

  ┌──────────────────────────┬──────────────────────────────────────────────────────────────────────┬───────────────────────────────────┬────────────────┐
  │          Queue           │                             Job type(s)                              │             Producer              │    Consumer    │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────┼───────────────────────────────────┼────────────────┤
  │ nubian:notif:push        │ send                                                                 │ notificationService               │ push worker    │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────┼───────────────────────────────────┼────────────────┤
  │ nubian:notif:email       │ welcome, order, merchant_suspension, merchant_unsuspension,          │ mailService (new wrapper around   │ email worker   │
  │                          │ order_status_update, transactional (generic)                         │ lib/mail.js)                      │                │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────┼───────────────────────────────────┼────────────────┤
  │ nubian:notif:sms         │ send                                                                 │ future                            │ sms worker     │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────┼───────────────────────────────────┼────────────────┤
  │ nubian:notif:fanout      │ broadcast, segment, marketing                                        │ broadcast/marketing controllers   │ fanout worker  │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────┼───────────────────────────────────┼────────────────┤
  │ nubian:notif:maintenance │ dlq-retry, token-cleanup, expired-notifs                             │ repeatable jobs                   │ maintenance    │
  │                          │                                                                      │                                   │ worker         │
  └──────────────────────────┴──────────────────────────────────────────────────────────────────────┴───────────────────────────────────┴────────────────┘

  Why per-channel queues (not one big queue):
  - Each channel has different retry/backoff/concurrency profiles.
  - A storm of failed emails won't starve push delivery.
  - Independent monitoring (queue depth per channel = clear ops signal).

  Why a fanout queue separately: producers stay fast even for million-recipient broadcasts. The fanout worker reads recipients in chunks (e.g. 1000) and
  emits child push:send jobs, so memory stays bounded and the producer HTTP request returns instantly.

  Job IDs for dedup: pass jobId = deduplicationKey to queue.add(). BullMQ rejects duplicate jobIds within their TTL window — gives us idempotent enqueueing
  for free, even if createNotification is called twice for the same ORDER_CREATED_<id>.

  ---
  4. Retry policies

  BullMQ attempts + backoff: { type: 'exponential', delay: <ms> }.

  ┌───────────────────────┬──────────┬──────────────┬───────────────────────┬─────────────────────────────────────────────────────────────────┐
  │         Queue         │ attempts │ backoff base │ max delay (5th retry) │                               Why                               │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ push                  │ 5        │ 2s           │ ~32s                  │ Expo is reliable; transient glitches recover quickly.           │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ email (transactional) │ 6        │ 5s           │ ~2.5min               │ Resend may rate-limit; longer tail than push.                   │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ email (marketing)     │ 3        │ 30s          │ ~4min                 │ Lower stakes; don't waste retries.                              │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ sms                   │ 3        │ 30s          │ ~2min                 │ Cost per send — fail fast.                                      │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ fanout                │ 3        │ 10s          │ ~80s                  │ Splitter; if it can't read recipients twice, give up and alert. │
  ├───────────────────────┼──────────┼──────────────┼───────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ maintenance           │ 2        │ 60s          │ 2min                  │ Cron-driven; will run again next tick anyway.                   │
  └───────────────────────┴──────────┴──────────────┴───────────────────────┴─────────────────────────────────────────────────────────────────┘

  Permanent failures bypass retries: workers throw a special UnrecoverableError (BullMQ-supported) for cases like DeviceNotRegistered from Expo, invalid
  token, or 4xx from Resend (bad recipient). These move straight to failed without consuming retry budget.

  Per-retry failure write-back: workers update the Mongo Notification doc on each attempt: status='retrying', attempts+=1, lastError, lastAttemptAt. Final
  failure → status='failed'. This keeps the inbox consistent with what actually happened.

  ---
  5. Dead-letter handling & failure recovery

  BullMQ already gives us a failed job set per queue (jobs that exhausted retries stay there with their stack trace). On top of that:

  1. DLQ-by-convention, not separate Redis keys. Each queue's native failed set is the DLQ. No per-queue DLQ queues to maintain — fewer moving parts.
  2. Operational endpoints (/api/admin/queues/*) under admin auth:
    - GET /admin/queues/stats → counts (waiting/active/delayed/failed/completed) per queue.
    - GET /admin/queues/:queue/failed?limit=50 → list failed jobs with reason.
    - POST /admin/queues/:queue/retry → bulk retry all failed (or selected IDs).
    - POST /admin/queues/:queue/drain → drop failed jobs older than N days.
  3. Maintenance worker, repeatable jobs:
    - dlq-sweep (every 6h): for each queue, find failed jobs whose Notification doc is younger than its expiresAt AND not already retried by the sweeper,
  requeue once. Marketing marked failed is left alone.
    - token-cleanup (daily): wires up PushToken.cleanupExpiredTokens() (currently defined but never invoked — already flagged in the report).
    - expired-notifs (daily): hard-delete Notification rows where expiresAt < now() - 30d to keep the collection bounded.
  4. Failure budget alarms: Winston already in place. Workers log structured { event: 'notif.send.failed', channel, type, attemptsMade, willRetry }. Hook a
  metrics exporter later — out of scope for this migration.
  5. Redis outage: producer's queue.add() will throw. We wrap it in enqueueOrFallback():
    - In dev (ENABLE_QUEUE=false), fall through to the existing synchronous send path — zero behavior change.
    - In prod, mark notification status='failed', lastError='redis_unavailable', log error, return doc. The maintenance worker's dlq-sweep will retry these
  on its next tick once Redis is back.

  ---
  6. API requests never wait for delivery

  Concrete contract changes:

  ┌───────────────────────────────────────┬───────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┐
  │               Endpoint                │                        Before                         │                        After                         │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┤
  │ POST /notifications/broadcast         │ already returns processing immediately, then a        │ bulk-insert + 1 fanout enqueue, returns same shape — │
  │                                       │ fire-and-forget IIFE                                  │  but no orphan IIFE risk                             │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┤
  │ POST /notifications/marketing         │ await createMarketingNotification (which can sit in   │ enqueue fanout, return immediately                   │
  │                                       │ axios calls for a long time on big targets)           │                                                      │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┤
  │ POST /notifications/test              │ awaits Expo round-trip                                │ enqueue push, return notification doc with           │
  │                                       │                                                       │ status='queued' (mobile will see sent shortly)       │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Order creation handleOrderCreated     │ already wrapped in .catch() fire-and-forget at        │ becomes truly fire-and-forget — createNotification   │
  │                                       │ controller (order.controller.js:238)                  │ returns in <50ms                                     │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Email sends from lib/mail.js          │ inline await resend.emails.send()                     │ wrapped behind mailService.queue<X>Email(), enqueued │
  │ (welcome, order, suspension)          │                                                       │                                                      │
  └───────────────────────────────────────┴───────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┘

  The 95th-percentile request latency contribution from the notification system should drop to single-digit ms (just the Mongo insert + queue.add
  round-trip).

  ---
  7. Migration risks

  ┌──────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────┐
  │                           Risk                           │                                        Mitigation                                         │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Redis becomes a new SPOF for notifications               │ Feature flag (ENABLE_QUEUE=false by default). Keep current sync path as fallback. Roll    │
  │                                                          │ out per-channel: enable push first, observe a week, then email.                           │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Workers deploy out of sync with API (old worker reading  │ Version the job payload ({ v: 1, ... }). Worker rejects unknown versions and DLQs them —  │
  │ new job shape)                                           │ no silent corruption.                                                                     │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ notification.status semantics change ('pending' will     │ Rename to 'queued' (new status) and add to enum. Mobile/dashboard already only display    │
  │ appear before delivery resolves)                         │ sent/failed/delivered; existing code that reads status will still match those. Audit      │
  │                                                          │ confirmed no caller does if status==='pending' logic.                                     │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Quiet hours: today, push gets shelved as pending and is  │                                                                                           │
  │ never resent. After: enqueue with delay =                │ Net behavior improvement, but document it.                                                │
  │ msUntilEndOfQuietHours.                                  │                                                                                           │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ lib/mail.js is currently called inline from controllers  │ Acceptable: emails were already best-effort (callers wrapped in .catch). For critical     │
  │ — switching to queue means callers can't see send errors │ transactional emails (welcome on signup), allow a priority: 'critical' flag that uses a   │
  │  immediately.                                            │ higher BullMQ priority + tighter retry.                                                   │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ BullMQ requires Redis ≥6.2 (streams).                    │ Document in .env.example. Render/Upstash/Railway all default to 7.x.                      │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Existing /api/notifications/broadcast's IIFE will be     │ Standard rolling deploy + maintenance worker's dlq-sweep covers any orphans on next       │
  │ removed → existing in-flight broadcasts during deploy    │ start.                                                                                    │
  │ could be lost                                            │                                                                                           │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Mongo + Redis dual-write consistency: notif doc inserted │ Already covered by enqueueOrFallback — fall back to sync send (dev) or mark failed for    │
  │  but enqueue fails                                       │ sweeper retry (prod).                                                                     │
  ├──────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────┤
  │ Tests: no integration tests exercise notif flow today    │ Add __tests__/notification.queue.test.js using ioredis-mock + in-memory Mongo.            │
  │                                                          │ Out-of-scope for migration phase 1; included in phase 4.                                  │
  └──────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────┘

  ---
  8. Incremental implementation plan

  Each step is one PR / one commit, atomic and reversible. Steps 1–3 add infra without changing call sites. Step 4 is the actual cutover, gated by
  ENABLE_QUEUE. Step 5+ retires the synchronous path once we're confident.

  #: 1
  Commit: add deps + env scaffolding
  Files: package.json (+bullmq, ioredis), .env.example, lib/envValidator.js, lib/queue/redis.js (singleton ioredis with retry)
  Behavior change: none — no callers yet
  ────────────────────────────────────────
  #: 2
  Commit: queue + worker scaffolding
  Files: lib/queue/queues.js (queue factory, naming, default options), lib/queue/jobShapes.js (typed job payloads), services/channels/push.channel.js (move
    logic out of notificationService), services/channels/email.channel.js (move out of lib/mail.js controllers, wrap), workers/index.js,
    workers/push.worker.js, workers/email.worker.js, workers/fanout.worker.js, workers/maintenance.worker.js, package.json script worker
  Behavior change: none — workers don't run unless WORKER_ROLES is set
  ────────────────────────────────────────
  #: 3
  Commit: producer plumbing behind flag
  Files: services/notificationService.js (add enqueueOrFallback, no-op when ENABLE_QUEUE=false), models/notification.model.js (add 'queued' and 'retrying' to

    status enum, attempts, lastError, lastAttemptAt fields)
  Behavior change: none — flag off
  ────────────────────────────────────────
  #: 4
  Commit: cutover push channel
  Files: flip notificationService.createNotification to enqueue when flag on; remove direct Expo call from sync path (still callable as fallback). Update
    routes/notifications.route.js only if needed (probably not).
  Behavior change: flag-gated; default off
  ────────────────────────────────────────
  #: 5
  Commit: cutover email channel
  Files: new services/mailService.js wrapping lib/mail.js with queueWelcomeEmail, queueOrderEmail, etc. Replace direct calls in user.controller.js:107,
    order.controller.js:234, merchant.controller.js:588,705.
  Behavior change: flag-gated
  ────────────────────────────────────────
  #: 6
  Commit: fanout & broadcast cutover
  Files: controllers/notification.controller.js sendBroadcast → enqueue fanout job; notificationService.batchCreateNotifications → emit fanout jobs from
    worker
  Behavior change: flag-gated
  ────────────────────────────────────────
  #: 7
  Commit: admin DLQ endpoints
  Files: routes/queues.admin.route.js, controllers/queues.admin.controller.js mounted at /api/admin/queues/* (admin-only)
  Behavior change: new endpoints
  ────────────────────────────────────────
  #: 8
  Commit: maintenance jobs
  Files: repeatable jobs in workers/maintenance.worker.js: token cleanup, dlq sweep, expired notifs
  Behavior change: replaces nothing; adds the missing token cleanup
  ────────────────────────────────────────
  #: 9
  Commit: flip default
  Files: ENABLE_QUEUE=true in .env.example, document in CLAUDE.md
  Behavior change: once observed stable
  ────────────────────────────────────────
  #: 10
  Commit: retire sync path
  Files: drop fallback branches in notificationService + lib/mail.js after a stable production window
  Behavior change: cleanup, optional

  Steps 1–3 are pure additions and safe to merge any time. Step 4 is the first moment behavior changes (only with flag on).

  ---
  9. Open questions before I start

  1. Redis provider — do you have Upstash / Railway / a managed Redis in mind, or should I assume a local redis://localhost:6379 for dev and document
  REDIS_URL as the prod knob?
  2. Worker deployment shape — separate worker process from day one, or in-process via RUN_WORKERS_INPROCESS=true until you have a second dyno? (Code is
  identical; only package.json scripts and Render config differ.)
  3. Scope of this round — do you want me to land all 10 steps, or stop after step 4 (push cutover) so you can validate before email/fanout?
  4. Submodule note — apps/backend is a submodule with its own remote. I'll need to commit inside apps/backend/. Confirm I should land commits there directly
   (not in the umbrella repo).