# Multi-Store Refactor — Design Document

**Status:** Proposal · awaiting review
**Author:** Phase 1 fix work, May 2026
**Scope:** Allow one Clerk user to own up to 3 independent stores, each with its own profile, products, orders, payouts, analytics, and verification state.

---

## 1. Why this is a real refactor (not a settings change)

The current platform encodes "one user = one merchant" in three places that all have to move in lockstep, or the system breaks:

| Layer | Today | After |
| --- | --- | --- |
| **Identity model** | `Merchant.userId` is the unique key (Clerk `userId`) — one row per user. | `Store.ownerId` is a non-unique foreign key; a `(ownerId, slug)` compound unique replaces it. |
| **Auth gate** | Dashboard middleware checks `publicMetadata.merchantStatus === 'approved'`. There is exactly one status per user. | `publicMetadata.stores: [{ storeId, status, role }]`. Middleware checks for *any* approved store; per-route guards check the specific store the URL targets. |
| **Domain refs** | `Product.merchant: ObjectId`, `Order.merchant: ObjectId`, `Order.merchants: [ObjectId]` — these already point at `Merchant._id`, which is good. | Same shape, just renamed `Store`. The `_id` migration is a copy, not a rewrite. |
| **API surface** | `GET /api/merchants/my-status`, `GET /api/merchants/my-profile`, `PUT /api/merchants/my-profile`, etc. all assume *the* merchant. | All "my-*" routes become `/api/stores`, take `:storeId` (or accept "active" via header), and explicitly enforce ownership. |
| **Dashboard URLs** | `/merchant/dashboard`, `/merchant/products`, `/merchant/orders`, `/merchant/settings`. | `/merchant/[storeId]/dashboard` etc., with a store-switcher in the layout. Legacy `/merchant/*` redirects to the user's first store. |
| **Cap enforcement** | None. | `Store.create()` rejects when `Store.countDocuments({ ownerId, deletedAt: null }) >= 3`. |

The pivot from `Merchant` → `Store` is mostly a rename + relax of the unique index. The pain is everything that has hard-coded "one merchant per user."

## 2. Target schema

### 2.1 New `Store` model (replaces `Merchant`)

```js
// apps/backend/src/models/store.model.js
const storeSchema = new mongoose.Schema(
  {
    ownerId:    { type: String, required: true, index: true }, // Clerk userId
    slug:       { type: String, required: true, lowercase: true, trim: true },

    // ── Profile ──────────────────────────────────────────────────────
    storeName:    { type: String, required: true },
    ownerName:    { type: String, required: true },
    phone:        { type: String, required: true },
    email:        { type: String, required: true },
    merchantType: { type: String, enum: ['individual', 'business'], required: true },
    nationalId:   { type: String, required: true },
    crNumber:     { type: String },
    iban:         { type: String, required: true },
    logoUrl:      { type: String },
    banner:       { type: String },
    description:  { type: String, required: true },
    categories:   [{ type: String }],
    city:         { type: String, required: true },
    productSamples: [{ type: String }],

    // ── Status ───────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'needs_revision', 'suspended'],
      default: 'pending',
      index: true,
    },
    rejectionReason:  String,
    revisionNotes:    String,
    suspensionReason: String,
    suspendedAt:      Date,
    approvedAt:       Date,
    approvedBy:       { type: String, default: null },

    // ── Money / risk ────────────────────────────────────────────────
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    balance:       { type: Number, default: 0, min: 0 },
    frozenBalance: { type: Number, default: 0, min: 0 },
    isFlagged:     { type: Boolean, default: false },
    flaggedAt:     Date,
    flagReason:    String,

    // ── Soft-delete ─────────────────────────────────────────────────
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Unique slug per owner — slugs can collide across owners.
storeSchema.index(
  { ownerId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// Cap enforcement (defense in depth — primary check is in service layer).
storeSchema.pre('save', async function () {
  if (!this.isNew) return;
  const count = await this.constructor.countDocuments({
    ownerId: this.ownerId,
    deletedAt: null,
  });
  if (count >= 3) {
    throw Object.assign(new Error('Store limit reached (max 3 per owner)'), {
      code: 'STORE_LIMIT_REACHED',
      statusCode: 409,
    });
  }
});
```

**Why drop the global unique index on the owner ID:** that's the single change that unlocks N stores per user. Soft-delete + partial filter on `deletedAt` is what lets the same `(ownerId, slug)` be reused after a store closes without leaving permanently-poisoned indexes.

### 2.2 Domain refs — rename `merchant` → `store`

These keep their `ObjectId` shape; only the field name changes. The migration ports values 1:1 because `Store._id === old Merchant._id`.

| Model | Field today | Field after |
| --- | --- | --- |
| `Product` | `merchant: ObjectId` | `store: ObjectId` (alias kept for one release) |
| `Order` | `merchant: ObjectId`, `merchants: [ObjectId]` | `store: ObjectId`, `stores: [ObjectId]` |
| `Coupon` | `merchant?: ObjectId` | `store?: ObjectId` |
| `Payout` | `merchant: ObjectId` | `store: ObjectId` |
| `Notification` | per-merchant `userId` | add optional `storeId` for per-store routing |

