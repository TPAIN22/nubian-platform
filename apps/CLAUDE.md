# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

`apps/` is the working directory for a three-app Nubian e-commerce platform. Each subfolder is a **separate git submodule** with its own remote, lockfile, `.env`, and `.git`:

- `apps/backend` — Express 5 REST API (`nubian-auth` repo). ESM, MongoDB/Mongoose, Clerk, ImageKit, Resend, Winston.
- `apps/dashboard` — Next.js 15 App Router dashboard (`nubian-dashboard` repo). Marketing site + admin + merchant + affiliate panels. Clerk, TanStack Query, Radix/shadcn, Tailwind v4, Zustand.
- `apps/mobile` — Expo Router React Native shopper app (`Nubian` repo). RN 0.81, NativeWind, Clerk Expo, Zustand, jest-expo.

Because these are submodules, `git status` from the parent shows submodule pointer changes, not file diffs. `cd` into the relevant submodule before committing app-level work.

## Common commands

Run all commands from inside the relevant `apps/<app>` directory.

### Backend (`apps/backend`)
- `npm run dev` — nodemon on `src/index.js`
- `npm start` — production start
- `npm run seed:currencies` — seeds the currency collection

### Dashboard (`apps/dashboard`)
- `npm run dev` — Next dev server
- `npm run build` / `npm start` — production build/serve
- `npm run lint` — Next/ESLint
- `npm run format` — Prettier on `src/**`
- `npm run seed:products` — `npx tsx src/seeds/products.seed.ts`

### Mobile (`apps/mobile`)
- `npm start` — Expo dev server
- `npm run android` / `npm run ios` / `npm run web` — platform-specific dev
- `npm test` — Jest (watch mode); `npm run test:ci` for CI; coverage threshold is 70% across branches/functions/lines/statements
- A single test: `npx jest path/to/file.test.ts` (or `-t "test name"`)
- `npm run lint` / `npm run lint:fix` — `expo lint`
- `npm run type-check` — `tsc --noEmit`
- `npm run build:android` / `build:ios` — runs cleanup + image optimization, then `eas build`
- `prebuild` runs type-check + lint and is invoked automatically before native builds

## High-level architecture

### Auth model (cross-cutting)
**Clerk is the single source of identity** across all three apps. Role and merchant approval state live in Clerk `publicMetadata`:

```
publicMetadata: {
  role: "admin" | "merchant" | "support",
  merchantStatus: "pending" | "approved" | "rejected" | "needs_revision"
}
```

- Dashboard's `src/middleware.ts` is the gatekeeper: redirects `/business/*` → `/admin/*`, gates `/admin` to `admin`/`support`, gates `/merchant/*` business tools to `merchant` + `merchantStatus === "approved"`, and falls back to fetching the user from `clerkClient` when session claims don't yet contain `publicMetadata`.
- Backend uses `clerkMiddleware()` from `@clerk/express` as **non-blocking** auth context — it just attaches auth, individual routes enforce. Mobile sends `Authorization: Bearer <token>`; the same middleware extracts both session and bearer tokens.
- Clerk webhooks (`user.created` / `updated` / `deleted`) flow into the backend's `/api/webhooks` route.

### Backend request pipeline (`apps/backend/src/index.js`)
The middleware order in `index.js` is **load-bearing** — don't reshuffle without understanding why:

1. `enforceHTTPS` (production redirect)
2. CORS with explicit allowlist from `CORS_ORIGINS` env (comma-separated)
3. Helmet with custom CSP
4. `requestLogger` and `currencyMiddleware` (global currency/country detection from `x-currency`/`x-country` headers)
5. Health routes mounted at `/`, before auth and body parsers
6. **`/api/webhooks` is mounted BEFORE `express.json()`** with `express.raw()` — Svix/Clerk signature verification needs the raw body. Adding any global JSON parser earlier will break webhooks silently.
7. Body parsers (2MB limit), then global rate limiting on `/api`
8. `clerkMiddleware()` (non-blocking)
9. Domain routes under `/api/<resource>`
10. `notFoundHandler` then `errorHandler` last

Two rate limiters: a general `limiter` (300/15min) on `/api`, and a stricter `authLimiter` (20/15min) applied only to `/api/webhooks`.

### Backend startup sequence
`(async)` IIFE at the bottom of `index.js`:
1. `connect()` to MongoDB with retries + exponential backoff (`src/lib/db.js`).
2. `initializeCronJobs()` from `services/cron.service.js` (currently controlled by `ENABLE_CRONS`; pricing + visibility-score recalculation, etc.).
3. **FX bootstrap**: if `ExchangeRate` collection is empty, immediately calls `fetchLatestRates()` so prices work on first deploy without waiting for the 4 AM cron. Logs and continues even on failure (fallback is USD).
4. `app.listen` — only after DB connect.

