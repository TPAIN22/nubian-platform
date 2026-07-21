# Nubian Mobile — UI/UX Correction Plan

> **Scope:** `apps/mobile` (Expo SDK 55 / RN 0.83 / Expo Router)
> **Source:** Full UI/UX & smoothness audit — 2026-07-19
> **Goal:** Native-smooth feel, faster time-to-first-product, consistent brand polish, working share links.
>
> Already fixed in this session (not in this plan):
> - Double-play of the launch video (`app/_layout.tsx` loading branches merged)
> - Onboarding check serialized behind font loading (now parallel)
> - Silent OAuth failure for new users (`utils/ssoFlow.ts` + 3 auth screens)

---

## How to read this plan

Each item has: **Problem → Evidence → Fix (with code) → Acceptance criteria → Effort**.

| Priority | Meaning |
|----------|---------|
| P0 | Directly felt as jank/friction by every user, every session |
| P1 | Smoothness & consistency — felt on mid/low-end devices or specific flows |
| P2 | Polish, correctness, accessibility |

Effort: **S** < 30 min · **M** ≈ half-day · **L** ≈ 1–2 days

---

# Phase 1 — Feel (quick wins, ship first)

## 1.1 Stop gating app entry on the launch video · P0 · S

**Problem:** Even after the double-play fix, `gifAnimationFinished` blocks entry until `logo.mp4` plays to the end (fallback timeout **5000 ms**). Fonts + network + onboarding checks finish in well under 1s on most devices — then the user just waits for a video. Every launch.

**Evidence:**
- `app/_layout.tsx:215` — render gate includes `!gifAnimationFinished`
- `app/GifLoadingScreen.tsx:62` — `fallbackTimeout = 5000`

**Fix:** Convert the video from a *gate* into a *minimum brand moment* with a hard cap:

```tsx
// GifLoadingScreen.tsx — cap the video wait
const VideoLoadingScreen = ({ onAnimationFinish, onMount, fallbackTimeout = 1500 }) => {
```

And in `_layout.tsx`, replace the "video must finish" condition with "minimum splash time elapsed OR video finished, whichever comes first":

```tsx
// _layout.tsx
const MIN_SPLASH_MS = 1200;
const [minSplashElapsed, setMinSplashElapsed] = useState(false);
useEffect(() => {
  const t = setTimeout(() => setMinSplashElapsed(true), MIN_SPLASH_MS);
  return () => clearTimeout(t);
}, []);

const startupDone = !isNetworkChecking && fontsLoaded && !isCheckingOnboarding;
const brandMomentDone = gifAnimationFinished || minSplashElapsed;

if (!startupDone || !brandMomentDone) {
  return <GifLoadingScreen onAnimationFinish={onGifFinish} onMount={onGifComponentMounted} />;
}
```

Optional refinement: only require `brandMomentDone` on cold start (track via a module-level flag); warm starts (backgrounded → foregrounded) skip the video entirely.

**Acceptance:** cold launch to interactive home ≤ ~1.5 s on a mid-range Android device when network is fast; video never delays entry beyond 1.5 s.

---

## 1.2 Home scroll animation → UI thread · P0 · S

**Problem:** The floating header's blur fade is driven by an `Animated.event` with `useNativeDriver: false`. Every scrolled frame crosses the JS bridge; when JS is busy (hydration, fetch parse), the header visibly lags the finger.

**Evidence:**
- `app/(tabs)/index.tsx:286` — `useNativeDriver: false`
- Same pattern: `app/(screens)/store/[id].tsx:598`

**Fix (minimal):** flip to native driver — opacity interpolation is natively drivable, and the JS `listener` (60 px threshold + scroll-depth analytics) still fires with the native driver:

```tsx
Animated.event(
  [{ nativeEvent: { contentOffset: { y: scrollY } } }],
  {
    useNativeDriver: true,   // ← was false
    listener: (e) => { /* unchanged */ },
  }
)
```

Note: the `ScrollView` must become `Animated.ScrollView` for the native event to attach. `store/[id].tsx` gets the identical change.

