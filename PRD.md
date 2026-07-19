# Nubian — Product Requirements Document

**Version:** 1.0
**Date:** 2026-05-25
**Owner:** Founder (Jeddah, KSA)
**Status:** Living document — updated each phase

---

## 1. Vision

**Nubian is the marketplace for Sudanese sellers and buyers — in the Gulf and back home.**

Sudanese diaspora in the Gulf spend significant disposable income on products from home (perfumes, abayas, dilka, traditional food) but buy through fragmented Instagram DMs and WhatsApp groups with no payment protection, no shipping guarantees, and no discoverability. Sellers — almost all of them women running side businesses out of their homes — have no infrastructure: no payment processor, no logistics partner, no storefront.

Nubian gives both sides a real marketplace: mada/Apple Pay/STC Pay checkout, integrated shipping, Arabic-first UX, and (Phase 2) a diaspora→Sudan corridor so Gulf-based Sudanese can send goods home.

> **Not** "Sudan e-commerce." The Gulf is the beachhead because payments, shipping, and disposable income exist there. Sudan comes later, once liquidity is real.

---

## 2. Users

### 2.1 Primary buyer — "Gulf-based Sudanese household lead"
- 25–50, mostly women, lives in Jeddah/Riyadh/Dammam/Doha/Dubai.
- Speaks Sudanese Arabic at home, reads/writes Arabic and some English.
- Already buys via Instagram DMs and WhatsApp groups; pays by bank transfer or cash on delivery.
- Pain: no buyer protection, ghosting sellers, fake products, no consolidated discovery.
- Wants: trusted sellers, recognizable Sudanese brands/products, mada/Apple Pay, fast Gulf delivery, ability to send gifts to family in Sudan.

### 2.2 Primary seller — "Sudanese diaspora micro-merchant"
- 22–45, mostly women, sells from home or small shop.
- 1–3 product categories (perfumes & bukhoor, abayas, dilka, food/spices).
- Currently sells through personal IG account; manages orders by hand in a notebook or WhatsApp.
- Pain: no payment infrastructure, no shipping integration, can't accept cards, lost orders, no growth path beyond DMs.
- Wants: a storefront she controls, automatic payments, pickup-and-ship, growth (affiliate/referrals/featured placement).

### 2.3 Secondary — Affiliate/influencer
- Sudanese micro-influencer in the Gulf (1k–50k followers): perfume reviewer, abaya stylist, food creator.
- Earns 10–20% commission via referral links tracked through the platform.

### 2.4 Secondary — Admin/support (internal)
- Founder and (later) 1–2 ops staff. Approves merchants, resolves disputes, manages FX rates, runs payouts.

---

## 3. Goals & non-goals

### 3.1 Goals (Phase 1 — first 90 days)
1. **10 active merchants in Jeddah**, each with ≥10 live products and ≥1 real order.
2. **Order success rate ≥ 95%** end-to-end (paid → fulfilled → delivered).
3. **<10 minute** merchant onboarding (catalog upload + first product live), measured on a real phone.
4. **mada + Apple Pay + STC Pay** live in checkout. Cards alone is not enough for KSA.
5. **One shipping carrier** integrated (SMSA preferred for SMB).
6. **Arabic RTL** verified end-to-end on mobile + dashboard.

### 3.2 Goals (Phase 2 — months 4–6)
1. **50 active merchants** across Jeddah, Riyadh, Dammam.
2. **500 orders/month** GMV ≥ SAR 50k.
3. **Diaspora→Sudan corridor** live: "Send to family in Sudan" checkout option, 7–14 day delivery via consolidator.
4. **Affiliate program** producing ≥20% of new buyer signups.
5. **Repeat customer rate ≥ 30%.**

### 3.3 Goals (Phase 3 — month 6+)
1. Onboard 20 merchants inside Sudan (Port Sudan first).
2. Bankak payout and SDG pricing live.
3. Expand to Wad Madani, Kassala.

### 3.4 Non-goals
- **Not** a general marketplace (no electronics, no fast fashion from Shein-style suppliers). Sudanese-specific categories only in Phase 1–2.
- **Not** building net-new platform features in Phase 1. Surface area is already over-built for current scale.
- **Not** launching inside Sudan first. War + broken banking + broken logistics = capital-inefficient.
- **Not** offering Bankak or SDG pricing in Phase 1.
- **Not** scaling with paid ads in Phase 1. Traffic to empty marketplace = burned money.

