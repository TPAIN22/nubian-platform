/**
 * PRICING ENGINE PARITY TEST
 * ===========================================================================
 * Fails the build if the dashboard's pricing engine diverges from the backend's
 * on ANY field, for ANY input in the matrix below.
 *
 *   source of truth : apps/backend/src/lib/pricing.engine.js
 *   mirror          : apps/dashboard/src/domain/pricing/pricing.engine.ts
 *
 * WHY THIS EXISTS
 * The dashboard cannot ask the backend to price a product that has not been
 * saved yet, so the product wizard re-implements the engine to preview a price.
 * Two implementations of the same money formula will drift; when they do, an
 * admin is shown one number and the shopper is charged another. This test is
 * the only thing that makes "single source of truth" enforceable rather than
 * aspirational.
 *
 * WHY IT LIVES IN THE PARENT REPO
 * `apps/backend` and `apps/dashboard` are separate git submodules with separate
 * remotes. This repository is the only place both engines are checked out at
 * once, so it is the only place they can be compared.
 *
 * HOW IT COMPARES
 * Structurally, not against a hand-written list of field names: every key of
 * both result objects is walked recursively and compared. A field ADDED to the
 * backend engine and not to the mirror therefore fails too — which is exactly
 * the drift a hardcoded field list would miss.
 *
 * DO NOT "fix" a failure by editing this file or by loosening the comparison.
 * A red build here means the two engines genuinely disagree about money. Fix
 * the mirror (or the backend, if the backend is the one that is wrong).
 */

// Loaded with DYNAMIC imports on purpose. The backend is ESM
// (`"type": "module"`), while the dashboard is a Next app whose package.json
// declares no module type — so tsx compiles its `.ts` files as CommonJS. A
// static `import { x } from "@/…"` cannot see named exports across that
// boundary and dies at instantiation with "does not provide an export named…".
// A dynamic import hands back the real namespace from both. This file is ESM,
// so top-level await is available.
const backendEngine = await import("../../apps/backend/src/lib/pricing.engine.js") as any;
const backendConfig = await import("../../apps/backend/src/lib/pricing.config.js") as any;
const dashboardEngine = await import("@/domain/pricing/pricing.engine") as any;
const dashboardConfig = await import("@/lib/pricing.config") as any;

const calculateFinalPrice = backendEngine.calculateFinalPrice;
const backendIsActive = backendEngine.isProductDiscountActive;
const backendDiscountAmount = backendEngine.computeProductDiscountAmount;

const computeEnginePricing = dashboardEngine.computeEnginePricing;
const dashboardIsActive = dashboardEngine.isProductDiscountActive;
const dashboardDiscountAmount = dashboardEngine.computeProductDiscountAmount;

const BACKEND_DEFAULT_MARKUP = backendConfig.DEFAULT_NUBIAN_MARKUP;
const DASHBOARD_DEFAULT_MARKUP = dashboardConfig.DEFAULT_NUBIAN_MARKUP;

// Fail loudly on a RENAME. Without this, dropping or renaming an export leaves
// a bare `undefined` and the run dies with an opaque "not a function".
for (const [name, fn] of Object.entries({
  "backend calculateFinalPrice": calculateFinalPrice,
  "backend isProductDiscountActive": backendIsActive,
  "backend computeProductDiscountAmount": backendDiscountAmount,
  "dashboard computeEnginePricing": computeEnginePricing,
  "dashboard isProductDiscountActive": dashboardIsActive,
  "dashboard computeProductDiscountAmount": dashboardDiscountAmount,
})) {
  if (typeof fn !== "function") {
    console.error(
      `FAIL — expected export "${name}" is missing or is not a function.\n` +
      `The pricing engines' public surface changed; update this parity test to match.`,
    );
    process.exit(1);
  }
}
for (const [name, v] of Object.entries({
  "backend DEFAULT_NUBIAN_MARKUP": BACKEND_DEFAULT_MARKUP,
  "dashboard DEFAULT_NUBIAN_MARKUP": DASHBOARD_DEFAULT_MARKUP,
})) {
  if (typeof v !== "number") {
    console.error(`FAIL — expected export "${name}" is missing or is not a number.`);
    process.exit(1);
  }
}

// ── input matrix ───────────────────────────────────────────────────────────

const DAY = 86_400_000;
const now = Date.now();
// Windows are RELATIVE to the run, so this test does not start failing on a
// calendar date. Both engines read the real clock internally (the backend's
// computeProductDiscountAmount takes no injectable `now`), so we must not pin
// an absolute date on one side only.
const PAST = new Date(now - 30 * DAY).toISOString();
const FUTURE = new Date(now + 30 * DAY).toISOString();

type DiscountBlock = Record<string, unknown> | null | undefined;

