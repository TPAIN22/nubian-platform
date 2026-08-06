# Nubian Platform — Pricing & Discount Display Audit

**Date:** 2026-08-06
**Scope:** `apps/backend`, `apps/dashboard`, `apps/mobile` (all three submodules, at their currently checked-out commits)
**Mandate:** Read-only investigation. **No code was modified.**

---

## 0. Executive summary

The pricing **engine** (`apps/backend/src/lib/pricing.engine.js`) is correct. It handles `merchantPrice`, `nubianMarkup`, `dynamicMarkup`, `variant.merchantDiscount` and `product.discount` properly and emits a complete, honest pricing block (`originalPrice`, `finalPrice`, `discountAmount`, `discountPercentage`, `hasDiscount`).

The bug is **not** in the engine. Discounts fail to display because of five independent classes of defect:

| # | Class | Effect |
|---|---|---|
| A | **No write path exists for discounts.** The dashboard has zero UI to set `product.discount` or `variant.merchantDiscount`. | For most products there *is* no discount in the data. The UI is "correct" and shows the undiscounted price. |
| B | **A second, competing pricing implementation on the backend** (`recommendations.controller.js:enrichProducts`) that mathematically **guarantees `discount = 0`**. | Every recommendation rail never shows a discount. |
| C | **Endpoints that skip enrichment entirely** (wishlist, `toggleDynamicPricing`). | Raw DB documents reach the client with no `originalPrice` / `discountPercentage` / `price` envelope. |
| D | **Frontends that compare `finalPrice` against `merchantPrice` (cost) instead of `originalPrice`.** Because `finalPrice = merchantPrice × (1 + markup)`, `finalPrice < merchantPrice` is **always false**. | Admin table, merchant table, dashboard product detail, mobile order screen: strikethrough never renders. |
| E | **Dead legacy fields (`price`, `discountPrice`) still being read**, plus a field-name collision that turns `product.price` into an object. | Merchant products table renders `0` for every price. Explore `?discount=true` filter and price sorting match nothing. |

The single most impactful finding is **A** combined with **B**: even if a merchant *could* set a discount, the home/product recommendation rails would still never show it.

---

## 1. The pricing engine — the part that works

**File:** `apps/backend/src/lib/pricing.engine.js`

```
listed   = merchantPrice × (1 + nubianMarkup/100)                                    // line 85
surged   = merchantPrice + merchantPrice×nubianMarkup/100 + merchantPrice×dynamicMarkup/100  // lines 86-90
final    = surged − variant.merchantDiscount − productDiscountApplied                // lines 93-99
original = max(listed, surged)                                                       // line 106
discountAmount = original > final ? original − final : 0                             // line 107
discountPercentage = round(discountAmount / original × 100)                          // lines 108-110
```

Key behaviours, all correct:

- `isProductDiscountActive()` (lines 32–40) gates on `isActive`, `value > 0`, valid `type`, and the `startsAt`/`endsAt` window.
- `computeProductDiscountAmount()` (lines 46–55) honours `maxDiscount` as a cap for percentage discounts and clamps to the price.
- `product.dynamicPricingEnabled === false` forces `dynamicMarkup = 0` (line 82–83).
- Cost floor (line 100) only applies when **no human-set discount exists** — a merchant *can* sell below cost deliberately.
- `calculateProductPricing()` (lines 135–156) picks the cheapest **active** variant as the representative root price.

**Every caller that routes through this engine produces correct numbers.** The problems are all in callers that *don't*, and in consumers that ignore what it produced.

---

## 2. Backend serializer — `enrichProductWithPricing`

**File:** `apps/backend/src/controllers/products.controller.js:44–152`

This is the canonical DTO mapper. Output shape (verified):

```jsonc
{
  "_id": "...", "name": "...", "variants": [ /* see below */ ],

  // root = cheapest active variant
  "merchantPrice": 100,          // = pricing.basePrice (COST, not a strikethrough price)
  "basePrice": 100,
  "listPrice": 130,
  "originalPrice": 130,          // ← the strikethrough value
  "finalPrice": 104,             // ← the price the customer pays
  "discountAmount": 26,
  "discountPercentage": 20,
  "hasDiscount": true,

  // legacy aliases
  "displayOriginalPrice": 130,
  "displayFinalPrice": 104,
  "displayDiscountPercentage": 20,

  "pricing": {
    "basePrice": 100, "listPrice": 130, "originalPrice": 130, "finalPrice": 104,
    "discountAmount": 26, "discountPercentage": 20, "hasDiscount": true,
    "breakdown": { "merchantPrice": 100, "nubianMarkup": 30, "dynamicMarkup": 0,
                   "variantDiscount": 0, "productDiscount": 26 },
    "offer": { "active": true, "type": "percentage", "value": 20,
               "maxDiscount": null, "startsAt": null, "endsAt": null },
    "source": "product"
  },

  // typed Money envelope — the canonical surface
  "price": {
    "final":    { "amount": 104, "currency": "USD", "formatted": "$104.00", "decimals": 2, "rate": 1, ... },
    "original": { "amount": 130, ... },
    "list":     { "amount": 130, ... },
    "discountAmount": { "amount": 26, ... },
    "discountPercentage": 20,
    "hasDiscount": true
  },

  "variants": [
    { "_id": "...", "sku": "...", "merchantPrice": 100, "nubianMarkup": 30,
      "dynamicMarkup": 0, "merchantDiscount": 0,
      "basePrice": 100, "listPrice": 130, "originalPrice": 130, "finalPrice": 104,
      "discountAmount": 26, "discountPercentage": 20, "hasDiscount": true,
      "pricing": { ... }, "price": { /* Money envelope */ },
      "displayFinalPrice": 104, "displayOriginalPrice": 130, "displayDiscountPercentage": 20 }
  ]
}
```

