import {
  ael,
  textMatches,
  descMatches,
  clickableMatching,
  fieldWithHint,
  type AndroidElementSpec,
} from './selectors';

/**
 * Element map for the FreeCharge Pay Bills Android app.
 *
 * Same caveat as the web map, and it matters more here: these chains were
 * authored from the app's documented feature set rather than from a live view
 * hierarchy, because no device or APK was available on the machine this was
 * written on.
 *
 * Before the first real run:
 *   1. Install the APK on a device or emulator.
 *   2. `npm run verify:selectors:android` — it reports which candidates match.
 *   3. Fix the chains that report zero matches. Only this file changes.
 *
 * To author a new chain, dump the hierarchy with `dumpHierarchy()` from
 * android/support/device.ts, or open Appium Inspector against the same session.
 *
 * The resource-id candidates use bare names (`et_mobile`) which the selector
 * builder qualifies with ANDROID_APP_PACKAGE at runtime, so a whitelabel or
 * debug-suffixed package works without editing every entry.
 */

// ---------------------------------------------------------------------------
// First run / permissions / onboarding
// ---------------------------------------------------------------------------

export const onboarding = {
  skip: ael(
    'skip onboarding',
    [
      { kind: 'accessibility', value: 'Skip' },
      { kind: 'id', value: 'btn_skip' },
      clickableMatching('skip'),
      textMatches('skip'),
    ],
    true,
  ),

  next: ael(
    'onboarding next',
    [
      { kind: 'accessibility', value: 'Next' },
      { kind: 'id', value: 'btn_next' },
      clickableMatching('next|continue|get started'),
    ],
    true,
  ),

  allowPermission: ael(
    'system permission allow',
    [
      { kind: 'id', value: 'com.android.permissioncontroller:id/permission_allow_button' },
      { kind: 'id', value: 'com.android.packageinstaller:id/permission_allow_button' },
      {
        kind: 'uiautomator',
        value: 'new UiSelector().textMatches("(?i)(allow|while using the app|only this time)")',
      },
    ],
    true,
  ),

  denyPermission: ael(
    'system permission deny',
    [
      { kind: 'id', value: 'com.android.permissioncontroller:id/permission_deny_button' },
      { kind: 'uiautomator', value: 'new UiSelector().textMatches("(?i)(deny|don.t allow)")' },
    ],
    true,
  ),

  updatePrompt: ael(
    'in-app update prompt',
    [textMatches('update.*app|new version|update now')],
    true,
  ),

  dismissDialog: ael(
    'dismiss dialog',
    [
      { kind: 'accessibility', value: 'Close' },
      { kind: 'id', value: 'iv_close' },
      { kind: 'id', value: 'btn_close' },
      descMatches('close|dismiss'),
      clickableMatching('later|not now|no thanks|cancel|dismiss'),
    ],
    true,
  ),
} satisfies Record<string, AndroidElementSpec>;

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export const homeScreen = {
  root: ael('home screen root', [
    { kind: 'id', value: 'home_container' },
    { kind: 'id', value: 'cl_home' },
    { kind: 'accessibility', value: 'Home' },
    textMatches('recharge|pay bills|what would you like'),
  ]),

  bottomNav: ael('bottom navigation bar', [
    { kind: 'id', value: 'bottom_navigation' },
    { kind: 'id', value: 'bnv_main' },
    { kind: 'className', value: 'com.google.android.material.bottomnavigation.BottomNavigationView' },
  ]),

  navTab: (label: string): AndroidElementSpec =>
    ael(`bottom nav tab "${label}"`, [
      { kind: 'accessibility', value: label },
      descMatches(label),
      textMatches(label),
    ]),

  searchEntry: ael('search entry', [
    { kind: 'id', value: 'et_search' },
    { kind: 'id', value: 'search_bar' },
    { kind: 'accessibility', value: 'Search' },
    fieldWithHint('search'),
    descMatches('search'),
  ]),

  /** A service tile on the home grid, addressed by its visible label. */
  serviceTile: (label: string): AndroidElementSpec =>
    ael(`service tile "${label}"`, [
      { kind: 'accessibility', value: label },
      descMatches(label),
      textMatches(label),
      {
        kind: 'xpath',
        value: `//*[@content-desc="${label}" or @text="${label}"]`,
      },
    ]),

  balance: ael(
    'wallet / balance display',
    [
      { kind: 'id', value: 'tv_balance' },
      textMatches('balance|₹'),
    ],
    true,
  ),
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export const authScreen = {
  mobileInput: ael('mobile number field', [
    { kind: 'id', value: 'et_mobile' },
    { kind: 'id', value: 'et_mobile_number' },
    { kind: 'id', value: 'edt_phone' },
    { kind: 'accessibility', value: 'Mobile number' },
    fieldWithHint('mobile'),
    fieldWithHint('phone'),
    { kind: 'className', value: 'android.widget.EditText' },
  ]),

  requestOtp: ael('request OTP button', [
    { kind: 'id', value: 'btn_proceed' },
    { kind: 'id', value: 'btn_get_otp' },
    clickableMatching('get otp|send otp|proceed|continue'),
  ]),

  otpInput: ael('OTP field', [
    { kind: 'id', value: 'et_otp' },
    { kind: 'id', value: 'otp_view' },
    { kind: 'accessibility', value: 'OTP' },
    fieldWithHint('otp'),
    fieldWithHint('code'),
  ]),

  verifyOtp: ael('verify OTP button', [
    { kind: 'id', value: 'btn_verify' },
    clickableMatching('verify|confirm|submit|login'),
  ]),

  authError: ael('auth error message', [
    { kind: 'id', value: 'tv_error' },
    textMatches('invalid|incorrect|expired'),
  ]),

  logout: ael('logout', [
    { kind: 'id', value: 'tv_logout' },
    clickableMatching('log ?out|sign ?out'),
  ]),
} satisfies Record<string, AndroidElementSpec>;

// ---------------------------------------------------------------------------
// Bill payment flow
// ---------------------------------------------------------------------------

export const billScreen = {
  operatorPicker: ael('operator / biller picker', [
    { kind: 'id', value: 'tv_operator' },
    { kind: 'id', value: 'spinner_operator' },
    { kind: 'accessibility', value: 'Select operator' },
    textMatches('select (operator|biller|provider|board)'),
  ]),

  operatorSearch: ael(
    'biller search field',
    [
      { kind: 'id', value: 'et_search_operator' },
      fieldWithHint('search'),
    ],
    true,
  ),

  operatorOption: (label: string): AndroidElementSpec =>
    ael(`operator option "${label}"`, [
      { kind: 'accessibility', value: label },
      textMatches(label),
      descMatches(label),
    ]),

  circlePicker: ael(
    'circle picker',
    [
      { kind: 'id', value: 'tv_circle' },
      { kind: 'id', value: 'spinner_circle' },
      textMatches('select (circle|state|region)'),
    ],
    true,
  ),

  identifierInput: ael('account / mobile identifier field', [
    { kind: 'id', value: 'et_number' },
    { kind: 'id', value: 'et_mobile' },
    { kind: 'id', value: 'et_account' },
    { kind: 'id', value: 'et_consumer_number' },
    fieldWithHint('mobile'),
    fieldWithHint('consumer'),
    fieldWithHint('account'),
    fieldWithHint('subscriber'),
    { kind: 'className', value: 'android.widget.EditText' },
  ]),

  amountInput: ael('amount field', [
    { kind: 'id', value: 'et_amount' },
    { kind: 'accessibility', value: 'Amount' },
    fieldWithHint('amount'),
    fieldWithHint('₹'),
  ]),

  proceed: ael('proceed button', [
    { kind: 'id', value: 'btn_proceed' },
    { kind: 'id', value: 'btn_continue' },
    clickableMatching('proceed|continue|next|fetch bill|view bill|get plans'),
  ]),

  fieldError: ael(
    'inline validation error',
    [
      { kind: 'id', value: 'tv_error' },
      { kind: 'id', value: 'textinput_error' },
      { kind: 'className', value: 'android.widget.Toast' },
      textMatches('valid|required|enter a'),
    ],
    true,
  ),

  planList: ael('plan list', [
    { kind: 'id', value: 'rv_plans' },
    { kind: 'id', value: 'recycler_plans' },
    { kind: 'className', value: 'androidx.recyclerview.widget.RecyclerView' },
  ]),

  billSummary: ael('fetched bill summary', [
    { kind: 'id', value: 'cl_bill_details' },
    textMatches('due (date|amount)|bill amount'),
  ]),

  /**
   * The payment-method screen. Tests assert they *reached* it and stop.
   * android/support/guard.ts refuses to tap anything on this screen.
   */
  paymentScreen: ael('payment method screen', [
    { kind: 'id', value: 'cl_payment_options' },
    textMatches('payment (method|option)|pay using|upi|net ?banking|debit card'),
  ]),
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Account / history
// ---------------------------------------------------------------------------

export const accountScreen = {
  orderHistory: ael('order / transaction history', [
    { kind: 'id', value: 'rv_transactions' },
    { kind: 'accessibility', value: 'Transactions' },
    textMatches('transaction|order history|my orders'),
  ]),

  profile: ael('profile screen', [
    { kind: 'id', value: 'cl_profile' },
    { kind: 'accessibility', value: 'Profile' },
    textMatches('profile|my account'),
  ]),

  emptyState: ael(
    'empty state message',
    [textMatches('no (transactions|orders|results)|nothing here|looks empty')],
    true,
  ),
} satisfies Record<string, AndroidElementSpec>;

/** Every non-parameterised element, for the verification tool. */
export const ALL_ANDROID_ELEMENTS: Record<string, AndroidElementSpec> = {
  ...Object.fromEntries(Object.entries(onboarding).map(([k, v]) => [`onboarding.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(homeScreen)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k, v]) => [`home.${k}`, v as AndroidElementSpec]),
  ),
  ...Object.fromEntries(Object.entries(authScreen).map(([k, v]) => [`auth.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(billScreen)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k, v]) => [`bill.${k}`, v as AndroidElementSpec]),
  ),
  ...Object.fromEntries(Object.entries(accountScreen).map(([k, v]) => [`account.${k}`, v])),
};
