# Test strategy

What this suite tests, what it deliberately does not, and why.

---

## Scope

FreeCharge is a bill-payment and recharge product. Its frontend has one job:
get a user from "I need to pay my electricity bill" to a payment screen, on a
phone, quickly. Everything here is organised around that funnel.

**Covered**

| Area | Web | Android |
|---|---|---|
| Site/app loads and renders | ✅ | ✅ |
| Category discovery (tiles, search, scroll) | ✅ | ✅ |
| Recharge/bill funnel up to the payment screen | ✅ | ✅ |
| Input validation (identifiers, amounts) | ✅ | ✅ |
| Operator/biller and circle selection | ✅ | ✅ |
| Login: client-side validation, OTP challenge | ✅ | ✅ |
| Login: full journey | gated on config | gated on config |
| Accessibility | axe WCAG 2.1 AA + keyboard | hierarchy-based |
| Responsive layout | 6 viewports | rotation |
| Performance | web vitals, budgets, throttling | — |
| Visual regression | masked screenshots | — |
| SEO / metadata / link health | ✅ | — |
| Lifecycle (background, restart, back) | — | ✅ |
| Connectivity loss | — | ✅ |

**Not covered, on purpose**

- **Anything past the payment-method screen.** See "The payment boundary".
- **Backend/API contracts.** This is a frontend suite; it asserts what the user
  sees. API contract tests belong beside the services that own them.
- **Load and stress.** Pointing concurrent load at a third party's production
  site is not testing, it is a denial-of-service. Worker counts are capped for
  the same reason.
- **Security probing.** The hostile-input specs assert the *frontend* does not
  crash or reflect markup. They do not probe the backend, and the payloads are
  inert.

---

## The payment boundary

This is the defining constraint of the suite.

FreeCharge moves real money. An automated suite pointed at production, signed
into a real account, that walks one screen too far, spends someone's money — and
it does so silently, with a green build. So the boundary is enforced twice, in
two independent ways, and the enforcement is itself tested.

**Web — network level.** `shared/safety.ts` defines what a transactional request
looks like: payment-gateway hosts (Razorpay, PayU, BillDesk, CCAvenue, Juspay,
NPCI, card networks) and endpoint patterns (`/payment`, `/order/create`,
`/wallet/debit`, `/upi/pay`). The `page` fixture aborts them. Specs then assert
via `assertNoUnsafeRequests()` that they never triggered one — so "did the flow
stay safe" is a tested property, not an assumption.

**Android — interaction level.** There is no request hook on a device without
standing up a proxy, so `android/support/guard.ts` works one layer up: `safeTap`
reads a control's label before pressing it and refuses anything matching "Pay
Now", "Proceed to Pay", "Confirm Payment", "Verify UPI PIN". Screen objects tap
only through `safeTap`. The deepest spec catches `PaymentGuardError` explicitly
and treats it as the pass condition.

Both are active when `TEST_ENV=prod-readonly`, the default. `TEST_ENV=staging`
lifts them — use it only against a non-production host with a sandbox gateway.

A consequence worth stating plainly: **checkout and payment are untested.** That
is a real coverage gap, not a solved problem. Closing it needs a staging
environment; the switch to do it already exists.

---

## Assertion philosophy

**Assert the user outcome, not the implementation.** A validation spec asks "was
the user stopped?", and accepts any of: an inline error, a disabled button, or
the field filtering the input as it is typed. All three are legitimate product
choices. Only silently proceeding with bad input is a bug.

This matters more than it sounds. A spec that demands a specific error message
fails when copy changes, teaching the team the suite is noise. A spec that
demands the user was stopped keeps working across three redesigns.

**Every failure explains itself.** No assertion in this suite fails with
"expected true, received false". Selector failures name every candidate tried.
Accessibility failures name the node and link the axe rule. Performance failures
print the full measurement. Responsive failures name the element that overflowed
and by how many pixels. On Android, `android/support/assert.ts` exists because
expect-webdriverio has no message parameter — the message is mandatory there.

**Skip rather than fail for things outside the product's control.** A category
the product no longer sells, an OTP strategy that is not configured, an emulator
that will not let a spec toggle the radio — these skip with an explanatory
message. A red build should mean something is broken.

---

## Flakiness

A UI suite against a third-party production site has more sources of
non-determinism than a suite against your own staging box, so several decisions
exist purely to keep the signal clean:

- **Candidate chains** absorb markup drift that would otherwise be a failure.
- **`settle()`** clears cookie banners and promo interstitials before every
  interaction, on both platforms.
- **Third-party beacons are blocked** by default — fewer requests, less noise,
  and no bot traffic in the product's analytics.
- **Ignorable console errors are allow-listed** (`web/support/fixtures.ts`);
  ad-frame noise is not a product failure.
- **Visual specs freeze animations and mask dynamic regions.** A carousel would
  otherwise fail every run.
- **`networkidle` waits have a ceiling** and treat a timeout as "settled
  enough" — a consumer site polls forever.
- **Perf specs run serially with one retry** and are scheduled rather than
  gating PRs.
- **Workers are capped** at 4 in CI, 2 locally.

---

## Test data

`shared/data/` is the single source for both platforms.

`catalog.ts` describes the ~17 bill categories: their labels, whether they need a
biller, what identifier they ask for, whether the amount is typed or fetched.
Both suites iterate it, so adding a category means adding one entry.

`inputs.ts` holds validation vectors — mobile numbers (valid, malformed,
normalisable), amounts, vehicle numbers, and strings that historically break form
handling. Everything is synthetic: placeholder number ranges, and card numbers
that are the industry-standard test PANs, used only as bill-payment *identifiers*,
never in a payment form.

---

## What I would build next

In rough order of value:

1. **A staging target.** It unblocks payment coverage, makes OTP login reliable,
   and lets the transactional specs run. Everything else is downstream of it.
2. **`data-testid` / `contentDescription` on the funnel elements.** ~20
   attributes would make most of the selector maintenance disappear.
   `docs/maintaining-selectors.md` lists which.
3. **Visual baselines**, captured on the CI image.
4. **iOS**, reusing the screen objects and shared data.
5. **Trend reporting** for perf and a11y, so slow regressions are visible before
   they cross a budget.
