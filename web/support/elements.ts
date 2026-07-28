import { el, type ElementSpec } from './locators';

/**
 * The element map: every selector the web suite uses lives here and nowhere else.
 *
 * IMPORTANT — read before you trust these chains.
 *
 * The candidate chains below were authored from FreeCharge's published product
 * surface (the categories it sells, the standard labels those flows use) rather
 * than from a live DOM dump, because the machine this suite was written on could
 * not reach www.freecharge.in. They are deliberately built out of role/label/text
 * candidates, which survive markup churn far better than CSS, but they are
 * *hypotheses until verified*.
 *
 * Before the first real run:
 *   1. From a network that can reach the site, run `npm run verify:selectors:web`.
 *   2. It prints, for every element below, which candidates matched and how many
 *      nodes each one hit.
 *   3. Fix any element that reports zero matches by editing its chain here.
 *      No spec file needs to change.
 *
 * Adding a `data-testid` to the product is always the better fix — the `testid`
 * candidate is listed first on every element so the chain upgrades itself the
 * moment the attribute ships.
 */

// ---------------------------------------------------------------------------
// Global chrome
// ---------------------------------------------------------------------------

export const chrome = {
  header: el('site header', [
    { kind: 'testid', value: 'site-header' },
    { kind: 'role', role: 'banner' },
    { kind: 'css', value: 'header' },
  ]),

  logo: el('FreeCharge logo', [
    { kind: 'testid', value: 'header-logo' },
    { kind: 'role', role: 'link', name: /freecharge/i },
    { kind: 'altText', value: /freecharge/i },
    { kind: 'css', value: 'header a[href="/"]' },
  ]),

  footer: el('site footer', [
    { kind: 'testid', value: 'site-footer' },
    { kind: 'role', role: 'contentinfo' },
    { kind: 'css', value: 'footer' },
  ]),

  loginEntry: el('login / sign-up entry point', [
    { kind: 'testid', value: 'header-login' },
    { kind: 'role', role: 'button', name: /^(login|sign ?in|log ?in)$/i },
    { kind: 'role', role: 'link', name: /^(login|sign ?in|log ?in)$/i },
    { kind: 'text', value: /^(login|sign ?in)$/i },
  ]),

  accountMenu: el('logged-in account menu', [
    { kind: 'testid', value: 'account-menu' },
    { kind: 'role', role: 'button', name: /(my account|profile|hi,|hello,)/i },
  ]),

  searchEntry: el('search entry point', [
    { kind: 'testid', value: 'search-input' },
    { kind: 'role', role: 'searchbox' },
    { kind: 'role', role: 'combobox', name: /search/i },
    { kind: 'placeholder', value: /search/i },
    { kind: 'css', value: 'input[type="search"]' },
  ]),

  searchResults: el('search result list', [
    { kind: 'testid', value: 'search-results' },
    { kind: 'role', role: 'listbox' },
    { kind: 'css', value: '[class*="searchResult" i], [class*="suggestion" i]' },
  ]),

  cookieAccept: el(
    'cookie consent accept',
    [
      { kind: 'testid', value: 'cookie-accept' },
      { kind: 'role', role: 'button', name: /^(accept|allow|agree|got it|ok)/i },
      { kind: 'text', value: /^(accept all|i agree|got it)$/i },
    ],
    true,
  ),

  modalDismiss: el(
    'promotional modal close',
    [
      { kind: 'testid', value: 'modal-close' },
      { kind: 'role', role: 'button', name: /^(close|dismiss|no thanks|maybe later|×|✕)$/i },
      { kind: 'css', value: '[class*="modal" i] [class*="close" i]' },
      { kind: 'css', value: '[aria-label="Close"]' },
    ],
    true,
  ),

  appStoreBadge: el(
    'Google Play badge',
    [
      { kind: 'altText', value: /google play/i },
      { kind: 'role', role: 'link', name: /google play/i },
      { kind: 'css', value: 'a[href*="play.google.com"]' },
    ],
    true,
  ),
} satisfies Record<string, ElementSpec>;

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