---

## 4. Strategic context

| Decision | Rationale |
|---|---|
| Gulf wedge before Sudan | Founder is in Jeddah. Payments (mada), shipping (SMSA/Aramex), and disposable income all work in KSA. Sudan has none of these working today. |
| Diaspora→Sudan as Phase 2 corridor | The diaspora *wants* to send gifts home. This is the bridge that lets Nubian eventually own Sudan-domestic when conditions allow. |
| Affiliate-led growth, not paid ads | Sudanese commerce runs on trust and word-of-mouth. Micro-influencers convert far better than Meta ads for this audience. |
| In-person merchant onboarding (Phase 1) | Sudanese sellers do not onboard themselves via a form. They join because someone they trust sat with them and uploaded their first product. |
| Arabic-first, not Arabic-also | Default language is Arabic. English is the fallback. Currency defaults to SAR. |

---

## 5. Product scope

The platform is delivered as **three apps** sharing one backend, one identity provider (Clerk), and one product/order/inventory data model.

### 5.1 Mobile app (shopper) — Expo / React Native
**Audience:** buyers.
**Purpose:** discover → add to cart → checkout → track order.

Core features:
- Home, categories, search, product detail, recommendations.
- Cart, wishlist, checkout (mada/Apple Pay/STC Pay), order tracking.
- Account, addresses, language toggle (AR/EN), currency display.
- Push notifications for order events.
- (Phase 2) "Send to family in Sudan" checkout flow.

### 5.2 Dashboard (web) — Next.js
Three personas in one app, gated by Clerk role:

**Marketing (public):**
- Landing, category pages, product pages (SEO-discoverable).
- Affiliate registration.

**Merchant panel** (`role=merchant`, `merchantStatus=approved`):
- Apply / pending / approved flow.
- Storefront setup, products, orders, coupons, analytics, settings.
- Payout setup.

**Admin/support panel** (`role=admin|support`):
- Merchant approval queue.
- Products, orders, disputes, support tickets.
- Marketers/affiliates, commission management.
- Currencies, FX rates, banners.
- Notification queue DLQ + admin tooling.

### 5.3 Backend — Express / MongoDB
**Audience:** internal — serves mobile + dashboard.
**Purpose:** single source of truth for products, orders, users, payments, FX, notifications.

Responsibilities:
- REST API under `/api/*`, Clerk auth context.
- Product/order/merchant/affiliate domain logic.
- FX engine + currency middleware (clients send `x-currency` / `x-country`).
- Notification queue (BullMQ + Redis) — push, email, SMS, fanout, maintenance workers.
- Webhooks (Clerk user lifecycle, payment processor callbacks).
- Cron jobs (pricing recalculation, visibility scores, FX refresh, DLQ sweep).

---

## 6. Functional requirements

### 6.1 Identity & roles
- Clerk is the single source of identity across all three apps.
- Role + merchant approval state stored in Clerk `publicMetadata`:
  - `role: "admin" | "merchant" | "support"` (absent = customer)
  - `merchantStatus: "pending" | "approved" | "rejected" | "needs_revision"`
- Dashboard `middleware.ts` gates `/admin` and `/merchant/*` routes accordingly.
- Backend uses non-blocking `clerkMiddleware()`; individual routes enforce.

### 6.2 Catalog
- Merchant uploads product (title AR/EN, description AR/EN, images via ImageKit, price in SAR, category, stock).
- Admin can edit/hide any product.
- Buyer-facing surfaces: home feed, category, search, recommendations.
- Visibility score (cron-recalculated) drives ordering.

### 6.3 Checkout & payments
- **Phase 1 (KSA):** mada, Apple Pay, STC Pay, Visa/Mastercard fallback.
- **Phase 2 (Gulf-wide):** add UAE (Apple Pay, cards), Qatar (cards).
- **Phase 2 (Sudan corridor):** diaspora pays in SAR at checkout; recipient gets goods in Sudan.
- **Phase 3 (Sudan-domestic):** Bankak, SDG pricing.
- Checkout must work in <60 seconds on a mid-range Android.
- Pricing engine resolves display price per `x-currency` header from backend.

