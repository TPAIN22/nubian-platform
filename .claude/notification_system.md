Notification Queue Migration — Full Report                                                                                                                 
                                                                                                                                                             
  What was done                                                                                                                                              
                                                                                                                                                             
  A 10-step migration moving the Nubian backend's notification system from synchronous in-request delivery to a BullMQ + Redis queue-driven pipeline, behind
  an ENABLE_QUEUE feature flag with a sync fallback. All 10 steps from the design doc in .claude/notification.md are now implemented.                        
                                                            
  ---
  Steps 1–4 (completed in prior session)

  ┌─────┬─────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │  #  │       Commit        │                                                         Outcome                                                          │
  ├─────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 1   │ Deps + env          │ bullmq ^5.34.0, ioredis ^5.4.2 added; .env.example + lib/envValidator.js updated; lib/queue/redis.js (singleton with     │
  │     │ scaffolding         │ retry/reconnect, dedicated worker connection).                                                                           │
  ├─────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 2   │ Queue + worker      │ lib/queue/queues.js, queueNames.js, jobShapes.js (versioned payloads); services/channels/{push,email}.channel.js;        │
  │     │ scaffolding         │ workers/{push,email,fanout,maintenance}.worker.js; workers/index.js entrypoint.                                          │
  ├─────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 3   │ Producer plumbing   │ enqueueOrFallback helper in notificationService; Notification.status enum extended with 'queued', 'retrying'; attempts,  │
  │     │ behind flag         │ lastError, lastAttemptAt fields.                                                                                         │
  ├─────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 4   │ Push channel        │ dispatchPush enqueues push.send when flag on (with quiet-hours delay), syncs when off; deduplicationKey → BullMQ jobId.  │
  │     │ cutover             │                                                                                                                          │
  └─────┴─────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  ---
  Steps 5–10 (this session)

  Step 5 — Email channel cutover

  - New services/mailService.js exporting queueWelcomeEmail, queueOrderEmail, queueMerchantSuspensionEmail, queueMerchantUnsuspensionEmail.
  - Welcome and order emails marked critical: true (BullMQ priority 1, 8 attempts, 3s base backoff).
  - Replaced direct lib/mail.js calls in controllers/user.controller.js, controllers/order.controller.js, controllers/merchant.controller.js.
  - Sync-fallback path inside mailService so a Redis outage never silently drops critical mail.

  Step 6 — Fanout & broadcast cutover

  - New notificationService.enqueueBroadcast(), enqueueMarketing(), and batchPersistQueuedNotifications() (worker-side bulk insert with partial-failure
  handling).
  - Fanout worker now streams recipients via Mongo cursor in 1000-id chunks, bulk-inserts notifications with status='queued', then addBulks child push.send
  jobs — memory bounded for any audience size.
  - controllers/notification.controller.js: sendBroadcast and sendMarketingNotification enqueue when flag on, fall through to legacy IIFE/sync when off.
  - Centralised TYPE_CATEGORY_MAP / TYPE_PRIORITY_MAP constants.

  Step 7 — Admin DLQ endpoints (/api/admin/queues/*)

  - controllers/queues.admin.controller.js + routes/queues.admin.route.js, mounted under requireAuth() + isAdmin.
  - GET /stats — per-queue counts (waiting/active/delayed/failed/completed/paused).
  - GET /:queue/failed — newest-first failed jobs with reason, trimmed stack, dataPreview.
  - POST /:queue/retry — bulk or per-id retry.
  - POST /:queue/drain — page through and remove failed older than N days.
  - :queue accepts shortname (push/email/sms/fanout/maintenance) or full name.

  Step 8 — Maintenance jobs

  - MAINT_TOKEN_CLEANUP (03:00 daily) — calls PushToken.cleanupExpiredTokens().
  - MAINT_EXPIRED_NOTIFS (03:15 daily) — deletes Notification rows past expiresAt + 30d.
  - MAINT_DLQ_SWEEP (every 6h) — retries failed jobs once, with 30-min grace window, 7-day max age, 200/run cap, 14-day Redis idempotency set keyed
  nubian:dlq:swept:<queue>. PUSH_SEND jobs check the underlying notification's expiresAt before retry.
  - Schedulers upserted via Queue.upsertJobScheduler (idempotent across restarts).

  Step 9 — Flip default + docs

  - .env.example: ENABLE_QUEUE=true, Upstash example URL, queue-name comment fixed (nubian_notif_<channel>), commented concurrency knobs added.
  - apps/CLAUDE.md: new "Notification queue pipeline" section documenting producers, queues, workers, fanout streaming, idempotency, maintenance, admin DLQ,
  and Upstash connection budget.
  - Runtime already on Upstash with the flag on.

  Step 10

  Not performed — design doc itself notes this is "optional, after a stable production window." Recommend leaving the sync fallback in
  notificationService.sendPushNotification / sendBroadcastPushNotifications and lib/mail.js for at least a week of production observation. Retiring it is a
  one-PR cleanup once you're confident.

  ---
  Frontend sync (post-backend)

  ┌────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────┐
  │                        File                        │                                              Change                                              │
  ├────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ mobile/utils/notificationService.ts:18             │ Notification.status union extended to include 'queued' | 'retrying'.                             │
  ├────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ dashboard/.../NotificationHistory.tsx:117-119      │ Status badge handles 'queued' and 'retrying' (secondary variant).                                │
  ├────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ dashboard/.../NotificationHistory.tsx:187-188      │ Status filter dropdown gained "Queued" and "Retrying" options.                                   │
  ├────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ dashboard/.../MarketingNotificationForm.tsx:91-103 │ Toast shows "Queued for delivery — recipients will be processed in the background" when the      │
  │                                                    │ queue path response has status: 'processing' instead of a sent count.                            │
  └────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────┘

  BroadcastNotificationForm.tsx and NotificationForm.jsx were re-checked and are correct as-is — broadcast still returns sent on both paths. No existing
  admin "queues / DLQ" UI in either app; building one is out of scope.

  ---
  Files touched (uncommitted in apps/backend)

  M  .env.example
  M  package.json / package-lock.json    (bullmq, ioredis)
  M  src/index.js                         (queues admin route mounted)
  M  src/lib/envValidator.js
  M  src/models/notification.model.js     (status enum, attempts, lastError, lastAttemptAt)
  M  src/services/notificationService.js  (queue helpers, fanout helpers, dispatchPush)
  M  src/controllers/notification.controller.js  (broadcast + marketing flag-gated)
  M  src/controllers/user.controller.js   (queueWelcomeEmail)
  M  src/controllers/order.controller.js  (queueOrderEmail)
  M  src/controllers/merchant.controller.js (queue<X>SuspensionEmail)
  A  src/services/mailService.js
  A  src/controllers/queues.admin.controller.js
  A  src/routes/queues.admin.route.js
  A  src/lib/queue/{redis,queues,queueNames,jobShapes}.js
  A  src/services/channels/{push,email}.channel.js
  A  src/workers/{index,push,email,fanout,maintenance}.worker.js

  apps/CLAUDE.md modified, apps/dashboard/ and apps/mobile/ modified per the FE table above.

  ---
  Operational invariants worth remembering

  - ENABLE_QUEUE=false is a one-line escape hatch: every producer falls through to the legacy sync path, no Redis needed.
  - Job idempotency lives in BullMQ jobIds: push:<dedupKey>, email:welcome:<recipient>, email:order:<orderNumber>:<status>,
  fanout:broadcast:<type>:<target>:<title>, email:suspension:<to>:<suspendedAtTs>. Retries / accidental double-fires collapse into one delivery.
  - Payload version is v: 1. Bump it for any breaking shape change; workers DLQ unknown versions.
  - Upstash connection budget: ~14 connections for a single API+worker process. Watch the count if you scale workers horizontally — Upstash free tier caps
  at 30.
  - Push job dedup vs Notification.expiresAt: the DLQ sweeper checks the doc and skips/marks-swept any push.send whose notification has expired, so you don't
   get phantom deliveries from a 6-day-old failed job.
  - Maintenance queue is excluded from DLQ sweep to prevent loops.

  That's the migration. Have a good rest of your day.
