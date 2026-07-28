# FreeCharge frontend testing suite

Automated frontend tests for the FreeCharge web app (`www.freecharge.in`) and the
FreeCharge Pay Bills Android app, in one repository, sharing test data and one
safety model.

| Layer | Stack | Specs |
|---|---|---|
| Web | Playwright + TypeScript | smoke, functional, accessibility, visual, responsive, performance, SEO |
| Android | Appium (UiAutomator2) + WebdriverIO + Mocha | smoke, functional, accessibility, navigation, rotation, connectivity |

479 web tests across 4 device projects, plus the Android suite. Both halves drive
the same product surface — mobile recharge, DTH, electricity, broadband, credit
card and the rest of the bill-payment catalogue — so a behaviour can be asserted
on both platforms from one definition in `shared/data/`.

---

## Read this first

**Two things about this suite are unusual, and both are deliberate.**

### 1. The selectors are unverified hypotheses until you run the audit

This suite was written without network access to `www.freecharge.in` and without
a device or APK to inspect. Every selector was therefore authored from the
product's known surface — the categories it sells, the labels those flows
conventionally use — rather than from a live DOM or view hierarchy.

To make that safe rather than fragile, **no element is declared as a single
selector**. Each one is an ordered chain of candidates (test id → ARIA role →
label → text → CSS), and a resolver picks the first that actually attaches. The
chains are designed to survive markup churn, but they still need one verification
pass against a real build:

```bash
npm run verify:selectors:web       # audits every web chain against the live site
npm run verify:selectors:android   # audits every Android chain against a device
```

Each prints, per element, which candidates matched and how many nodes each hit,
and writes a report to `artifacts/`. Fix anything reported `MISS` by editing one
file — `web/support/elements.ts` or `android/support/elements.ts`. No spec file
changes. **Budget an hour for this before the first real run.**

### 2. The suite will not spend money

FreeCharge is a payments product. An automated suite pointed at it can place real
orders, and the failure mode is silent — the test passes and someone's balance is
gone. Two independent guards prevent that:

- **Web** (`shared/safety.ts`): a request interceptor aborts anything matching a
  payment-gateway host or an order/payment endpoint. Specs assert they *did not*
  trigger one via the `assertNoUnsafeRequests` fixture.
- **Android** (`android/support/guard.ts`): `safeTap` refuses to press any control
  whose label commits money ("Pay Now", "Confirm Payment", "Verify UPI PIN"), and
  screen objects tap only through it.

Both are active whenever `TEST_ENV=prod-readonly`, which is the default. The
deepest any spec goes is the payment-method screen. Setting `TEST_ENV=staging`
lifts the guards — only do that against a non-production host with sandbox
credentials.

---

## Quick start

```bash
npm ci
npx playwright install --with-deps chromium
cp .env.example .env

npm run verify:selectors:web    # check the chains match the live site
npm run test:web:smoke          # ~7 fast tests: is the site up and usable?
npm run test:web                # the full web suite
npm run report:web              # open the HTML report
```

Android needs a device or emulator on `adb devices`, plus the app installed (or
an APK to install):

```bash
export ANDROID_APP_PATH=/path/to/freecharge.apk   # or leave unset to use the installed build
npm run verify:selectors:android
npm run test:android:smoke
```

---

## Layout

```
shared/                     Cross-platform: env config, safety rules, OTP strategy, test data
  env.ts                    All configuration, read once from .env
  safety.ts                 What counts as a transactional request (both platforms)
  otp.ts                    The three legitimate ways to automate an OTP login
  data/catalog.ts           Bill categories, operators, circles — drives both suites
  data/inputs.ts            Validation vectors: mobile numbers, amounts, hostile strings

web/
  support/elements.ts       THE selector map. Every web selector lives here.
  support/locators.ts       Candidate resolver
  support/fixtures.ts       Network guard, console/error collection, page objects
  support/a11y.ts           axe integration, tab order, focus visibility
  support/perf.ts           Web vitals via PerformanceObserver, budgets, throttling
  pages/                    Page objects
  tests/                    Specs, one directory per tag

android/
  support/elements.ts       THE selector map. Every Android selector lives here.
  support/selectors.ts      Candidate → UiSelector/xpath translation
  support/resolver.ts       Candidate resolver
  support/guard.ts          Payment guard
  support/device.ts         Rotation, backgrounding, connectivity, hierarchy dumps
  support/assert.ts         Assertions that carry a mandatory failure message
  screens/                  Screen objects
  tests/                    Specs, one directory per tag
  config/                   WDIO + Appium configuration
  tools/                    Selector audit

tools/                      Web selector audit
.github/workflows/          CI for both platforms
```

The important structural rule: **selectors live in exactly two files.** When the
product changes, you edit `web/support/elements.ts` or
`android/support/elements.ts` and nothing else.

---

## Running slices

Specs are tagged, so any slice runs on any device project.

```bash
npm run test:web:smoke        # @smoke      — is it up?
npm run test:web:functional   # @functional — recharge, bills, search, auth, validation
npm run test:web:a11y         # @a11y       — WCAG 2.1 AA via axe, keyboard, headings
npm run test:web:visual       # @visual     — screenshot diffs
npm run test:web:perf         # @perf       — web vitals against budgets
npm run test:web:seo          # @seo        — metadata, canonical, link health
npm run test:web:mobile       # Pixel 7 viewport

npm run test:android:smoke
npm run test:android:functional
npm run test:android:a11y
```

Web device projects: `chromium`, `mobile-chrome` (Pixel 7), `webkit`, `tablet`.

```bash
npx playwright test --project=mobile-chrome --grep @functional
```

---

## Configuration

