/**
 * Input vectors for form-validation tests.
 *
 * Everything here is synthetic. Mobile numbers use the 99999xxxxx / 88888xxxxx
 * ranges that are conventionally used as placeholders, and no value in this file
 * corresponds to a real subscriber, card, or account.
 */

export interface InputCase {
  /** What is being fed in. */
  value: string;
  /** Short description used as the test title. */
  label: string;
  /** Whether the UI is expected to accept this value and let the user proceed. */
  valid: boolean;
  /** Substring expected in the inline error, when the value is invalid. */
  expectedErrorHint?: string;
}

/**
 * Indian mobile numbers: 10 digits, first digit 6-9.
 * Some UIs also accept a +91 / 0 prefix and normalise it.
 */
export const MOBILE_NUMBERS: readonly InputCase[] = [
  { value: '9999900001', label: 'valid 10-digit starting with 9', valid: true },
  { value: '8888800002', label: 'valid 10-digit starting with 8', valid: true },
  { value: '7777700003', label: 'valid 10-digit starting with 7', valid: true },
  { value: '6666600004', label: 'valid 10-digit starting with 6', valid: true },
  { value: '', label: 'empty', valid: false, expectedErrorHint: 'enter' },
  { value: '99999', label: 'too short', valid: false, expectedErrorHint: 'valid' },
  { value: '99999000012', label: 'too long', valid: false, expectedErrorHint: 'valid' },
  { value: '1234567890', label: 'starts with 1', valid: false, expectedErrorHint: 'valid' },
  { value: '5999900001', label: 'starts with 5', valid: false, expectedErrorHint: 'valid' },
  { value: '0000000000', label: 'all zeros', valid: false, expectedErrorHint: 'valid' },
  { value: 'abcdefghij', label: 'letters', valid: false, expectedErrorHint: 'valid' },
  { value: '99999 00001', label: 'contains a space', valid: false, expectedErrorHint: 'valid' },
  { value: '99999-00001', label: 'contains a hyphen', valid: false, expectedErrorHint: 'valid' },
  { value: '९९९९९००००१', label: 'Devanagari digits', valid: false, expectedErrorHint: 'valid' },
];

/** Numbers the UI should normalise to a bare 10-digit value rather than reject. */
export const MOBILE_NUMBERS_NORMALISED: readonly { input: string; normalised: string }[] = [
  { input: '+919999900001', normalised: '9999900001' },
  { input: '919999900001', normalised: '9999900001' },
  { input: '09999900001', normalised: '9999900001' },
];

export const AMOUNTS: readonly InputCase[] = [
  { value: '10', label: 'minimum plausible amount', valid: true },
  { value: '199', label: 'typical recharge', valid: true },
  { value: '1000', label: 'round thousand', valid: true },
  { value: '0', label: 'zero', valid: false, expectedErrorHint: 'amount' },
  { value: '-100', label: 'negative', valid: false, expectedErrorHint: 'amount' },
  { value: '0.5', label: 'sub-rupee fraction', valid: false, expectedErrorHint: 'amount' },
  { value: '99999999', label: 'absurdly large', valid: false, expectedErrorHint: 'amount' },
  { value: 'abc', label: 'letters', valid: false, expectedErrorHint: 'amount' },
  { value: '1e5', label: 'scientific notation', valid: false, expectedErrorHint: 'amount' },
  { value: '  ', label: 'whitespace only', valid: false, expectedErrorHint: 'amount' },
];

/**
 * Test card numbers. These are the industry-standard *test* PANs published by
 * card networks for sandbox use — they are not usable for real transactions and
 * are only ever typed into a bill-payment "card number" identifier field, never
 * into a payment form.
 */
export const CREDIT_CARD_IDENTIFIERS: readonly InputCase[] = [
  { value: '4111111111111111', label: 'Visa test PAN (Luhn-valid)', valid: true },
  { value: '5555555555554444', label: 'Mastercard test PAN (Luhn-valid)', valid: true },
  { value: '4111111111111112', label: 'Luhn-invalid', valid: false, expectedErrorHint: 'valid' },
  { value: '41111', label: 'too short', valid: false, expectedErrorHint: 'valid' },
  { value: 'not-a-card', label: 'letters', valid: false, expectedErrorHint: 'valid' },
];

/** Vehicle registration numbers for FASTag. Format: SS DD LL DDDD. */
export const VEHICLE_NUMBERS: readonly InputCase[] = [
  { value: 'DL01AB1234', label: 'standard Delhi format', valid: true },
  { value: 'KA05MN9876', label: 'standard Karnataka format', valid: true },
  { value: 'XX99ZZ0000', label: 'non-existent state code', valid: false, expectedErrorHint: 'valid' },
  { value: '1234', label: 'digits only', valid: false, expectedErrorHint: 'valid' },
];

/**
 * Strings that have historically broken form handling. Used to check the UI
 * rejects or escapes them cleanly — the assertion is "no crash, no reflected
 * markup", never that the payload does anything.
 */
export const HOSTILE_STRINGS: readonly { value: string; label: string }[] = [
  { value: "<script>void 0</script>", label: 'script tag' },
  { value: '"><img src=x>', label: 'attribute break-out' },
  { value: "' OR '1'='1", label: 'quote injection' },
  { value: '../../etc/passwd', label: 'path traversal' },
  { value: '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', label: 'astral-plane unicode' },
  { value: '‮reversed', label: 'right-to-left override' },
  { value: 'a'.repeat(5000), label: '5000-character string' },
  { value: '%00null', label: 'encoded null byte' },
];

/** Search terms used to exercise the site search / biller search. */
export const SEARCH_TERMS: readonly { term: string; expectResults: boolean; label: string }[] = [
  { term: 'electricity', expectResults: true, label: 'common category' },
  { term: 'airtel', expectResults: true, label: 'operator name' },
  { term: 'mobile recharge', expectResults: true, label: 'multi-word phrase' },
  { term: 'ELECTRICITY', expectResults: true, label: 'uppercase' },
  { term: 'electrcity', expectResults: true, label: 'common typo (fuzzy match expected)' },
  { term: 'zzzzqqqqxxxx', expectResults: false, label: 'nonsense string' },
  { term: '   ', expectResults: false, label: 'whitespace only' },
];