export const home = {
  hero: el('hero / primary banner', [
    { kind: 'testid', value: 'home-hero' },
    { kind: 'role', role: 'main' },
    { kind: 'css', value: 'main, [class*="hero" i], [class*="banner" i]' },
  ]),

  categoryGrid: el('bill category grid', [
    { kind: 'testid', value: 'category-grid' },
    { kind: 'role', role: 'navigation', name: /categor|service/i },
    { kind: 'css', value: '[class*="categor" i], [class*="services" i]' },
  ]),

  /** A category tile addressed by its visible label, e.g. "Electricity". */
  categoryTile: (label: string): ElementSpec =>
    el(`category tile "${label}"`, [
      { kind: 'testid', value: `category-${label.toLowerCase().replace(/\s+/g, '-')}` },
      { kind: 'role', role: 'link', name: new RegExp(label, 'i') },
      { kind: 'role', role: 'button', name: new RegExp(label, 'i') },
      { kind: 'text', value: new RegExp(`^\\s*${label}\\s*$`, 'i') },
    ]),

  offersSection: el(
    'offers / cashback section',
    [
      { kind: 'testid', value: 'offers-section' },
      { kind: 'role', role: 'region', name: /offer|cashback|deal/i },
      { kind: 'text', value: /offers?|cashback/i },
    ],
    true,
  ),
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Recharge / bill payment flow
// ---------------------------------------------------------------------------

export const flow = {
  /** The panel that holds the recharge/bill form, used to scope other lookups. */
  form: el('recharge / bill form', [
    { kind: 'testid', value: 'recharge-form' },
    { kind: 'role', role: 'form' },
    { kind: 'css', value: 'form' },
  ]),

  mobileNumberInput: el('mobile number input', [
    { kind: 'testid', value: 'mobile-number' },
    { kind: 'role', role: 'textbox', name: /mobile|phone|number/i },
    { kind: 'label', value: /mobile|phone number/i },
    { kind: 'placeholder', value: /mobile|phone|10.?digit/i },
    { kind: 'css', value: 'input[type="tel"]' },
    { kind: 'css', value: 'input[name*="mobile" i], input[id*="mobile" i]' },
  ]),

  accountIdentifierInput: el('account / consumer identifier input', [
    { kind: 'testid', value: 'account-number' },
    { kind: 'role', role: 'textbox', name: /consumer|account|subscriber|customer|policy|card|registration/i },
    { kind: 'label', value: /consumer|account|subscriber|customer id|policy|card number/i },
    { kind: 'placeholder', value: /consumer|account|subscriber|customer id/i },
    { kind: 'css', value: 'input[name*="account" i], input[name*="consumer" i], input[name*="subscriber" i]' },
  ]),

  amountInput: el('amount input', [
    { kind: 'testid', value: 'amount' },
    { kind: 'role', role: 'textbox', name: /amount/i },
    { kind: 'role', role: 'spinbutton', name: /amount/i },
    { kind: 'label', value: /amount/i },
    { kind: 'placeholder', value: /amount|enter ₹|\brs\b/i },
    { kind: 'css', value: 'input[name*="amount" i], input[id*="amount" i]' },
  ]),

  operatorPicker: el('operator / biller picker', [
    { kind: 'testid', value: 'operator-select' },
    { kind: 'role', role: 'combobox', name: /operator|biller|provider|board|bank|company/i },
    { kind: 'label', value: /operator|biller|provider|select board/i },
    { kind: 'placeholder', value: /operator|biller|provider|select/i },
    { kind: 'css', value: 'select[name*="operator" i], [class*="operator" i] input' },
  ]),

  circlePicker: el(
    'circle / state picker',
    [
      { kind: 'testid', value: 'circle-select' },
      { kind: 'role', role: 'combobox', name: /circle|state|region/i },
      { kind: 'label', value: /circle|state/i },
      { kind: 'placeholder', value: /circle|state/i },
      { kind: 'css', value: 'select[name*="circle" i]' },
    ],
    true,
  ),

  /** A dropdown option addressed by visible text. */
  option: (label: string): ElementSpec =>
    el(`dropdown option "${label}"`, [
      { kind: 'role', role: 'option', name: new RegExp(label, 'i') },
      { kind: 'text', value: new RegExp(`^\\s*${label}\\s*$`, 'i') },
      { kind: 'css', value: `[role="option"]:has-text("${label}")` },
    ]),

  proceedButton: el('proceed / continue button', [
    { kind: 'testid', value: 'proceed' },
    { kind: 'role', role: 'button', name: /^(proceed|continue|next|submit|get plans?|fetch bill|view bill|pay now)/i },
    { kind: 'css', value: 'button[type="submit"]' },
  ]),

  browsePlansLink: el(
    'browse plans link',
    [
      { kind: 'testid', value: 'browse-plans' },
      { kind: 'role', role: 'button', name: /browse plans?|view plans?|see plans?/i },
      { kind: 'role', role: 'link', name: /browse plans?|view plans?/i },
    ],
    true,
  ),

  planList: el('plan list', [
    { kind: 'testid', value: 'plan-list' },
    { kind: 'role', role: 'list', name: /plan/i },
    { kind: 'css', value: '[class*="plan" i][class*="list" i], [class*="planCard" i]' },
  ]),

  planCard: el('individual plan card', [
    { kind: 'testid', value: 'plan-card' },
    { kind: 'role', role: 'listitem' },
    { kind: 'css', value: '[class*="planCard" i], [class*="plan-item" i]' },
  ]),

  /** Inline validation message attached to a field. */
  fieldError: el('inline field error', [
    { kind: 'testid', value: 'field-error' },
    { kind: 'role', role: 'alert' },
    { kind: 'css', value: '[class*="error" i]:not(:empty), [class*="invalid" i]:not(:empty)' },
    { kind: 'css', value: '[aria-invalid="true"] ~ *' },
  ]),

  billSummary: el('fetched bill summary', [
    { kind: 'testid', value: 'bill-summary' },
    { kind: 'role', role: 'region', name: /bill|summary|due/i },
    { kind: 'text', value: /due (date|amount)|bill amount/i },
  ]),

  /**
   * Payment method selection. The suite navigates *to* this screen to prove the
   * flow reaches it, and stops. Nothing below this point is ever clicked in
   * prod-readonly mode — see shared/safety.ts.
   */
  paymentScreen: el('payment method screen', [
    { kind: 'testid', value: 'payment-options' },
    { kind: 'role', role: 'region', name: /payment|pay (using|with)/i },
    { kind: 'text', value: /(payment (method|option)|pay using|upi|net ?banking|debit card)/i },
  ]),
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export const auth = {
  mobileInput: el('login mobile number input', [
    { kind: 'testid', value: 'login-mobile' },
    { kind: 'role', role: 'textbox', name: /mobile|phone/i },
    { kind: 'placeholder', value: /mobile|phone|10.?digit/i },
    { kind: 'css', value: 'input[type="tel"]' },
  ]),

  requestOtpButton: el('request OTP button', [
    { kind: 'testid', value: 'send-otp' },
    { kind: 'role', role: 'button', name: /(send|get|request).*(otp|code)|continue|proceed/i },
  ]),

  otpInput: el('OTP input', [
    { kind: 'testid', value: 'otp-input' },
    { kind: 'role', role: 'textbox', name: /otp|code|verification/i },
    { kind: 'label', value: /otp|verification code/i },
    { kind: 'placeholder', value: /otp|code/i },
    { kind: 'css', value: 'input[autocomplete="one-time-code"]' },
  ]),

  /** Some OTP UIs render one box per digit. */
  otpDigitBoxes: el(
    'OTP digit boxes',
    [
      { kind: 'testid', value: 'otp-digit' },
      { kind: 'css', value: 'input[maxlength="1"]' },
    ],
    true,
  ),

  verifyButton: el('verify OTP button', [
    { kind: 'testid', value: 'verify-otp' },
    { kind: 'role', role: 'button', name: /verify|confirm|submit|login/i },
  ]),

  resendOtp: el(
    'resend OTP',
    [
      { kind: 'testid', value: 'resend-otp' },
      { kind: 'role', role: 'button', name: /resend/i },
      { kind: 'text', value: /resend (otp|code)/i },
    ],
    true,
  ),

  authError: el('authentication error message', [
    { kind: 'testid', value: 'auth-error' },
    { kind: 'role', role: 'alert' },
    { kind: 'text', value: /(invalid|incorrect|expired).*(otp|number|code)/i },
  ]),

  logout: el('logout control', [
    { kind: 'testid', value: 'logout' },
    { kind: 'role', role: 'button', name: /log ?out|sign ?out/i },
    { kind: 'role', role: 'link', name: /log ?out|sign ?out/i },
  ]),
} satisfies Record<string, ElementSpec>;

/** Every non-parameterised element, for the verification tool to sweep. */
export const ALL_ELEMENTS: Record<string, ElementSpec> = {
  ...Object.fromEntries(Object.entries(chrome).map(([k, v]) => [`chrome.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(home)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k, v]) => [`home.${k}`, v as ElementSpec]),
  ),
  ...Object.fromEntries(
    Object.entries(flow)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k, v]) => [`flow.${k}`, v as ElementSpec]),
  ),
  ...Object.fromEntries(Object.entries(auth).map(([k, v]) => [`auth.${k}`, v])),
};