### 6.4 Shipping & fulfillment
- **Phase 1:** one carrier (SMSA preferred). Label printed by merchant or pickup arranged.
- **Phase 2:** add Aramex/SPL. Add Jeddah→Port Sudan consolidator for diaspora corridor.
- Order states: `placed → paid → packed → shipped → out_for_delivery → delivered | returned`.
- Buyer + merchant get push/email/WhatsApp notifications on state change.

### 6.5 Affiliate / referral
- Affiliate registers via `/affiliate/register`, gets unique referral code.
- Tracked via `referralTracking` (already built).
- Commission rules per merchant (default 10–20%).
- `adminCommission` for platform-side spiff overrides.
- Fraud controls: `affiliateFraud`, `riskEngine`, `userIntelligence` (already in backend).
- Payout to affiliate via bank transfer (Phase 1) or Bankak (Phase 3 for Sudan-based).

### 6.6 Notifications
- Channels: push (Expo), email (Resend), SMS (later), WhatsApp Business (Phase 1 — manual support, Phase 2 — templated).
- Queue-driven (BullMQ), idempotent job IDs, DLQ with admin retry tooling.
- Templates per language (AR default, EN fallback).

### 6.7 Currency & FX
- Backend owns FX. `ExchangeRate` collection refreshed daily by cron; bootstrap on empty DB.
- Display currency resolved from `x-currency` / `x-country` headers + user preference.
- Phase 1: SAR base. Phase 2: add AED, QAR, USD. Phase 3: SDG.

### 6.8 Support
- WhatsApp Business number is the primary support channel (Sudanese culture = WhatsApp > email).
- In-app support tickets routed to admin panel for tracking.
- Disputes: backend has `dispute` repository + admin tooling.

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Mobile cold start <3s on mid-range Android; product list TTFB <500ms; checkout <60s end-to-end. |
| Availability | 99.5% uptime Phase 1; 99.9% from Phase 2. |
| Localization | Arabic-first. RTL verified on every screen. English fallback. |
| Accessibility | WCAG AA on dashboard; readable text sizes and tap targets on mobile. |
| Security | Clerk for identity; ImageKit private key server-only; CSP allowlist enforced; rate limits on `/api` (300/15min) and `/api/webhooks` (20/15min); Mongo queries go through validated ObjectIds/enums. |
| Compliance | KSA commercial registration (CR) before accepting mada at scale. PDPL-aware data handling. |
| Observability | Winston logs in backend; request logger middleware; queue stats endpoint for DLQ visibility. |
| Cost discipline | Single Render dyno + Upstash Redis acceptable in Phase 1. Each worker process budgets ~14 Redis connections. |

---

## 8. Categories (priority order, Phase 1–2)

Don't try to be a general marketplace. Pick categories where Sudanese sellers actually have an edge:

1. **Perfumes & bukhoor** — highest margin, easiest to ship, biggest demand.
2. **Abayas & thobes** — Sudanese styles unavailable in Gulf malls.
3. **Dilka, henna, traditional cosmetics** — strong word-of-mouth category.
4. **Traditional food & spices** (shelf-stable only, well-packaged).
5. **Baby & kids essentials** — recurring revenue, strong diaspora→Sudan demand.

Expand only after two of these are profitable.

---

## 9. Metrics

Tracked weekly. If a number stalls 2 weeks in a row, that's the bottleneck.

| Metric | Phase 1 target | Phase 2 target | Phase 3 target |
|---|---|---|---|
| Active merchants (≥1 sale/mo) | 10 | 50 | 150 |
| Products live | 200 | 2,000 | 6,000 |
| Orders / week | 10 | 125 | 500 |
| GMV / month (SAR) | 5,000 | 50,000 | 250,000 |
| Repeat customer rate | — | 30% | 40% |
| Merchant churn (monthly) | <20% | <10% | <8% |
| CAC (paid, when on) | — | <SAR 40 | <SAR 30 |
| Order success rate | 95% | 97% | 98% |
| Merchant onboarding time | <10 min | <7 min | <5 min |

---

## 10. Build status (what exists vs. what's needed)