Everything is read from `.env` (see `.env.example` for the annotated list). The
settings that change behaviour most:

| Variable | Default | Effect |
|---|---|---|
| `TEST_ENV` | `prod-readonly` | `staging` lifts the payment guards |
| `BASE_URL` | `https://www.freecharge.in` | Target host |
| `STRICT_SAFETY` | `true` | Fail a spec that triggers a blocked transactional request |
| `BLOCK_THIRD_PARTY` | `true` | Drop analytics/ads beacons |
| `TEST_MOBILE` | — | Automation account; unset makes authenticated specs skip |
| `TEST_STATIC_OTP` | — | Fixed OTP for allow-listed staging numbers |
| `ANDROID_APP_PATH` | — | APK to install; unset attaches to the installed build |
| `ANDROID_NO_RESET` | `true` | Keep app data between specs |

---

## Authenticated tests

Anything behind login needs a dedicated automation account **and** an OTP
strategy. Without both, those specs skip with a message explaining what to set —
they do not fail.

`shared/otp.ts` supports three approaches:

1. **Static OTP** (best) — the backend issues a fixed code for allow-listed test
   numbers on staging. Set `TEST_STATIC_OTP`. If this does not exist, it is worth
   asking the backend team for; it is the only clean way to automate OTP login.
2. **OTP provider** — an internal endpoint returning the last code for a number.
   Set `OTP_PROVIDER_URL` and `OTP_PROVIDER_TOKEN`.
3. **Captured session** — sign in by hand once and reuse the state.

What the suite deliberately does not do: scrape a personal inbox, drive an
SMS-forwarding app on a real handset, or retry codes in a loop. The wrong-OTP
spec submits exactly one incorrect code — looping would be a brute-force pattern
and would lock the account out.

---

## Visual regression

Baselines live in `web/tests/visual/__snapshots__/<project>/` and are committed.
Dynamic regions (carousels, offer banners, countdowns, iframes) are masked rather
than compared, and animations are frozen, so a healthy page renders identically
across runs.

```bash
npm run test:web:update-snapshots
```

Review the diff before committing an updated baseline — an updated snapshot is a
claim that the new rendering is correct.

Baselines are OS- and font-stack-specific. Generate them on the same image CI
uses, or the first CI run will fail on rasterisation differences alone.

---

## Performance budgets

Set in `web/support/perf.ts` for a mid-range Android on 4G, which is the median
FreeCharge user — not for the machine CI happens to run on.

| Metric | Budget |
|---|---|
| LCP | 4000 ms |
| CLS | 0.25 |
| FCP | 3000 ms |
| TTFB | 1800 ms |
| Longest main-thread task | 500 ms |
| Page weight | 6 MB |
| Requests | 200 |

Every perf spec prints its full measurement before asserting, so a failure tells
you what regressed. Numbers off a shared CI runner are noisy: treat one failure
as a prompt to re-measure and a sustained trend as a regression. The CI workflow
runs perf on a schedule rather than on every PR for this reason.

---

## Accessibility

Web specs gate on axe's **critical** and **serious** WCAG 2.1 A/AA violations and
report moderate/minor ones as annotations, so the backlog stays visible without
the build being permanently red. Third-party chat and ad frames are excluded —
real problems, but not fixable by the team running this suite.

Beyond axe: keyboard operability of the recharge form, focus-indicator
visibility, heading order, accessible names on every form field, and alt text.

Android has no axe equivalent, so those specs read the view hierarchy directly:
content-desc on every clickable node, 48dp minimum touch targets, hints on text
fields, and survival at a 1.3× system font scale.

---

## CI

- `.github/workflows/web-tests.yml` — smoke on every push/PR, then functional,
  a11y, SEO and responsive in parallel; visual on non-fork branches; perf on a
  schedule. Also runs weekday mornings at 06:30 IST.
- `.github/workflows/android-tests.yml` — emulator matrix (API 30 and 34) via
  `reactivecircus/android-emulator-runner`. Manual dispatch takes an APK artifact
  name; a weekly scheduled regression run also exists.

CI runs read-only against production. Point a dispatch run at staging and set
`TEST_ENV` there if you need the transactional specs.

---

## When a test fails

**A selector chain went stale.** The error names every candidate it tried. Run
the relevant audit, then fix that one chain in the element map.

**The page changed shape.** Category labels live in `shared/data/catalog.ts`;
specs skip themselves for categories the product no longer offers rather than
failing.

**A spec hit the payment guard.** `assertNoUnsafeRequests` failed, or `safeTap`
threw a `PaymentGuardError`. Either the flow now reaches payment earlier than it
used to, or the spec walks too far. Stop the flow earlier, or move the spec
behind `TEST_ENV=staging`.

**Android: no idea what the app is showing.** Failures automatically save a
screenshot and the full view hierarchy to `artifacts/android/`. `dumpHierarchy()`
in `android/support/device.ts` does the same on demand.

---

## Known limitations

- **Selectors are unverified.** See the top of this file. This is the single
  biggest thing to resolve before trusting a run.
- **No web transactional coverage.** Nothing past the payment-method screen is
  tested. Extending that requires a staging environment with a sandbox gateway;
  the guards and `TEST_ENV=staging` exist for exactly that.
- **Android auth is manual-first.** The smoothest path today is signing in by
  hand once and running with `ANDROID_NO_RESET=true`. A static staging OTP would
  remove that step.
- **No iOS.** The request covered web and Android. The screen-object and shared
  data layers would carry over; only `android/support/` would need an XCUITest
  counterpart.
- **Visual baselines are not committed** — there was no way to capture them
  without reaching the site. The first `--update-snapshots` run creates them.