Mongoose `.alias` lets us expose the old name to legacy callers for one release while internally the field is `store`. Cuts dashboard breakage during rollout.

### 2.3 Clerk metadata — break the singleton

```ts
// publicMetadata after refactor
{
  role: 'admin' | 'merchant' | 'support',  // unchanged
  stores: Array<{
    storeId: string,                        // Mongo ObjectId as string
    status: 'pending' | 'approved' | 'rejected' | 'needs_revision' | 'suspended',
    role: 'owner' | 'manager' | 'staff',    // future-proofs delegated access
  }>,
  // legacy keys (drop after migration window):
  merchantStatus?: 'approved' | 'pending' | ...,
}
```

`role: 'merchant'` becomes "this user owns ≥1 approved store." Per-route gates inside `/merchant/[storeId]/...` must additionally verify the URL `storeId` is in `publicMetadata.stores` with `status === 'approved'`.

## 3. Migration

### 3.1 Data migration script (one-shot, runnable)

`apps/backend/scripts/migrate-merchant-to-store.js`:

1. `db.merchantapplications.renameCollection('stores')` — same `_id`, so all FK refs survive.
2. `db.stores.updateMany({}, { $rename: { userId: 'ownerId' } })`.
3. `db.stores.updateMany({ deletedAt: { $exists: false } }, { $set: { deletedAt: null } })`.
4. Build `slug` for every store: `slugify(storeName) + '-' + _id.slice(-4)` (collision-safe).
5. Drop old `userId_1` unique index. Create the new partial-unique `(ownerId, slug)` index.
6. For every Product / Order / Coupon / Payout, leave `merchant` field untouched in DB but **add a duplicate `store` field** pointing at the same value (write side); reads tolerate both for one release.
7. Update Clerk for every approved merchant: copy `merchantStatus` into `stores[0]`. Idempotent — re-runnable.

The script should be idempotent: each step checks "already done?" before acting. Run with `node scripts/migrate-merchant-to-store.js --dry-run` first.

### 3.2 Backwards-compat shim (one release)

`/api/merchants/*` routes stay live but proxy to the corresponding store route, treating "the user's first store" as implicit. Once dashboards/mobile are on `/api/stores/...`, remove the alias.

## 4. Per-app task breakdown

### 4.1 Backend (`apps/backend`)

- [ ] Create `models/store.model.js` (per §2.1). Keep `models/merchant.model.js` as a thin re-export for one release.
- [ ] Add `services/store.service.js`: `createStore(ownerId, payload)`, `listOwnerStores(ownerId)`, `getStoreForOwner(ownerId, storeId)`, `updateStore`, `softDeleteStore`. **All ownership checks live here**, so controllers can't accidentally skip them.
- [ ] Add `routes/store.route.js` mirroring the existing merchant routes, but every "my-*" path now takes `:storeId` and is wrapped in a new `requireStoreOwnership(:storeId)` middleware.
- [ ] New endpoint: `GET /api/stores/mine` → list of the caller's stores with status + counts.
- [ ] New endpoint: `POST /api/stores` → create store; enforces 3-cap; returns 409 `STORE_LIMIT_REACHED` (with bilingual message) when at cap.
- [ ] Webhook `user.deleted`: extend the cascade we shipped in Phase 1 to delete *all* of the user's stores and deactivate products across all of them. (Phase 1 ships single-merchant cleanup; this is the multi-store generalization.)
- [ ] Update `controllers/product.controller.js`: every "my products" endpoint requires `?storeId=` and validates ownership before listing.
- [ ] Update `controllers/order.controller.js`: same — orders are scoped to a store, not a user.
- [ ] `middleware/merchant.middleware.js` → `middleware/store.middleware.js`. `isApprovedMerchant` becomes `requireApprovedStore({ paramName: 'storeId' })`.
- [ ] Approve/reject/suspend handlers: update Clerk `publicMetadata.stores[]` entry rather than the singleton `merchantStatus`.
- [ ] Migration script (per §3.1).
- [ ] Tests: store cap enforcement, ownership rejection (user A can't touch user B's store), `user.deleted` cascade across multiple stores, idempotent migration.

### 4.2 Dashboard (`apps/dashboard`)