**This shape is complete and correct.** Everything a client needs to render a discount is present.

### 2.1 The `price` key collision (see Issue #6)

`products.controller.js:137` sets `price: rootPricing.basePrice` (a number), then line 139 spreads `buildBlock(...)` which contains `price: { final, original, ... }` (an object). **The spread wins.** Verified:

```
{ merchantPrice: 50, price: 50, ...buildBlock() }
→ { "merchantPrice":50, "price":{"final":{"amount":99}}, "finalPrice":99 }
```

So `product.price` is **always an object** on every enriched endpoint. Line 137 is dead code and actively misleading — several consumers read `product.price` as a number.

### 2.2 Which endpoints call it

| Endpoint | Handler | Enriched? |
|---|---|---|
| `GET /api/products` | `products.controller.js:494` | ✅ |
| `GET /api/products/:id` | `products.controller.js:587` | ✅ |
| `GET /api/products/explore` | `products.controller.js:2132` | ✅ |
| `POST /api/products` | `products.controller.js:760` | ✅ |
| `PUT /api/products/:id` | `products.controller.js:820` | ✅ |
| `GET /api/products/merchant/my-products` | `products.controller.js:957` | ✅ |
| `GET /api/products/admin/all` | `products.controller.js:1068` | ✅ |
| `GET /api/home` | `home.controller.js:39–45` | ✅ |
| `GET /api/merchants/:id/products` | `merchant.controller.js:583` | ✅ |
| `GET /api/cart` (+ mutations) | `cart.controller.js:231, 553, 674, 775, 824` | ✅ |
| **`GET /api/wishlist`** | `wishlist.controller.js:54` | ❌ **raw documents** |
| **`PATCH /api/products/:id/dynamic-pricing`** | `products.controller.js:1455` | ❌ **raw document** |
| **`GET /api/recommendations/*`** (5 endpoints) | `recommendations.controller.js:88` | ❌ **competing implementation** |

---

## 3. Findings, by question

### Q1 / Q9 — Which field is each price surface actually displaying?

#### Mobile (`apps/mobile`)

