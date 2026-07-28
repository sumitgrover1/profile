# Maintaining selectors

Every selector in this suite lives in one of two files:

- `web/support/elements.ts`
- `android/support/elements.ts`

Nothing else — no page object, no spec — contains a selector. When the product
changes, you edit one of those two files and the whole suite follows.

This document explains how the chains work and how to repair one.

---

## Why chains instead of selectors

A single selector per element is the normal approach and it is why most UI suites
rot. FreeCharge's markup is not ours: class names are hashed by the bundler,
`data-testid` attributes come and go with refactors, copy gets reworded by
marketing, and Android `resource-id`s are renamed by R8 between builds. One
selector per element means one point of failure per element, and a suite that
goes red every sprint gets muted rather than fixed.

So each element is an **ordered list of candidates**, and a resolver uses the
first one that actually attaches:

```ts
export const flow = {
  mobileNumberInput: el('mobile number input', [
    { kind: 'testid', value: 'mobile-number' },                       // best
    { kind: 'role', role: 'textbox', name: /mobile|phone|number/i },
    { kind: 'label', value: /mobile|phone number/i },
    { kind: 'placeholder', value: /mobile|phone|10.?digit/i },
    { kind: 'css', value: 'input[type="tel"]' },
    { kind: 'css', value: 'input[name*="mobile" i]' },                // last resort
  ]),
};
```

Ordering is deliberate, most stable first:

| Rank | Kind | Survives | Breaks on |
|---|---|---|---|
| 1 | `testid` | everything | attribute removed |
| 2 | `role` + accessible name | restyling, refactors | copy rewrite, a11y regression |
| 3 | `label` / `placeholder` | restyling | copy rewrite |
| 4 | `text` | restyling | copy rewrite, i18n |
| 5 | `css` | nothing much | any markup change |

The `testid` candidate is listed first on every element even where no such
attribute exists today. The moment the product ships one, the chain silently
upgrades to it — no edit needed.

---

## Repairing a stale chain

### 1. Run the audit

```bash
npm run verify:selectors:web
npm run verify:selectors:android
```

Output looks like:

```
OK     recharge::flow.mobileNumberInput
         ✔ testid=mobile-number                              1 node(s)
           role=textbox name=/mobile|phone|number/i          no match

MISS   recharge::flow.operatorPicker
           testid=operator-select                            no match
           role=combobox name=/operator|biller/i             no match
           label=/operator|biller|provider/i                 no match
           css=select[name*="operator" i]                    no match
```

| Status | Meaning | Action |
|---|---|---|
| `OK` | a candidate matched exactly one node | none |
| `AMBIG` | a candidate matched several nodes | tighten the chain, or the resolver takes the first match — which may not be the one you meant |
| `MISS` | nothing matched | repair required |

`MISS` on an element marked `optional` is expected — cookie banners and promo
modals are not always present.

### 2. Find what the element looks like now

**Web** — open the page, inspect the element, and prefer in this order: an
existing `data-testid`, the accessible name shown in the Accessibility panel, the
associated `<label>`, its visible text.

**Android** — the audit writes a full hierarchy dump per screen to
`artifacts/android/hierarchy/`. Open the XML and find the node. Appium Inspector
against the same session works too. On demand:

```ts
import { dumpHierarchy } from '../support/device';
await dumpHierarchy('whatever-screen');
```

### 3. Add a candidate — don't replace the chain

Put the new candidate at the position matching its stability and **leave the old
ones in place**. They cost nothing when they miss (each probe is ~250ms on web,
~400ms on Android, and only until one hits), and they keep the suite working
across app versions, A/B variants, and staging-vs-production differences.

```ts
operatorPicker: el('operator / biller picker', [
  { kind: 'testid', value: 'operator-select' },
  { kind: 'testid', value: 'biller-dropdown' },        // ← added, new build
  { kind: 'role', role: 'combobox', name: /operator|biller/i },
  // ...the rest, untouched
]),
```

### 4. Re-run the audit

Confirm `OK`, then run the specs that use it.

---

## Adding a new element

1. Add it to the element map with a chain of at least three candidates spanning
   different strategies — if all three are CSS, you have one selector wearing a
   disguise.
2. Give it a descriptive `name`; it appears verbatim in failure messages.
3. Mark it `optional` (third argument to `el` / `ael`) if a healthy page might
   legitimately not have it.
4. Use it through the page/screen object, never directly in a spec.

Parameterised elements — a category tile, a dropdown option — are functions
returning a spec:

```ts
categoryTile: (label: string): ElementSpec =>
  el(`category tile "${label}"`, [
    { kind: 'testid', value: `category-${label.toLowerCase().replace(/\s+/g, '-')}` },
    { kind: 'role', role: 'link', name: new RegExp(label, 'i') },
    { kind: 'text', value: new RegExp(`^\\s*${label}\\s*$`, 'i') },
  ]),
```

These are excluded from the audit sweep (it cannot guess the arguments), so
verify them by running a spec that uses them.

---

## Android specifics

`resource-id` candidates take a **bare** name:

```ts
{ kind: 'id', value: 'et_mobile' }
```

The selector builder qualifies it with `ANDROID_APP_PACKAGE` at runtime, so a
debug-suffixed or whitelabel package works without touching the map. Pass a fully
qualified id only for system UI:

```ts
{ kind: 'id', value: 'com.android.permissioncontroller:id/permission_allow_button' }
```

Android's `text()` matcher is exact and case-sensitive, which makes copy-based
selectors far more brittle than they need to be. Use the helpers instead:

| Helper | Matches |
|---|---|
| `textMatches('recharge')` | any text containing "recharge", case-insensitive |
| `descMatches('close')` | same, against `content-desc` |
| `clickableMatching('proceed\|continue')` | clickable nodes whose text matches |
| `fieldWithHint('mobile')` | `EditText` whose hint contains "mobile" |

A Compose UI may expose no `resource-id` at all — only semantics. There,
`accessibility` (content-desc) candidates are the only stable option, which is
another reason to push for content descriptions in the app: they serve TalkBack
users and the test suite at the same time.

---

## The better fix

Every repair described here is a workaround for markup the tests do not control.
The durable fix is `data-testid` on web and `contentDescription` on Android, on
the elements the funnels depend on:

- form inputs (identifier, amount)
- operator/biller and circle pickers
- the primary progression button
- category tiles
- the login and OTP fields

Roughly twenty attributes would move most of this map to a single-candidate
chain that never breaks. If you are in a position to ask the product teams for
them, that is the highest-leverage change available to this suite — and the
chains are already ordered to pick them up automatically the moment they land.