`uncaughtException` and `unhandledRejection` handlers are registered before any of this and exit the process — keep them that way.

### Backend domain layout (`src/`)
- `routes/*.route.js` → `controllers/*.controller.js` → `services/*.service.js` (or directly to `models/`).
- `repositories/` exists for a few aggregates (`merchant`, `dispute`, `ticket`) — most domains still call models directly.
- `lib/` holds shared infra: `db.js`, `logger.js` (Winston), `envValidator.js` (run on startup), `mail.js`, `pricing.engine.js`, `errors.js`, `response.js`.
- `middleware/validators/` holds per-domain express-validator schemas; `validation.middleware.js` is the dispatcher.
- `webhooks/` and `crons/` are kept separate from `routes/`.
- All queries go through Mongoose with validated ObjectIds / enums (see `mongodb-injection-protection.md` for the audit rationale).

### Dashboard architecture (`apps/dashboard/src/`)
- App Router with three top-level personas under `app/`:
  - `(marketing)/` — public marketing pages
  - `admin/` — admin/support tools (products, orders, merchants, marketers, currencies, fx-rates, banners, support…)
  - `merchant/` — merchant tools (apply, pending, dashboard, products, orders, coupons, analytics, settings)
  - `affiliate/` — affiliate landing/register
  - `api/` — Next route handlers that mostly proxy to the backend (`admin/*`, `merchant/*`, `products/*`, plus `upload-auth`, `send`, `user-check`, `ai`)
- `lib/axiosInstance.ts` is the **client-side** API client. It normalizes `NEXT_PUBLIC_API_URL` to always end in `/api`, sends `withCredentials`, redirects to `/sign-in` on 401, and surfaces a `formattedMessage` / `errorCode` from the backend's standardized error envelope.
- `lib/axiosServer.ts` / `serverApi.ts` / `authProxy.ts` — server-side counterparts used in route handlers and server components.
- `features/` is for feature-bundled code (currently only `products/`); `components/` holds shared UI; `components/ui/` is shadcn-generated primitives.
- State: TanStack Query for server state, Zustand for local stores (`store/productStore.js`).
- `next.config.ts` defines a strict CSP that explicitly allowlists Clerk domains, ImageKit, Render, and GA — when adding a new external origin, add it there.

### Mobile architecture (`apps/mobile/`)
- Expo Router with route groups: `(auth)`, `(onboarding)`, `(tabs)`, `(screens)`. `_layout.tsx` is the root provider stack: `ClerkProvider` → `NetworkProvider` → `LanguageProvider` → `ThemeProvider` → `KeyboardProvider` → `GestureHandlerRootView` → `BottomSheetModalProvider` → `NotificationProvider`.
- API surface lives in two places:
  - `api/*.api.ts` — typed axios calls per domain (category, checkout, explore, home, recommendations).
  - `services/` — higher-level orchestration on top of `api/` (e.g. `home.service.ts`).
- State is **Zustand-only** (no Redux). Stores in `store/` are namespaced per concern (`useCartStore`, `wishlistStore`, `useCurrencyStore`, `useExploreStore`, `useHomeStore`, `useRecommendationStore`, `useProductCacheStore`, etc.). A few legacy stores remain `.js` (`useItemStore.js`, `wishlistStore.js`); new code is TS.
- `hooks/useTokenManager.ts` is responsible for keeping the Clerk token fresh for axios; `utils/tokenManager.ts` is its lower-level pair.
- Path alias `@/*` → repo root (see `tsconfig.json`). TS is strict with `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals/Parameters`.
- Styling: NativeWind (Tailwind v3) + Gluestack UI primitives. Theme/color helpers in `theme/` and `hooks/useColors.ts`.
- i18n: `i18n-js` driven by `utils/LanguageContext.tsx` and `locales/`.
- Tests live in `__tests__/` and colocated `*.test.ts(x)`. Coverage threshold is enforced at 70%.

### Cross-app conventions
- Three-character env discipline: each app has its own `.env` and `.env.example` (only backend's example is checked in). `NEXT_PUBLIC_API_URL` (dashboard) and `EXPO_PUBLIC_*` (mobile) point at the backend's base URL.
- Image uploads go through ImageKit. The dashboard's `/api/upload-auth` route signs uploads server-side; private key must stay server-only (no `NEXT_PUBLIC_` prefix).
- Currency / FX is owned by the backend. Clients send `x-currency` / `x-country` headers; backend resolves prices via `pricing.engine.js` and the `ExchangeRate` model.
- Affiliate / referral tracking spans backend (`affiliate`, `referralTracking`, `adminCommission` routes + `affiliateFraud`, `referral`, `userIntelligence`, `riskEngine` middleware/services) and dashboard (`/affiliate/*`, `/api/affiliate/*`).