| Surface | File:line | Reads | Correct? |
|---|---|---|---|
| Product card (grid + horizontal) | `components/ProductCard.tsx:104–128` | `price.final.amount` → `finalPrice` → `productLevelPricing.finalPrice` → `simple.finalPrice` → `priceConverted` → engine; original from `price.original.amount` → `originalPrice`; badge from `discountPercentage` ?? `displayDiscountPercentage` | ✅ for enriched payloads. ❌ badge misses `item.price?.discountPercentage` (Issue #12) |
| Product details | `app/(screens)/details/[details].tsx:394–417` | variant `priceEnvelope.final/.original`, else `resolvePrice()` | ✅ price. ❌ `discountPct` (line 400–405) reads **product-root** `displayDiscountPercentage`, not the selected variant's (Issue #13) |
| Cart line | `components/checkout/CartItemCard.tsx:90–119` | envelope → `getFinalPrice`/`getOriginalPrice` | ✅ |
| Cart line (legacy) | `components/cartItem.tsx:87–100` | same | ✅ |
| Bottom sheet | `components/BottomSheet.tsx:21–23` | `priceUtils` → engine | ✅ |
| **Order detail lines** | `app/(screens)/order.tsx:874–895` | `displayFinalPrice`/`displayOriginalPrice`/`displayDiscountPercentage` — **fields order lines do not have** | ❌ **never shows a discount** (Issue #4) |
| **Wishlist grid** | `app/(tabs)/wishlist.tsx:32` → `ProductCard` | un-enriched payload | ❌ **never shows a discount** (Issue #3) |
| Home rails | `components/home/ProductSection.tsx:55` → `Card.tsx` → `ProductCard` | `/api/home` (enriched) | ✅ |
| Category listing | `app/categories/[id].tsx:73` → `ProductCard` | `/api/products` (enriched) | ✅ |
| Explore / search | `app/(tabs)/explore.tsx:340`, `app/(screens)/products/[type].tsx:213` | `/api/products/explore` (enriched) | ✅ |
| **Recommendation rails** | `components/ProductDetails/ProductRecommendations.tsx` etc. | `/api/recommendations/*` | ❌ **never shows a discount** (Issue #2) |
| Checkout totals | `utils/computePricing.ts` | backend quote subtotal + coupon | ✅ |

#### Dashboard (`apps/dashboard`)

| Surface | File:line | Reads | Correct? |
|---|---|---|---|
| **Admin products table — "السعر الأصلي"** | `src/features/products/components/ProductsTable.tsx:546–565` | `originalPrice := product.merchantPrice \|\| product.price`; `hasDiscount := finalPrice < merchantPrice` | ❌ **structurally impossible to be true** (Issue #5) |
| Admin products table — "السعر النهائي" | `ProductsTable.tsx:534–541` | `finalPrice \|\| discountPrice \|\| price` | ⚠️ works only because `finalPrice` is present |
| **Merchant products table** | `src/app/merchant/(console)/products/productsTable.tsx:74–80, 240–249, 568–572` | `sellingPrice() := discountPrice \|\| price`; `hasDiscount := sellingPrice < price` | ❌ **renders `0` for every product** (Issue #7) |
| **Admin product detail** | `src/components/products/ProductDetails.tsx:87–93, 210–223` | `originalPrice := merchantPrice`; `hasDiscount := finalPrice < merchantPrice` | ❌ **never true** (Issue #5) |
| Pricing preview (wizard) | `src/components/product/PricingPreview.tsx:28–38` | local `merchantPrice × (1 + markups)` | ❌ ignores both discount types (Issue #14) |
| `src/lib/pricing.ts` `resolvePrice` | lines 39–167 | trusts backend block | ✅ (unused by the tables above) |

---

### Q2 — What should each screen use instead?

The rule, uniformly:

| Purpose | Correct field |
|---|---|
| Price the customer pays | `product.price.final.amount` → `product.finalPrice` (variant: `variant.price.final.amount` → `variant.finalPrice`) |
| Strikethrough / "was" price | `product.price.original.amount` → `product.originalPrice` — **never `merchantPrice`** |
| Discount badge % | `product.price.discountPercentage` → `product.discountPercentage` → `displayDiscountPercentage` |
| Has-discount predicate | `product.price.hasDiscount` / `product.hasDiscount` — **never `finalPrice < merchantPrice`** |
| Cost / margin analysis (internal only) | `merchantPrice` / `pricing.breakdown` |
| Order line | `line.price`, `line.originalPrice`, `line.discountPercentage`, `line.discountAmount` |

`merchantPrice` is **cost**. `finalPrice ≥ merchantPrice` by construction (engine line 100), so any `final < merchant` comparison is dead by definition.

---

### Q3 — Is the backend returning the correct value?

**Yes on 11 of 14 product-serving endpoints** (table in §2.2). The three that are wrong:

1. **`GET /api/wishlist`** — returns raw Mongoose documents (`wishlist.controller.js:19, 54`). No `originalPrice`, no `discountPercentage`, no `hasDiscount`, no `price` envelope. When the request is USD, no conversion runs either, so the response is the bare document:
   ```jsonc
   { "_id": "...", "name": "...", "finalPrice": 104, "discount": { "type": "percentage", "value": 20, "isActive": true },
     "variants": [ { "merchantPrice": 100, "nubianMarkup": 30, "finalPrice": 104, ... } ] }
   ```
   `finalPrice` is the *stored* value — correct-ish, but with **no strikethrough data at all**.

2. **`PATCH /api/products/:id/dynamic-pricing`** — `products.controller.js:1450–1457` returns `populatedProduct` unenriched.

3. **`GET /api/recommendations/{home,product/:id,cart,user/:id}`** — see below.

---

### Q4 — Is the frontend ignoring backend data?

Yes, in four places:

- **`app/(screens)/order.tsx:874–895`** — the order line carries `originalPrice`, `discountAmount` and `discountPercentage` (see `orders.model.js:33–35`), but the component asks for `displayOriginalPrice` / `displayDiscountPercentage`, which order lines never have. Worse, the fallback at line 880 fires (both `display*` are `undefined`), constructs a synthetic product **without** `originalPrice`, and **overwrites** the correct value read on line 877. Net: `originalPrice === finalPrice`, `productHasDiscount === false`, always.

- **`ProductsTable.tsx:548`** and **`ProductDetails.tsx:88–91`** — `originalPrice` is right there in the payload; both ignore it and substitute `merchantPrice`.

- **`merchant/(console)/products/productsTable.tsx:74–80`** — ignores `finalPrice`, `originalPrice`, `discountPercentage` and the whole `price` envelope in favour of two fields that no longer exist.

- **`components/ProductCard.tsx:124–126`** — the discount badge never consults `item.price.discountPercentage` even though `home.service.ts:52` does exactly that for the same payloads.

---

### Q5 — Duplicate pricing calculations

Every place pricing is computed **outside** `lib/pricing.engine.js`:

| # | Location | What it does | Verdict |
|---|---|---|---|
| 1 | `backend/src/controllers/recommendations.controller.js:42–172` | Full re-implementation: `getVariantSellingPrice`, `getVariantOriginalPrice`, `calcDiscountPercent`, `enrichProducts` | **Critical.** Mathematically forces `discount = 0` |
| 2 | `backend/src/controllers/products.controller.js:1828–1848` | `?discount=true` filter, hand-written `$expr` on non-existent fields | **High.** Matches nothing |
| 3 | `backend/src/controllers/products.controller.js:1976–1993` | `discountBoost` in the explore ranking pipeline, on `$discountPrice`/`$price` | **Medium.** Always 0 |
| 4 | `backend/src/services/recommendation.service.js:65–78` | `getFlashDeals` filter — `variants.merchantDiscount` / `discountPrice` only | **High.** Ignores `product.discount` |
| 5 | `backend/src/services/productScoring.service.js:52–57` | `discountBoost` from `merchantDiscount / merchantPrice` only | **Medium.** Ignores `product.discount` |
| 6 | `backend/src/controllers/pricingAnalytics.controller.js:45, 104–112, 227, 240, 266–267` | `finalPrice \|\| discountPrice \|\| price` and hand-rolled markup % | **Medium.** Reads stale stored values, wrong for imported products |
| 7 | `mobile/domain/pricing/pricing.engine.ts:256–290` `localFallback` | Client-side mirror of the formula | **Acceptable** — fallback only, but it cannot know about `product.discount` (never sent to clients as a usable block) |
| 8 | `mobile/utils/productVariantHelpers.ts:67–90` `getVariantPrice` | `original := merchantPrice`, `hasDiscount := final < original` | **Low — dead code.** No call sites. Delete before someone uses it |
| 9 | `dashboard/src/lib/pricing.ts:209–241` `localFallback` | Client-side mirror | **Acceptable** — fallback only |
| 10 | `dashboard/src/components/product/PricingPreview.tsx:28–38` | `max(merchantPrice, merchantPrice + markups)` | **Medium.** Ignores `merchantDiscount` **and** `product.discount` — the admin preview shows a higher price than the shopper pays |
| 11 | `dashboard/src/features/products/components/ProductsTable.tsx:548–553` | `original := merchantPrice` | **High** |
| 12 | `dashboard/src/components/products/ProductDetails.tsx:87–93` | `original := merchantPrice` | **High** |
| 13 | `dashboard/src/app/merchant/(console)/products/productsTable.tsx:74–80` | `discountPrice \|\| price` | **Critical** for merchants |

---

### Q6 — Competing concepts

There are **six** distinct names in play. They do **not** all mean the same thing, and three of them are dead.

| Name | Where defined | Meaning | Status |
|---|---|---|---|
| `variant.merchantPrice` | `product.model.js:13` | **Cost.** What the merchant is paid | ✅ live |
| `variant.finalPrice` | `product.model.js:29` | Stored selling price for that variant | ✅ live (but see Q7 — can be stale/0) |
| `product.finalPrice` | `product.model.js:53` | min active `variant.finalPrice` | ✅ live (but see Q7) |
| `originalPrice` | engine output only | `max(listed, surged)` — the strikethrough | ✅ live, **computed, never stored** |
| `listPrice` | engine output only | `merchantPrice × (1 + nubianMarkup)` (MSRP, pre-surge) | ✅ live, computed |
| `displayFinalPrice` / `displayOriginalPrice` / `displayDiscountPercentage` | `products.controller.js:91–93` | Back-compat aliases of the above | ⚠️ live but redundant — **three names for one number** |
| `price` | `products.controller.js:96` | Money envelope **object** | ⚠️ collides with the legacy numeric `price` (§2.1) |
| `discountPrice` | **nowhere in the schema** | Legacy "sale price" | ❌ **dead** — still read in 12 places |
| `product.price` (numeric) | **nowhere in the schema** | Legacy base price | ❌ **dead** — still read in 9 places |
| `product.discount` | `product.model.js:58–69` | Object `{type,value,maxDiscount,startsAt,endsAt,isActive}` | ✅ live in the engine, **but no UI writes it** |
| `discount` (number) | `recommendations.controller.js:151` | Discount **percentage** | ❌ **conflicts** — the recommendations serializer spreads `...product` and then overwrites the `discount` **object** with a **number**, destroying the product-level discount in that payload |
| `appliedOfferId` | `product.model.js:71–75` | `ref: 'Offer'` | ❌ **`Offer` model does not exist.** Nothing reads or writes this field. A `.populate('appliedOfferId')` anywhere would throw `MissingSchemaError` |

**Conclusions:**
- The `discount` name is overloaded across an **object** (product-level discount block) and a **number** (percentage) on the same field of the same entity, on two different endpoints. This is the single worst naming conflict in the codebase.
- `merchantPrice` is repeatedly mistaken for "the original price" by frontend code. It is **cost**, and it is *always lower* than `finalPrice`.
- The "Offer" concept described in the brief is **not implemented at all**.

---

### Q7 — Is `product.finalPrice` always synchronised with variants?

**No.** Five write paths:

| Path | Recomputes? | Notes |
|---|---|---|
| `product.model.js:194–217` pre-save | ✅ | Correct. Runs the engine per variant, sets `variant.finalPrice`, `product.finalPrice = min(active)`, and syncs `stock` |
| `products.controller.js:698–770` create | ✅ | `Product.create()` → pre-save runs |
| `products.controller.js:773–830` update (admin + merchant) | ✅ | `product.set()` + `product.save()` → pre-save runs |
| `crons/dynamicPricing.cron.js:99–191` | ⚠️ **partial** | Uses `updateOne` (no pre-save) but recomputes via the engine. **Two gaps:** (a) inactive variants are skipped entirely (line 128) so their stored `finalPrice` rots; (b) the root `finalPrice` sync (lines 166–170) is **inside** the `if (!hasChanges) continue` guard at line 161 — a product whose variants are unchanged but whose root `finalPrice` is stale is **never repaired** |
| **`products.controller.js:1493–1654` bulk import** | ❌ **no** | `Product.bulkWrite` with `$set` — **pre-save never runs.** Variants are written without `finalPrice` (schema default `0`), and the root `finalPrice` is not in the `$set` at all, so on update it keeps the previous product's stale value |
| `products.controller.js:1366–1466` `toggleDynamicPricing` | ✅ | Recomputes explicitly via the engine before `updateOne` |
| **Discount updates** | ❌ **no dedicated path** | The only way to change `product.discount` is `PUT /api/products/:id`, which does save correctly. But a discount that **expires** via `endsAt` changes nothing in the DB until the hourly cron happens to notice a `finalPrice` delta |

**Consequences of the bulk-import gap (Issue #8):**
- `product.finalPrice = 0` and `variants[].finalPrice = 0` on every freshly imported product until the next cron run.
- `exploreProducts` `minPrice`/`maxPrice` filters (`products.controller.js:1713–1759`) and `price_low`/`price_high` sorts query the *stored* value → imported products are invisible or mis-ordered.
- `cartUtils.js:305` — `getProductPrice` falls back to `product.finalPrice || 0` when no variant matches → returns `0` → add-to-cart rejects with *"Product price is invalid. Please contact support."* (`cart.controller.js:433–443`).
- API **responses** are unaffected (enrichment recomputes), which is exactly why this has gone unnoticed.

**Also:** bulk import ignores `discount` and `merchantDiscount` entirely (`products.controller.js:1567–1588`), and the CSV/XLSX template has no discount column. Discounts cannot be imported.

---

### Q8 — Serializers / DTOs / mappers

| Mapper | File | Missing |
|---|---|---|
| `enrichProductWithPricing` | `backend/products.controller.js:44` | Nothing — but `price` collides (§2.1) |
| `convertProductPrices` | `backend/services/currency.service.js:288` | Converts `finalPrice`, `originalPrice`, `discountPrice`, `displayFinalPrice`, `displayOriginalPrice`, and per-variant `finalPrice/originalPrice/listPrice/discountAmount/display*`. **Does not convert root `discountAmount` or root `listPrice`** (lines 320–344) — those stay in USD while everything around them is converted. The `price` envelope built at line 379 *is* correct, so the envelope and the flat aliases disagree |
| **`enrichProducts`** | `backend/recommendations.controller.js:88` | **`originalPrice` is fabricated, `discountPercentage`/`hasDiscount`/`price` envelope/`listPrice`/`displayFinalPrice` all absent** |
| `wishlist.getWishlist` | `backend/wishlist.controller.js:54` | **No mapper at all** |
| `normalizeProduct` | `mobile/domain/product/product.normalize.ts:216` | Does **not** emit a root `finalPrice`/`merchantPrice` (stashes them under `productLevelPricing`/`simple`). Consequence: **not idempotent** — normalising an already-normalised product (which `wishlist.tsx:32` does, because `wishlistStore.js:70` stores the normalised object) drops `productLevelPricing.finalPrice` to `null` and sets `productLevelPricing.merchantPrice` to `null` (because `asNum(raw.price)` on the envelope **object** yields `NaN → null`). Only the `price` envelope survives the round trip |
| `normalizeProduct` | `dashboard/src/domain/product/product.normalize.ts` | Carries `merchantDiscount`, but no consumer uses it |
| Order line snapshot | `backend/services/order.service.js:193–212` | ✅ complete — `price`, `merchantPrice`, `originalPrice`, `discountAmount`, `discountPercentage`, markups all captured |

---

### Q10 — Every bug that produces *"the UI shows the original price instead of the discounted price"*

Ranked by how often they fire in production:

1. **No discount exists in the data** (Issue #1). The dashboard has no field for `product.discount` or `variant.merchantDiscount`. Verified: zero occurrences of `discount` in `src/app/admin/products-advanced/v2/**`, and `merchantDiscount` appears only in type declarations. Nothing shows because nothing is set.
2. **`recommendations.controller.js` forces `originalPrice = sellingPrice`** (Issue #2), so every recommendation rail renders the full price with no badge.
3. **Wishlist returns un-enriched documents** (Issue #3) — no strikethrough data reaches the card.
4. **Order screen asks for `display*` fields that order lines don't carry** (Issue #4).
5. **Dashboard compares against `merchantPrice`** (Issue #5) — `final < cost` is never true.
6. **Merchant table reads dead `price`/`discountPrice`** (Issue #7) — shows `0`.
7. **Bulk-imported products have `finalPrice = 0`** (Issue #8) until the cron runs.
8. **Independent psychological rounding of `final` and `original`** (Issue #9). `convertAndFormatPriceSync` (`currency.service.js:181–192`) applies `ENDING_9` / `NEAREST_10` / custom rounding to each amount separately. A small discount can round to the *same* converted value; `components/ui/kit/Price.tsx:49` then evaluates `hasOriginal = Boolean(original) && original !== value` on the **formatted strings** and silently drops the strikethrough. In pathological cases the rounding can even invert the pair.
9. **`toggleDynamicPricing` returns a raw document** (Issue #10) — the admin UI briefly shows unenriched values after the toggle.
10. **Explore `?discount=true` and `price_low/high` sorts operate on non-existent fields** (Issues #11a/#11b) — the "On sale" filter returns nothing, so shoppers never reach the discounted set.
11. **`getFlashDeals` ignores `product.discount`** (Issue #15) — the Flash Deals rail excludes exactly the discounts the product model was designed around.
12. **`ProductCard` badge ignores `price.discountPercentage`** (Issue #12) — on any payload where only the envelope carries the percentage, price is discounted but no badge/strikethrough renders.
13. **Details screen uses the product-root discount % for a selected variant** (Issue #13).
14. **`sanitizeDiscountInput` collapses partial updates to `null`** (Issue #16) — sending `{ discount: { isActive: false } }` to turn a sale *off* produces `null` (line 622: `if (!type || !(value > 0)) return null`), and `product.set({ discount: null })` on a nested (non-subdocument) path does not reliably clear the sub-fields. The sale can stick on.

---

## 4. Issue register (severity-ranked)

| # | Severity | Location | Root cause | Recommended fix | Risk of fix |
|---|---|---|---|---|---|
| **1** | 🔴 **Critical** | `dashboard/src/app/admin/products-advanced/v2/**` (whole wizard), `steps/Step5_Pricing.tsx`; `lib/import/*` | No UI writes `product.discount` or `variant.merchantDiscount`. The backend accepts both (`products.controller.js:745, 806`), but nothing ever sends them | Add a discount block to Step 5 (type / value / maxDiscount / window / isActive) and a per-variant `merchantDiscount` input; add columns to the import template & `lib/import/validate.ts` | Low — additive. Must reuse `sanitizeDiscountInput`'s contract and always send the **complete** object (see #16) |
| **2** | 🔴 **Critical** | `backend/src/controllers/recommendations.controller.js:42–172` | Second pricing implementation. `getVariantOriginalPrice` returns `merchantPrice` (line 69); line 125 then clamps `originalPrice = max(originalPrice, sellingPrice)`; `calcDiscountPercent` returns 0 when `s >= o` (line 77). Since `sellingPrice > merchantPrice` always, **`discount` is always 0 and `originalPrice === finalPrice`** | Delete `enrichProducts` and lines 17–79; import `enrichProductsWithPricing` from `products.controller.js`, exactly as `home.controller.js:11` already does. Keep the `hasStock` computation | Medium — response shape changes: `discount` goes from number to the schema object, and `pricingBreakdown` moves under `pricing.breakdown`. `recommendations.api.ts:53` already normalises, so mobile absorbs it; verify `ProductRecommendations.tsx` |
| **3** | 🔴 **Critical** | `backend/src/controllers/wishlist.controller.js:19–54` | `getWishlist` returns raw documents. No enrichment, and no currency conversion at all on the USD path | Wrap in `enrichProductsWithPricing(...)` then `convertProductPrices(...)` with a single `getCurrencyContext()`. Mirror `merchant.controller.js:583–600` | Low |
| **4** | 🔴 **Critical** | `mobile/app/(screens)/order.tsx:874–895` | Reads `displayFinalPrice`/`displayOriginalPrice`/`displayDiscountPercentage`; order lines carry `price`/`originalPrice`/`discountPercentage` (`orders.model.js:28–35`). The fallback at 880 then overwrites the one correct read on line 877 | Read the order-line fields directly; drop the synthetic-`normalizeProduct` fallback entirely | Low — the correct data is already on the wire |
| **5** | 🔴 **Critical** | `dashboard/src/features/products/components/ProductsTable.tsx:546–565`; `dashboard/src/components/products/ProductDetails.tsx:87–93` | `originalPrice := merchantPrice` and `hasDiscount := finalPrice < merchantPrice`. `merchantPrice` is **cost**; `finalPrice ≥ merchantPrice` by construction (`pricing.engine.js:100`) → the predicate is **never true** | Use `product.originalPrice` / `product.discountPercentage` / `product.hasDiscount`. Keep `merchantPrice` only in the internal margin breakdown | Low |
| **6** | 🟠 **High** | `backend/src/controllers/products.controller.js:137` (+ `:96`) | `price: rootPricing.basePrice` is immediately overwritten by the `...buildBlock()` spread on line 139, which sets `price` to the Money envelope. `product.price` is therefore always an object | Delete line 137 (and `:149`). Then hunt the 9 consumers that read `product.price` as a number | **High** — `product.price` is load-bearing in dashboard tables and `product.normalize.ts:247/260`. Fix consumers first, then remove |
| **7** | 🟠 **High** | `dashboard/src/app/merchant/(console)/products/productsTable.tsx:74–80, 240–249, 568–572`; type at `src/features/merchant/api.ts:129–142` | `sellingPrice()` reads `p.discountPrice ?? p.price`. `discountPrice` doesn't exist; `p.price` is the envelope object → `Number.isFinite` false → **returns `0` for every row**. `hasDiscount` likewise always false | Retype `MerchantProduct` with `finalPrice`, `originalPrice`, `discountPercentage`, `hasDiscount`, `price?: MoneyEnvelope`; rewrite `sellingPrice`/`hasDiscount` against them | Low–Medium — touches the merchant's primary screen; needs a visual pass |
| **8** | 🟠 **High** | `backend/src/controllers/products.controller.js:1590–1611` | `Product.bulkWrite` + `$set` bypasses the pre-save hook. `variants[].finalPrice` defaults to `0`; root `finalPrice` is never written | After the `bulkWrite`, refetch the affected `_id`s and `.save()` them (chunked), **or** compute `finalPrice` per variant with `calculateFinalPrice` and include it in the `$set` plus a root `finalPrice: min(active)` | Medium — a save-loop costs throughput on large imports; the in-`$set` variant is faster but re-introduces a second call site of the engine (acceptable — it *uses* the engine) |
| **9** | 🟠 **High** | `backend/src/services/currency.service.js:181–192` + `mobile/components/ui/kit/Price.tsx:49` | `applyPsychologicalPricing` runs independently on `final` and `original`. Equal rounded results ⇒ the mobile `Price` component drops the strikethrough (it compares **formatted strings**) | Convert `originalPrice` as `finalPrice + convert(discountAmount)`, or carry the server-computed `hasDiscount`/`discountPercentage` through conversion untouched and gate the strikethrough on **that**, not on string inequality | Medium — changes displayed strikethrough values in non-USD markets |
| **10** | 🟠 **High** | `backend/src/services/recommendation.service.js:65–78` | `getFlashDeals` filters on `variants.merchantDiscount > 0` or the dead `discountPrice`. **`product.discount` is not considered** | Add `{ 'discount.isActive': true, 'discount.value': { $gt: 0 } }` plus a date-window `$or` to the filter | Low |
| **11a** | 🟠 **High** | `backend/src/controllers/products.controller.js:1828–1848` | `?discount=true` compares `$finalPrice` against `$merchantPrice`/`$price` — **neither exists as a top-level field** — and `$discountPrice`/`$variants.discountPrice` are dead. Filter matches nothing | Rewrite against `variants.merchantDiscount > 0` OR an active `discount` block | Low |
| **11b** | 🟠 **High** | `backend/src/controllers/products.controller.js:2085–2091` | `price_low`/`price_high` sort on `{ price: ±1 }` — a non-existent field. Price sorting is a no-op | Sort on `finalPrice` | Low — but see #8: stored `finalPrice` must be trustworthy first |
| **12** | 🟡 **Medium** | `mobile/components/ProductCard.tsx:124–126` | Badge % reads only `discountPercentage` / `displayDiscountPercentage`, skipping `item.price?.discountPercentage`. `home.service.ts:52` already reads all three | Add `item.price?.discountPercentage` as the first candidate, matching `home.service.ts` | Very low |
| **13** | 🟡 **Medium** | `mobile/app/(screens)/details/[details].tsx:400–405` | `discountPct` reads the **product-root** percentage, so selecting a non-cheapest variant shows the cheapest variant's discount | Prefer `(matchingVariant ?? displayVariant)?.discountPercentage`, falling back to the root | Very low |
| **14** | 🟡 **Medium** | `dashboard/src/components/product/PricingPreview.tsx:28–38` | Local `merchantPrice × (1 + markups)`; ignores `merchantDiscount` and `product.discount`. Admins preview a price the shopper never sees | Accept the discount inputs and mirror the engine, or (better) render the `finalPrice` the API returns after save | Low |
| **15** | 🟡 **Medium** | `backend/src/services/productScoring.service.js:52–57`; `backend/src/controllers/products.controller.js:1976–1993` | Both `discountBoost` calculations ignore `product.discount`; the explore one reads dead `$discountPrice`/`$price` and is always `0` | Derive the boost from the engine's `discountPercentage` | Low — ranking-only |
| **16** | 🟡 **Medium** | `backend/src/controllers/products.controller.js:617–642, 806–810` | `sanitizeDiscountInput` returns `null` for any partial payload (e.g. `{ isActive: false }`). `product.set({ discount: null })` on a **nested path** (not a subdocument) does not reliably clear the sub-fields, so a sale can fail to turn off | Return an explicit cleared block `{ type: null, value: 0, isActive: false, startsAt: null, endsAt: null, maxDiscount: null }` instead of `null`, or use `$unset`. Add a regression test | Low — but **verify the current Mongoose behaviour empirically before changing**; the claim above is inferred from Mongoose nested-path semantics, not observed |
| **17** | 🟡 **Medium** | `backend/src/crons/dynamicPricing.cron.js:161–170` | Root-`finalPrice` repair sits inside the `if (!hasChanges) continue` guard, so a stale root value on an otherwise-unchanged product is never fixed. Inactive variants (line 128) are skipped, so their stored `finalPrice` rots | Move the root-sync check above the guard; treat a root drift as `hasChanges` | Low |
| **18** | 🟡 **Medium** | `backend/src/services/currency.service.js:320–344` | Root `discountAmount` and `listPrice` are not converted, while the `price` envelope built at line 379 **is**. The flat aliases and the envelope disagree in non-USD | Convert both, or drop the flat aliases | Low |
| **19** | 🟡 **Medium** | `backend/src/controllers/products.controller.js:1450–1457` | `toggleDynamicPricing` returns a raw document | Wrap in `enrichProductWithPricing` | Very low |
| **20** | 🟡 **Medium** | `mobile/domain/product/product.normalize.ts:216–291` + `mobile/store/wishlistStore.js:70` | `normalizeProduct` is **not idempotent** — it emits no root `finalPrice`/`merchantPrice`, so a second pass nulls `productLevelPricing.finalPrice`. The wishlist store persists already-normalised objects to `AsyncStorage`, and `wishlist.tsx:32` normalises them again | Either emit root `finalPrice`/`merchantPrice` in the normalised shape, or guard with an `__normalized` marker | Low — but touches a widely-used mapper; add tests |
| **21** | 🔵 **Low** | `backend/src/models/product.model.js:71–75` | `appliedOfferId` has `ref: 'Offer'`; **no `Offer` model exists**. Any `.populate('appliedOfferId')` would throw `MissingSchemaError` | Remove the field, or ship the `Offer` model. Do not leave a dangling ref | Very low — nothing reads it today |
| **22** | 🔵 **Low** | `mobile/utils/productVariantHelpers.ts:67–90` | `getVariantPrice` — dead code with the `original := merchantPrice` bug baked in. A landmine for the next developer | Delete | Very low — zero call sites (verified) |
| **23** | 🔵 **Low** | `backend/src/controllers/pricingAnalytics.controller.js:45, 104–112, 227, 240, 266–267` | Reads `finalPrice \|\| discountPrice \|\| price` from stored values; wrong for bulk-imported (`0`) products and blind to live discounts | Route through `calculateProductPricing` | Low — analytics only |
| **24** | 🔵 **Low** | `backend/src/middleware/validators/product.validator.js:120, 169` | Validates the dead `discountPrice`; does **not** validate the live `discount` block | Drop `discountPrice`, add validation for `discount` | Low |
| **25** | 🔵 **Low** | `backend/src/controllers/products.controller.js:1567–1588`; `dashboard/src/lib/import/*` | Bulk import silently drops `discount` and `merchantDiscount` | Add both to the import contract and the template | Low |

---

## 5. Recommended fix order

**Phase 1 — make discounts visible where they already exist (no schema change, low risk)**
Issues **#2, #3, #4, #5, #19**. These are pure serializer/consumer fixes; each is independently shippable and each converts a "never shows a discount" surface into a correct one.

**Phase 2 — make discounts creatable**
Issue **#1** (dashboard discount UI), then **#16** (the off-switch), **#24**, **#25**.
Without #1 the Phase-1 work is invisible in production; without #16 a sale cannot be reliably ended.

**Phase 3 — make discounts findable**
Issues **#10, #11a, #11b, #15**. Flash Deals, the "On sale" filter, and price sorting.

**Phase 4 — data integrity**
Issues **#8, #17, #7**. Stored `finalPrice` must be trustworthy before #11b (price sorting) can be relied on.

**Phase 5 — consolidation / hygiene**
Issues **#6, #9, #12, #13, #14, #18, #20, #21, #22, #23**.

---

## 6. Verification notes

- The `price` key collision (§2.1, Issue #6) was confirmed by execution, not inspection:
  `{ merchantPrice: 50, price: 50, ...buildBlock() }` → `{"merchantPrice":50,"price":{"final":{"amount":99}},"finalPrice":99}`.
- The absence of an `Offer` model was confirmed by `ls src/models/ | grep -i offer` (no results) and a full-tree grep for `Offer` (only the dangling `ref` and two unrelated `productOfferActive`/`offerSummary` locals in `products.controller.js:48–49`).
- The absence of discount UI was confirmed by `grep -rn "discount" src/app/admin/products-advanced/v2/` (zero hits) and `grep -rn "merchantDiscount" src` (four hits, all type declarations).
- `getVariantPrice` having no call sites was confirmed by a repo-wide grep across `apps/mobile` excluding `node_modules` and `coverage`.
- **Issue #16 is the one finding stated with lower confidence.** The `sanitizeDiscountInput` → `null` path is definite (`products.controller.js:622`); the resulting Mongoose nested-path behaviour is inferred and should be reproduced against a real document before the fix is designed.

---

*No files under `apps/` were modified during this audit.*