const DISCOUNTS: { label: string; value: DiscountBlock }[] = [
  { label: "none (null)", value: null },
  { label: "none (undefined)", value: undefined },
  { label: "percentage 20%", value: d({ type: "percentage", value: 20 }) },
  { label: "percentage 50% capped at 10", value: d({ type: "percentage", value: 50, maxDiscount: 10 }) },
  { label: "percentage 50% cap 0 (falsy cap ignored)", value: d({ type: "percentage", value: 50, maxDiscount: 0 }) },
  { label: "percentage 150% (over 100)", value: d({ type: "percentage", value: 150 }) },
  { label: "percentage 0% (no value)", value: d({ type: "percentage", value: 0 }) },
  { label: "fixed 25", value: d({ type: "fixed", value: 25 }) },
  { label: "fixed 100000 (exceeds price)", value: d({ type: "fixed", value: 100000 }) },
  { label: "fixed 25, cap ignored for fixed", value: d({ type: "fixed", value: 25, maxDiscount: 5 }) },
  { label: "switched off", value: d({ type: "fixed", value: 25, isActive: false }) },
  { label: "expired window", value: d({ type: "percentage", value: 20, endsAt: PAST }) },
  { label: "not started yet", value: d({ type: "percentage", value: 20, startsAt: FUTURE }) },
  { label: "open window (past → future)", value: d({ type: "percentage", value: 20, startsAt: PAST, endsAt: FUTURE }) },
  { label: "unknown type", value: d({ type: "bogus", value: 20 }) },
  { label: "null type", value: d({ type: null, value: 20 }) },
];

function d(over: Record<string, unknown>) {
  return {
    type: "percentage",
    value: 0,
    maxDiscount: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    ...over,
  };
}

const MERCHANT_PRICES = [0.5, 1, 7.5, 100, 249.99, 1000, 99999.99];
const NUBIAN_MARKUPS = [0, 15, 30, 100, 200];
const DYNAMIC_MARKUPS = [-50, -20, 0, 12.5, 40];
const MERCHANT_DISCOUNTS = [0, 0.5, 5, 500];

// ── structural comparison ──────────────────────────────────────────────────

type Divergence = { path: string; backend: unknown; dashboard: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sameScalar(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    // NaN anywhere in a price is a bug, never "equal to itself".
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return a === b; // `-0 === 0` is true, which is the behaviour we want
  }
  return a === b;
}

function diff(backend: unknown, dashboard: unknown, path = "<root>"): Divergence[] {
  const bObj = isPlainObject(backend);
  const dObj = isPlainObject(dashboard);

  if (bObj !== dObj) return [{ path, backend, dashboard }];

  if (bObj && dObj) {
    const out: Divergence[] = [];
    const keys = [...new Set([...Object.keys(backend), ...Object.keys(dashboard)])].sort();
    for (const key of keys) {
      const child = path === "<root>" ? key : `${path}.${key}`;
      const inB = Object.prototype.hasOwnProperty.call(backend, key);
      const inD = Object.prototype.hasOwnProperty.call(dashboard, key);
      // A field present on one engine only IS a divergence — that is how a
      // newly added backend field gets caught.
      if (!inD) { out.push({ path: `${child} (missing from dashboard)`, backend: backend[key], dashboard: undefined }); continue; }
      if (!inB) { out.push({ path: `${child} (missing from backend)`, backend: undefined, dashboard: dashboard[key] }); continue; }
      out.push(...diff(backend[key], dashboard[key], child));
    }
    return out;
  }

  return sameScalar(backend, dashboard) ? [] : [{ path, backend, dashboard }];
}

// ── harness ────────────────────────────────────────────────────────────────

const failures: string[] = [];
let comparisons = 0;

function fail(check: string, detail: string) {
  failures.push(`${check}\n    ${detail}`);
}

const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

// ── 1. calculateFinalPrice vs computeEnginePricing ─────────────────────────

for (const merchantPrice of MERCHANT_PRICES)
  for (const nubianMarkup of NUBIAN_MARKUPS)
    for (const dynamicMarkup of DYNAMIC_MARKUPS)
      for (const merchantDiscount of MERCHANT_DISCOUNTS)
        for (const { label, value: discount } of DISCOUNTS) {
          const backend = calculateFinalPrice({
            // `dynamicPricingEnabled: false` zeroes dynamicMarkup on the backend
            // only; the mirror has no such input and expects its caller to pass
            // 0. Held true here so the two are compared on equal terms.
            product: { discount, dynamicPricingEnabled: true },
            variant: { merchantPrice, nubianMarkup, dynamicMarkup, merchantDiscount },
          });
          // No explicit `now`: both engines read the real clock, so injecting a
          // fixed date into the mirror alone would compare them at two instants.
          const dashboard = computeEnginePricing({
            merchantPrice, nubianMarkup, dynamicMarkup, merchantDiscount,
            discount: discount as never,
          });

          comparisons++;
          const divergences = diff(backend, dashboard);
          if (divergences.length > 0) {
            const inputs = `merchantPrice=${merchantPrice} nubianMarkup=${nubianMarkup} ` +
              `dynamicMarkup=${dynamicMarkup} merchantDiscount=${merchantDiscount} discount="${label}"`;
            for (const dv of divergences) {
              fail(
                `calculateFinalPrice ≠ computeEnginePricing → ${dv.path}`,
                `${inputs}\n    backend=${fmt(dv.backend)}  dashboard=${fmt(dv.dashboard)}`,
              );
            }
          }
        }

// ── 2. isProductDiscountActive ─────────────────────────────────────────────