**Fix (better, follow-up):** migrate both screens to Reanimated `useAnimatedScrollHandler` + `useAnimatedStyle` (Reanimated 4 already installed) and drop the old Animated API here entirely.

**Acceptance:** header fade tracks scroll with zero lag while the home feed is loading; no regression in the scroll-depth analytics events.

---

## 1.3 Fix details-screen image prefetch (wrong cache) · P0 · S

**Problem:** The product details screen prefetches gallery images through **React Native's** `Image.prefetch`, but rendering uses **expo-image**, which has its own cache. The prefetch downloads bytes the UI never reads — pure waste, and the intended "instant gallery" never happens.

**Evidence:**
- `app/(screens)/details/[details].tsx:19` — `Image as RNImage` from `react-native`
- `app/(screens)/details/[details].tsx:312,321` — `RNImage.prefetch(...)`

**Fix:**

```tsx
import { Image as ExpoImage } from 'expo-image';
// ...
ExpoImage.prefetch(first);                       // instead of RNImage.prefetch
productImages.slice(...).forEach((uri) => uri && ExpoImage.prefetch(uri));
```

Remove the now-unused `Image as RNImage` import. Check `usePrefetchProduct` / `useProductCacheStore` for the same mistake and align it.

**Acceptance:** swiping the details gallery shows no network-load flash for prefetched images (verify with airplane mode after first view, or expo-image's cache inspector in dev).

---

## 1.4 Default currency from device locale — kill the mandatory modal · P0 · M

**Problem:** First-run funnel is 4 gates deep: launch video → onboarding → auth choice → **mandatory** currency modal. For the Gulf-launch wedge, every gate costs installs. Currency is almost always inferable.

**Evidence:**
- `app/_layout.tsx:274` — `<CurrencySelector mandatory />`
- `expo-localization` is already a dependency; backend already consumes `x-currency` / `x-country` headers

**Fix:**
1. On first run, derive default currency from `Localization.getLocales()[0].regionCode` (SA→SAR, AE→AED, KW→KWD, QA→QAR, BH→BHD, OM→OMR, EG→EGP, SD→SDG, fallback USD) and write it into `useCurrencyStore` immediately.
2. Change `CurrencySelector` from a blocking modal to a **dismissible confirmation chip/toast** on the home screen: "Prices in SAR — Change". Tapping opens the existing selector as a normal (non-mandatory) sheet.
3. Keep the mandatory modal ONLY for the case where region mapping fails **and** no stored currency exists.

**Acceptance:** a fresh install in Saudi Arabia sees SAR prices with zero extra taps; currency remains changeable from profile; the currency-change refresh listener in `_layout.tsx` continues to work (it already handles null → value hydration).

---

## 1.5 Remove dead dependency `react-native-toast-message` · P2 · S

**Problem:** Installed but never imported (grep confirms zero usages — the app uses `sonner-native`). Costs bundle size and native build time.

**Evidence:** `package.json:102`; `Grep "from 'react-native-toast-message'"` → no files.

**Fix:** `npm uninstall react-native-toast-message` inside `apps/mobile`. Also remove the stale `react-native-swiper` entry from `expo.doctor.reactNativeDirectoryCheck.exclude` (`package.json:30`) — the package is no longer a dependency.

**Acceptance:** clean `npx expo-doctor`, build passes, no import errors.

---

## 1.6 Fix broken share deep links (scheme mismatch) · P2 · S

**Problem:** Generated share links use scheme `nubian://` but the app registers `sdnubian` — every shared link silently fails to open the app.

**Evidence:**
- `utils/deepLinks.ts:441` — `const baseUrl = 'nubian://';` (with a literal "Replace with your actual deep link scheme" comment)
- `app.json:7` — `"scheme": "sdnubian"`

**Fix (immediate):**

```ts
const baseUrl = 'sdnubian://';
```

**Fix (right, follow-up):** switch share links to HTTPS universal/app links on `nubian-sd.com` (e.g. `https://nubian-sd.com/p/<id>`), add the domain to `android.intentFilters` with `autoVerify` + host a `/.well-known/assetlinks.json`, and an `apple-app-site-association` for iOS. Links then work for people **without** the app installed (they land on the web/dashboard product page) — critical for the referral/affiliate growth loop.

**Acceptance:** sharing a product and tapping the link on a device with the app installed opens the product details screen.

---

# Phase 2 — Scrolling & rendering

## 2.1 Virtualize the home screen · P0 · M

**Problem:** Home is one `ScrollView` mounting *everything* at once: banner carousel + category bubbles + 5 `ProductSection`s + `StoreHighlights` — ~25+ image cards render before first paint. Inflates time-to-interactive and memory; no vertical virtualization.

**Evidence:** `app/(tabs)/index.tsx:354-437`.

**Fix:** convert the page body to a `FlatList` where each item is a section (sections are already memoized components — mechanical refactor):

```tsx
type HomeSection =
  | { key: 'banner' } | { key: 'categories' } | { key: 'forYou' }
  | { key: 'trending' } | { key: 'storeHighlights' } | { key: 'flashDeals' }
  | { key: 'newArrivals' } | { key: 'brands' };

<Animated.FlatList
  data={sections}
  renderItem={renderSection}          // switch on item.key
  keyExtractor={(s) => s.key}
  onScroll={handleScroll}             // 1.2's native-driver handler
  windowSize={5}
  initialNumToRender={3}              // banner + categories + first product row
  removeClippedSubviews
  refreshControl={...}
  contentContainerStyle={{ paddingBottom: insets.bottom + 88 }}
/>
```

Keep the horizontal `FlatList`s inside sections as-is (nested horizontal-in-vertical is the supported pattern).

**Acceptance:** on first home render, only above-the-fold sections mount (verify with a render counter in dev); scroll performance unchanged or better; pull-to-refresh, empty state, and header fade all still work.

---

## 2.2 Adopt FlashList for the explore grid (then category/products screens) · P1 · M

**Problem:** The image-heavy 2-column infinite grid in Explore is a plain `FlatList`. Fast flings produce blank cells; per-item mount cost is high. `getItemLayout` tuning is present but can't match cell recycling.

**Evidence:** `app/(tabs)/explore.tsx:406-449`; also `app/(screens)/[id].tsx:355` (category grid), `app/(screens)/products/[type].tsx`.

**Fix:**
1. `npm i @shopify/flash-list` (in `apps/mobile`).
2. Explore first (biggest list):

```tsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={displayProducts}
  renderItem={renderItem}
  keyExtractor={keyExtractor}
  numColumns={2}
  // v2 (RN 0.83/new-arch) auto-sizes; card heights are uniform — ideal case
  onEndReached={handleLoadMore}
  onEndReachedThreshold={0.4}
  refreshControl={...}
  ListEmptyComponent={ListEmptyComponent}
  ListFooterComponent={...}
  contentContainerStyle={{ paddingTop: HEADER_HEIGHT + 12, paddingBottom: insets.bottom + 100 }}
/>
```

3. Note: `columnWrapperStyle` doesn't exist in FlashList — move the row gap into per-item padding.
4. Repeat for the category screen and `products/[type]` once explore proves out. The scroll-linked header animation on the category screen keeps working via `Animated.createAnimatedComponent(FlashList)` or Reanimated's scroll handler.

**Acceptance:** no blank cells on fast fling on a mid-range Android device; memory footprint of explore drops (dev-menu perf monitor); infinite scroll + refresh unbroken.

---

## 2.3 Serve sized banner/card images from ImageKit · P1 · M

**Problem:** Banners render at `screenWidth × 1.1×screenWidth` (near-fullscreen). If URLs are original uploads, that's multi-MB downloads + expensive decodes, re-triggered as autoplay cycles slides. Product card images likewise render at ~half screen width but may download originals.

**Evidence:** `components/home/BannerCarousel.tsx:16,38-43`; `components/ProductCard.tsx:209-216`.

**Fix:** central URL-transform helper (ImageKit is already the image CDN):

```ts
// utils/imageCdn.ts
export function ikResize(url: string | null, width: number): string | null {
  if (!url || !url.includes('ik.imagekit.io')) return url;
  const w = Math.min(Math.ceil(width * (PixelRatio.get() > 2 ? 2 : PixelRatio.get())), 1600);
  return `${url}${url.includes('?') ? '&' : '?'}tr=w-${w},q-75,f-auto`;
}
```

Apply at the three image hot spots: banner slides (`ikResize(item.image, screenWidth)`), product cards (`ikResize(displayImage, cardWidth)`), category bubbles (`ikResize(item.image, 76)`). Keep full resolution only in the details zoom modal.

**Acceptance:** network inspector shows banner downloads under ~300 KB each; no visible quality loss at device scale.

---

## 2.4 Pause banner autoplay off-screen + dots off React state · P2 · S

**Problem:** (a) The carousel autoplays every 3.5 s even when the Home tab is blurred (`freezeOnBlur` mitigates but doesn't cover modal overlays / app background). (b) `onProgressChange → setActiveIndex` re-renders the component tree on every slide tick.

**Evidence:** `components/home/BannerCarousel.tsx:20-25,84-87`.

**Fix:**

```tsx
import { useIsFocused } from '@react-navigation/native';
const isFocused = useIsFocused();
<Carousel autoPlay={banners.length > 1 && isFocused} ... />
```

For the dots, throttle state updates to actual index changes (cheap fix — early-return when `safeIndex === activeIndex` is already implicit in `setState` but the handler still runs per frame; move the computation behind `Math.round` change detection), or drive dot styles from a Reanimated shared value written in `onProgressChange`.

**Acceptance:** no carousel timers firing while another tab is active (JS profiler); dot updates cause no parent re-render.

---

# Phase 3 — Typography, components, consistency

## 3.1 Load real Cairo weights; stop synthesizing bold · P1 · M

**Problem:** Only `Cairo-Regular` and `Cairo-Bold` are loaded, but styles across the app use `fontWeight: "500" | "600" | "700"`. On Android, custom fonts don't synthesize intermediate weights — text silently falls back to faux-bold or the system font. This is why typography looks subtly inconsistent, especially Arabic.

**Evidence:** `hooks/useFonts.ts:7-10`; `fontWeight: "600"` et al. throughout (e.g. `ProductCard.tsx:290-293`, `(tabs)/_layout.tsx:466`).

**Fix:**
1. Add `Cairo-Medium.ttf`, `Cairo-SemiBold.ttf` to `assets/fonts/Cairo/` and register them in `useFonts.ts`.
2. Teach the themed `Text` (`components/ui/text`) to map `fontWeight` → `fontFamily`:

```tsx
const CAIRO_BY_WEIGHT: Record<string, string> = {
  '400': 'Cairo-Regular', '500': 'Cairo-Medium',
  '600': 'Cairo-SemiBold', '700': 'Cairo-Bold', bold: 'Cairo-Bold',
};
```

3. Prefer the `expo-font` **config plugin** (fonts embedded at build time, zero load delay) over runtime `useFonts` — this also removes the font gate from the startup path entirely (`app.json` plugins already include `expo-font`; add the `fonts` array to its config).

**Acceptance:** side-by-side screenshot of home before/after shows uniform Cairo rendering at all weights on Android; `fontsLoaded` gate becomes a no-op (fonts are embedded).

---

## 3.2 One `Text` component everywhere · P1 · M

**Problem:** Some screens import `Text` from `react-native` directly, bypassing the themed Cairo `Text` — Arabic on those screens renders in the system font.

**Evidence:** `app/(screens)/[id].tsx:16` (category screen), `app/(tabs)/_layout.tsx:10` (tab bar labels/badges).

**Fix:**
1. Replace `react-native` Text imports with `@/components/ui/text` in the offending files.
2. Enforce with ESLint so it stays fixed:

```js
// eslint.config.js
'no-restricted-imports': ['error', {
  paths: [{
    name: 'react-native',
    importNames: ['Text'],
    message: 'Use Text from @/components/ui/text (Cairo + theme aware).',
  }],
}],
```

(Allow an inline disable in `components/ui/text` itself.)

**Acceptance:** `npm run lint` fails on raw `Text` imports; category screen + tab bar render Cairo.

---

## 3.3 Modernize the tab bar animations · P1 · M

**Problem:** Tab bar uses three legacy `Animated.Value`s per item plus a global `LayoutAnimation` per tab switch. On the new architecture (default in SDK 55), `LayoutAnimation` is deprecated/glitchy, and old-API springs contend with the JS thread exactly when the incoming tab renders.

**Evidence:** `app/(tabs)/_layout.tsx:137-173` (per-item Animated), `:265-270` (LayoutAnimation).

**Fix:** rewrite `TabItem` with Reanimated:

```tsx
const scale = useSharedValue(1);
const focusProgress = useDerivedValue(() =>
  withSpring(focused ? 1 : 0, { damping: 15, stiffness: 220 }));
const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scale: scale.value * (1 + 0.05 * focusProgress.value) }],
  opacity: 0.55 + 0.45 * focusProgress.value,
}));
```

Replace the flex-based width change (`LayoutAnimation` + `flex: focused ? 2.2 : 1`) with an animated width/flex driven by `withTiming` on a shared value, or use Reanimated's `LinearTransition` layout animation on the slots.

**Acceptance:** tab switches animate at 60 fps with JS thread deliberately busied (dev: `while` loop for 200 ms on press); no `LayoutAnimation` warnings on new arch.

---

## 3.4 Themed confirmation sheet instead of `Alert.alert` · P1 · M

**Problem:** Destructive confirmations and error surfaces use native OS alerts — visually off-brand and jarring next to the sonner toasts and bottom sheets used elsewhere. Native alerts also ignore the app's RTL/i18n styling.

**Evidence:** `app/(tabs)/cart.tsx:136-165` (remove item), `app/(auth)/signin.tsx` (multiple), `signup.tsx`, `welcome.tsx`.

**Fix:**
1. Build `components/ui/ConfirmSheet.tsx` on `@gorhom/bottom-sheet` (already installed): title, message, destructive + cancel actions, theme-aware, Cairo type.
2. Sweep `Alert.alert` call sites: confirmations → `ConfirmSheet`; pure error/info messages → `toast.error/success` (sonner already in place).
3. Cart specifically: consider swipe-to-delete (`ReanimatedSwipeable` from RNGH, already installed) with an **undo toast** — removes the confirmation step entirely, which is the fastest UX of all.

**Acceptance:** zero `Alert.alert` calls outside genuinely-native contexts (permissions); cart item removal takes ≤ 2 gestures.

---

## 3.5 Migrate `TouchableOpacity` → `Pressable` (incremental) · P2 · M

**Problem:** 214 usages across 26 files. `Pressable` is the modern API (better ripple on Android, hover/focus states, cheaper). Not urgent, but do it opportunistically.

**Evidence:** grep count; heaviest files: `explore.tsx` (35), `products/[type].tsx` (25), `signin/signup` (13 each), `cartItem.tsx` (11).

**Fix:** codemod pattern per file as each is touched for other reasons — `activeOpacity={0.7}` becomes a `style` function:

```tsx
<Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]} ...>
```

Add the same `no-restricted-imports` treatment once the count reaches zero.

**Acceptance:** downward trend; no new `TouchableOpacity` in PRs (lint rule as the finish line).

---

# Phase 4 — Accessibility, RTL, details

## 4.1 Accessibility pass on interactive elements · P2 · L

**Problem:** ~89 a11y props in the whole app, concentrated in checkout. Product cards, wishlist toggles, banner slides, header icons, carousel are invisible or meaningless to TalkBack/VoiceOver. For an e-commerce app this blocks real customers.

**Evidence:** grep — `(tabs)/_layout.tsx` has proper roles/labels (good template); `ProductCard.tsx` has none; images use generic `alt="product image"`.

**Fix (by surface, in order):**
1. **ProductCard**: `accessibilityRole="button"`, `accessibilityLabel={`${item.name}, ${renderFinal()}${productHasDiscount ? `, ${discountPercentage}% off` : ''}`}` on the main pressable; wishlist button: label + `accessibilityState={{ selected: inWishlist }}`.
2. **Home header icons** (`index.tsx:82-117`): labels for search/wishlist/cart (+ cart count).
3. **Banner slides**: label from `item.title`; mark pagination dots `accessibilityElementsHidden`.
4. **Details screen**: gallery images labeled with index/total; attribute selectors as `radiogroup`/`radio` semantics.
5. **Quantity steppers, coupon field, checkout footer** — already partially covered; complete the set.

**Acceptance:** TalkBack walkthrough of browse → product → add to cart → checkout completes with every stop announced meaningfully.

---

## 4.2 Centralize RTL handling · P2 · M

**Problem:** RTL is ad-hoc: scattered `I18nManager.isRTL` checks, manual `textAlign`, manual `row-reverse`. Some components handle it (`BannerCarousel` pagination, signin inputs), most don't — Arabic users get a mix of mirrored and unmirrored layouts.

**Evidence:** `BannerCarousel.tsx:93`, `signin.tsx:234`, root `_layout.tsx:293` (`direction` on a wrapper View), plus many unhandled rows.

**Fix:**
1. Prefer **logical style properties** (RN supports them): `marginStart/End`, `paddingStart/End`, `start/end` instead of left/right — these auto-flip with RTL. Sweep styles that use `left/right/marginLeft/marginRight` for directional intent (badges, back buttons, chevrons).
2. One `useRTL()` hook exporting `{ isRTL, chevron: isRTL ? 'chevron-back' : 'chevron-forward', writingDirection }` — kill scattered `I18nManager` imports.
3. Chevrons/arrow icons ("see all", back buttons) must flip: `app/(screens)/[id].tsx:269` hardcodes `arrow-back`; `ProductSection.tsx:90` hardcodes `chevron-forward`.
4. Verify tab order, carousel snap direction, and swipe gestures in an Arabic build (RTL forced) on both platforms.

**Acceptance:** screenshot diff of every main screen in Arabic shows fully mirrored directional UI; no raw `I18nManager` usage outside the hook.

---

## 4.3 Legibility & touch-target minimums · P2 · S

**Problem / Evidence / Fix in one table:**

| Element | Current | Target | File |
|---|---|---|---|
| Cart badge text | 8 pt | 10 pt (badge 18 px) | `(tabs)/index.tsx:481` |
| Product name | 12 pt | 13–14 pt (Arabic needs x-height) | `ProductCard.tsx:290` |
| Category bubble label | 10 pt | 11 pt | `(tabs)/index.tsx:511` |
| Banner title | 16 pt | 18–20 pt (it's the hero) | `BannerCarousel.tsx:142` |
| Home header icons | ~32 px hit area | ≥ 44 px (bump `hitSlop` to 16 or padding to 10) | `(tabs)/index.tsx:469` |
| Wishlist button on card | 36 px | 44 px via `hitSlop={4}` | `ProductCard.tsx:286` |
| "See all" row | small text+chevron | `hitSlop={8}` | `ProductSection.tsx:88` |

**Acceptance:** no interactive element under 44×44 effective; no text under 10 pt.

---

## 4.4 Category screen data & skeleton polish · P2 · S

**Problem:** Category header shows fallback text while its data fetches per-mount; errors go to `console.error`; no header skeleton. Product taps here also flow through the legacy `Card` wrapper + bottom-sheet props that `ProductCard` ignores.

**Evidence:** `app/(screens)/[id].tsx:116-153`, `:200-209`.

**Fix:**
1. Seed `categoryData` synchronously from `useCategoryStore` (same pattern ProductCard uses for product cache seeding); fetch only on miss.
2. Moti skeleton block for the header while `categoryData === null`.
3. Drop the dead `handleSheetChanges`/`handlePresentModalPress` props and the unused `BottomSheetModal` if nothing presents it (verify first).

**Acceptance:** navigating from a category bubble shows name/image instantly (data came from the store); no console errors on flaky network.

---

## 4.5 Production app identifiers · P2 · decision needed

**Problem:** `bundleIdentifier` / `package` are `dev.expo.nubian` — placeholder-style IDs in production config.

**Evidence:** `app.json:11,32`.

**Action:** if the app is **already live** on the stores under these IDs — do nothing (Android package is immutable post-publish). If **not yet shipped**, change to `com.nubian.app` (or similar) before first release, matching iOS + Android, and update Clerk/Google OAuth redirect config + `google-services.json` accordingly. **This is a decision item, not a code task — confirm store status first.**

---

# Execution order & tracking

| # | Item | Priority | Effort | Depends on | Status |
|---|------|----------|--------|-----------|--------|
| 1.1 | Launch video no longer gates entry | P0 | S | — | ✅ done |
| 1.2 | Home scroll → native driver | P0 | S | — | ✅ done |
| 1.3 | expo-image prefetch fix | P0 | S | — | ✅ done |
| 1.4 | Locale-default currency | P0 | M | — | ✅ done |
| 1.5 | Remove dead toast dep | P2 | S | — | ✅ done |
| 1.6 | Deep-link scheme fix | P2 | S | — | ✅ done |
| 2.1 | Virtualize home | P0 | M | 1.2 | ✅ done |
| 2.2 | FlashList explore → category | P1 | M | — | ✅ done (explore + category + products all on FlashList) |
| 2.3 | ImageKit sized renditions | P1 | M | — | ✅ done |
| 2.4 | Carousel autoplay/dots | P2 | S | — | ✅ done |
| 3.1 | Cairo weights + config plugin | P1 | M | — | ⛔ needs Cairo-Medium/SemiBold .ttf assets |
| 3.2 | Single Text component + lint | P1 | M | 3.1 | ✅ done (import-swap complete + ESLint guard active; weight-map awaits 3.1 fonts) |
| 3.3 | Reanimated tab bar | P1 | M | — | ✅ done |
| 3.4 | ConfirmSheet, kill Alert.alert | P1 | M | — | ✅ done (0 Alert.alert app-wide) |
| 3.5 | Pressable migration | P2 | M | rolling | 🔶 substantial (main screens done; ~30 TouchableOpacity remain in 14 files; no enforcement rule yet) |
| 4.1 | Accessibility pass | P2 | L | — | ✅ done across main surfaces (cards, headers, selectors, steppers, gallery, auth, checkout) |
| 4.2 | RTL centralization | P2 | M | — | ✅ done (useRTL hook + direction-aware icons + logical props on main screens) |
| 4.3 | Legibility & touch targets | P2 | S | — | ✅ done |
| 4.4 | Category screen polish | P2 | S | — | ✅ done |
| 4.5 | App identifiers | P2 | — | store status | ⛔ needs your decision |

**Verification gates for every phase:**
- `npm run type-check` and `npm run lint` clean (both run in `prebuild`)
- `npm run test:ci` — coverage threshold 70% must hold
- Manual smoke on a mid-range Android device: launch → home scroll → explore fling → product open → add to cart → cart edit — all at 60 fps with the perf monitor overlay on
- Arabic (RTL) build check for any phase touching layout

**Measurement (before starting Phase 1, capture baselines):**
- Cold-launch to interactive-home time (adb `am start -W` + first-frame log, 5-run median)
- Home scroll JS/UI FPS via dev perf monitor while feed loads
- Explore fling blank-cell occurrence (screen recording)
- APK/IPA size before vs after 1.5

---

*Generated from the 2026-07-19 audit session. Items already fixed that session (startup double-play, onboarding parallelization, silent SSO failure) are excluded.*