- [ ] Add `app/merchant/layout.tsx` store-switcher: pulls `GET /api/stores/mine`, persists active store in a `useStoreStore` Zustand slice, renders a dropdown in the sidebar. Active store ID is exported via React context for child route handlers.
- [ ] Add `app/merchant/new/page.tsx` create-store wizard. Reuse `OnboardingWizard` components per-store; on success, push to `/merchant/[newStoreId]/pending`.
- [ ] Move every `/merchant/<thing>` route under `/merchant/[storeId]/<thing>`. Add a top-level `/merchant/page.tsx` that redirects to the user's first approved store (or `/merchant/apply` if none).
- [ ] Add a "stores" page that lists all owned stores with status badges, balance, product/order counts, and a "Create new store" CTA disabled at 3.
- [ ] Update every `proxyToAuth` API route under `app/api/merchant/*` to forward `:storeId`.
- [ ] Add bilingual `STORE_LIMIT_REACHED` error message to the apply/create-store flow.
- [ ] Drop merchant-specific persisted Zustand state on sign-out. (Currently the dashboard has only `productStore.js`; new `useStoreStore` must include a `reset()` called from a sign-out hook.)
- [ ] Middleware: replace `merchantStatus === 'approved'` with "URL `:storeId` is in `stores[]` with status `approved`." Falls back to fetching from Clerk when claims are stale (current behavior preserved).

### 4.3 Mobile (`apps/mobile`)

The mobile app today is shopper-only — no merchant management surfaces — so the only required change is to keep order-history endpoints working through the `/api/orders` shape. If/when a "merchant on mobile" feature is added, all of §4.2 applies on RN as well.

## 5. RBAC per store

Authorization is layered:

1. **Authenticated** — Clerk requireAuth (already in place).
2. **Owns the resource** — `requireStoreOwnership` in `services/store.service.js`: `Store.findOne({ _id: storeId, ownerId: clerkId, deletedAt: null })`. Reject 403 if not found.
3. **Approved** — store status must be `approved` for product/order writes (current `isApprovedMerchant` rule, scoped per store).
4. **Admin override** — admin/support roles bypass ownership checks (current behavior preserved).

The `role` field inside `publicMetadata.stores[]` is reserved for the future "manager/staff delegation" feature. For Phase 2, only `owner` is valid; treat anything else as a forbidden response.

## 6. Cascade rules (deletion / closure)

| Trigger | Effect |
| --- | --- |
| Owner deletes a store (soft) | `Store.deletedAt = now`. All products `isActive = false`. Open orders unaffected (must be settled). Releasable balance moves to payout queue. |
| Admin force-deletes a store | Same as above + audit log. |
| Clerk `user.deleted` | For each `Store` owned by the user: same as soft-delete + clear `ownerId` to `null` so the partial-unique slug index frees up. |
| Last store deleted | `publicMetadata.role` reverts from `'merchant'` to `'user'`. |

## 7. Rollout phases

This work is **after** Phase 1 (the bug fix) lands. Sequence:

| Phase | Backend | Dashboard | Reversible? |
| --- | --- | --- | --- |
| **1 (shipped)** | Cascade `user.deleted`, granular conflict codes, admin purge endpoint, idempotent re-application. | Bilingual error mapping, session refresh on 401, status-aware routing. | Yes |
| **2** | New `Store` model (collection rename), service layer, ownership middleware, migration script (dry-run + apply). Old routes still work via shim. | No changes — dashboard still hits `/api/merchants/*`. | Yes (unrun the migration) |
| **3** | Open `POST /api/stores`, `GET /api/stores/mine`, store-scoped product/order routes. | Add store switcher + create-store flow + per-store dashboards. Legacy URLs redirect. | Partially (routes need a deprecation window) |
| **4** | Drop `/api/merchants/*` shim. Drop `merchantStatus` from Clerk metadata. | Drop legacy URL handling. | No — bake time required before this phase |

Each phase is independently shippable. Ship Phase 2 + Phase 3 separately so you can monitor migration health before changing UX.

## 8. Logging / observability additions

- Every store-scoped controller logs `{ requestId, ownerId, storeId, action }`.
- New error codes: `STORE_LIMIT_REACHED`, `STORE_NOT_FOUND`, `STORE_OWNERSHIP_DENIED`, `STORE_NOT_APPROVED`. All include `details.messageAr`.
- Migration script logs counts at every step + a final reconciliation report (stores migrated, products updated, Clerk users updated, slug collisions resolved).
- Webhook handler emits structured logs per cascade target (we already do this for the Phase 1 single-merchant case — generalize the loop).

## 9. Open questions for product / ops

These need answers before Phase 2 starts:

1. **Naming.** "Merchant" and "store" are used interchangeably in the existing UI copy. Should the user-facing term be "store" / "متجر" everywhere, or keep "merchant" / "تاجر" for the account and "store" only for the storefront?
2. **Verification.** Does each new store need the full KYC packet (national ID, IBAN, CR), or do we trust verification from the user's first approved store? Today's apply form re-collects everything — that's appropriate per-store but adds friction.
3. **Payouts.** One IBAN per user (current) or one per store (the schema above)? If per-store, payout reconciliation logic changes.
4. **Cap.** Is 3 a soft cap (admin can grant more) or a hard one? The schema treats it as hard; product can override per-user via a future `storeQuotaOverride` field.

---

**This document captures the target. None of it is implemented yet.** Phase 1 fix is in place and unblocks the immediate bug. The work above is what would deliver the multi-store experience.