### 10.1 Already built (don't rebuild)
- Three-app architecture (backend / dashboard / mobile) deployed.
- Clerk auth + role/merchantStatus gating across all three apps.
- Merchant panel: apply, pending, products, orders, coupons, analytics, settings.
- Admin panel: products, orders, merchants, marketers, currencies, FX rates, banners, support, queue DLQ tooling.
- Affiliate system: `/affiliate/*`, `referralTracking`, `adminCommission`, fraud controls.
- Notification queue: BullMQ + Redis workers, idempotent jobs, DLQ sweep, admin tooling.
- ImageKit-signed uploads.
- FX engine + currency middleware + cron-driven rate refresh.
- Mobile shopper app: home, categories, explore, cart, wishlist, checkout scaffold.

### 10.2 Required before Phase 1 launch
- [ ] **Payments live in checkout**: mada + Apple Pay + STC Pay (Moyasar/HyperPay/Tap/PayTabs — pick one).
- [ ] **Shipping carrier integration**: SMSA business account + label generation.
- [ ] **KSA CR** (commercial registration) — or partner with one — for mada at scale.
- [ ] **WhatsApp Business** number wired to support.
- [ ] **Arabic RTL pass** end-to-end (mobile + dashboard + checkout).
- [ ] **Merchant onboarding flow** measured at <10 min on a real phone, end-to-end.
- [ ] One round of dogfood: founder buys from a test merchant, full flow.

### 10.3 Phase 2 build list
- [ ] Jeddah→Port Sudan consolidator integration ("Send to family in Sudan" checkout option).
- [ ] WhatsApp templated order notifications.
- [ ] Affiliate dashboard polish (top-affiliate leaderboard, real-time earnings).
- [ ] Multi-currency display (AED, QAR, USD).
- [ ] Merchant leaderboard (public — Sudanese culture rewards visible status).
- [ ] Bankak payout for Sudan-based merchants.

### 10.4 Phase 3 build list
- [ ] SDG pricing.
- [ ] Bankak as buyer-side payment method.
- [ ] Sudan-domestic logistics partner integrations.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Empty marketplace problem (buyers churn without products; merchants churn without buyers) | Founder hand-recruits 10 merchants in person before any buyer marketing. Founder buys from each merchant himself to seed orders. |
| Merchant onboarding friction | In-person onboarding in Phase 1. <10 min target measured on real device. WhatsApp support, not email. |
| KSA payment compliance (CR required for mada) | Block Phase 1 launch on CR or CR-holding partner. No workaround. |
| Founder over-builds instead of selling | PRD non-goal #2 makes this explicit. Weekly review: ship ≤1 product improvement per week in Phase 1; rest is merchant recruitment. |
| Sudan corridor logistics unreliable | Phase 2, not Phase 1. Use established Sudanese-owned consolidators, not new partnerships. Buyer pays in SAR — risk is on Nubian, not buyer. |
| Trust failures (fake products, ghosted orders) | Manual merchant approval. Dispute system already built — staff it. Refund-first policy on first 100 orders. |
| Single-founder bandwidth | Phase 2 unlocks community manager hires in Riyadh/Dammam. Phase 3 unlocks Port Sudan hire. Don't hire before Phase 2 metrics hit. |

---

## 12. Open questions

These must be resolved before Phase 1 launch:

- [ ] KSA CR — own it, or partner with someone who has one?
- [ ] Payment processor pick: Moyasar vs. HyperPay vs. Tap vs. PayTabs?
- [ ] Shipping carrier pick: SMSA confirmed?
- [ ] WhatsApp support: founder handles it, or hire from day one?
- [ ] Monthly burn and runway — determines how patient Phase 1 can be.

---

## 13. Glossary

- **mada** — KSA national debit card network. Required for KSA e-commerce at scale.
- **STC Pay** — KSA mobile wallet (STC = Saudi Telecom).
- **Bankak** — Bank of Khartoum mobile wallet. The dominant payment rail inside Sudan.
- **Bukhoor** — incense wood chips, mainstay of Sudanese/Gulf households.
- **Dilka** — traditional Sudanese body scrub/skincare paste.
- **CR** — Commercial Registration (Saudi business license).
- **GMV** — Gross merchandise value (total order value through the platform).
- **DLQ** — Dead-letter queue (failed jobs in BullMQ).
- **FX** — Foreign exchange (currency conversion).