for (const { label, value: discount } of DISCOUNTS) {
  const backend = backendIsActive(discount);
  const dashboard = dashboardIsActive(discount as never);
  comparisons++;
  if (backend !== dashboard) {
    fail("isProductDiscountActive diverged", `discount="${label}" backend=${backend} dashboard=${dashboard}`);
  }
}

// ── 3. computeProductDiscountAmount ────────────────────────────────────────

for (const price of [0, 0.5, 1, 30, 130, 1299.99, 130000])
  for (const { label, value: discount } of DISCOUNTS) {
    const backend = backendDiscountAmount(price, discount);
    const dashboard = dashboardDiscountAmount(price, discount as never);
    comparisons++;
    if (!sameScalar(backend, dashboard)) {
      fail(
        "computeProductDiscountAmount diverged",
        `price=${price} discount="${label}" backend=${fmt(backend)} dashboard=${fmt(dashboard)}`,
      );
    }
  }

// ── 4. the ONE sanctioned divergence: merchantPrice = 0 ────────────────────
//
// Pinned rather than skipped. The backend applies its `final < 1 → 1` floor and
// returns finalPrice 1; the mirror short-circuits to zeros so an unpriced draft
// renders "—" instead of advertising a 1 SAR product. Unreachable for a saved
// product (the wizard requires merchantPrice >= 1, the backend rejects 0).
// If either side ever changes here, this check goes red on purpose.

for (const merchantDiscount of MERCHANT_DISCOUNTS) {
  const backend = calculateFinalPrice({
    product: { discount: null, dynamicPricingEnabled: true },
    variant: { merchantPrice: 0, nubianMarkup: 30, dynamicMarkup: 0, merchantDiscount },
  });
  const dashboard = computeEnginePricing({ merchantPrice: 0, nubianMarkup: 30, dynamicMarkup: 0, merchantDiscount });
  comparisons++;

  if (backend.finalPrice !== 1) {
    fail("zero-price contract changed", `expected backend finalPrice 1, got ${backend.finalPrice} (merchantDiscount=${merchantDiscount})`);
  }
  if (dashboard.finalPrice !== 0 || dashboard.originalPrice !== 0 || dashboard.hasDiscount !== false) {
    fail("zero-price contract changed", `expected dashboard zero-result, got ${JSON.stringify(dashboard)}`);
  }

  // Everything OTHER than the two known keys must still agree exactly.
  const SANCTIONED = new Set(["finalPrice", "breakdown.variantDiscount"]);
  const unexpected = diff(backend, dashboard).filter((dv) => !SANCTIONED.has(dv.path));
  for (const dv of unexpected) {
    fail(
      `new divergence at merchantPrice=0 → ${dv.path}`,
      `merchantDiscount=${merchantDiscount} backend=${fmt(dv.backend)} dashboard=${fmt(dv.dashboard)}`,
    );
  }
}

// ── 5. default markup mirrors ──────────────────────────────────────────────
//
// Each app reads its own env var by design (NUBIAN_MARKUP vs
// NEXT_PUBLIC_NUBIAN_MARKUP). Only the built-in fallbacks can be compared, so
// this runs only when neither is set — as in CI.

if (process.env.NUBIAN_MARKUP === undefined && process.env.NEXT_PUBLIC_NUBIAN_MARKUP === undefined) {
  comparisons++;
  if (BACKEND_DEFAULT_MARKUP !== DASHBOARD_DEFAULT_MARKUP) {
    fail(
      "default markup fallback diverged",
      `backend NUBIAN_MARKUP_FALLBACK=${BACKEND_DEFAULT_MARKUP} ` +
      `dashboard NUBIAN_MARKUP_FALLBACK=${DASHBOARD_DEFAULT_MARKUP} — ` +
      `see apps/backend/src/lib/pricing.config.js and apps/dashboard/src/lib/pricing.config.ts`,
    );
  }
} else {
  console.log("• default-markup check skipped (NUBIAN_MARKUP / NEXT_PUBLIC_NUBIAN_MARKUP set in this environment)");
}

// ── report ─────────────────────────────────────────────────────────────────

console.log(`\npricing engine parity: ${comparisons} comparisons`);
console.log(`  backend   apps/backend/src/lib/pricing.engine.js`);
console.log(`  dashboard apps/dashboard/src/domain/pricing/pricing.engine.ts\n`);

if (failures.length === 0) {
  console.log("PASS — the two engines agree on every field for every input.\n");
  process.exit(0);
}

const shown = failures.slice(0, 25);
console.error(`FAIL — ${failures.length} divergence(s):\n`);
for (const f of shown) console.error(`  ✗ ${f}\n`);
if (failures.length > shown.length) {
  console.error(`  … and ${failures.length - shown.length} more.\n`);
}
console.error(
  "The dashboard pricing mirror no longer matches the backend engine.\n" +
  "An admin would be shown a different price than the shopper is charged.\n" +
  "Fix apps/dashboard/src/domain/pricing/pricing.engine.ts (or the backend, if\n" +
  "the backend is the side that changed incorrectly). Do not edit this test.\n",
);
process.exit(1);
