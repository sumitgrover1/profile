/**
 * Reference data for the products FreeCharge sells.
 *
 * These are the *categories and inputs* the tests drive, not assertions about
 * FreeCharge's live catalogue. Operator lists change; treat them as candidate
 * values and let the specs assert against whatever the UI actually offers.
 */

export type BillCategory =
  | 'mobile-prepaid'
  | 'mobile-postpaid'
  | 'dth'
  | 'electricity'
  | 'gas-piped'
  | 'gas-cylinder'
  | 'water'
  | 'broadband'
  | 'landline'
  | 'credit-card'
  | 'loan-repayment'
  | 'insurance'
  | 'fastag'
  | 'municipal-tax'
  | 'cable-tv'
  | 'education-fee'
  | 'subscription';

export interface CategorySpec {
  id: BillCategory;
  /** Words that plausibly appear on the tile/nav entry. Matched case-insensitively. */
  labels: string[];
  /** Whether the flow needs an operator/biller picked before the identifier. */
  requiresOperator: boolean;
  /** Human label for the account identifier the flow asks for. */
  identifierLabel: string;
  /** True if the amount is fetched from the biller rather than typed by the user. */
  amountFetched: boolean;
}

export const CATEGORIES: readonly CategorySpec[] = [
  {
    id: 'mobile-prepaid',
    labels: ['Mobile Recharge', 'Prepaid', 'Mobile Prepaid'],
    requiresOperator: true,
    identifierLabel: 'Mobile number',
    amountFetched: false,
  },
  {
    id: 'mobile-postpaid',
    labels: ['Postpaid', 'Mobile Postpaid'],
    requiresOperator: true,
    identifierLabel: 'Mobile number',
    amountFetched: true,
  },
  {
    id: 'dth',
    labels: ['DTH', 'DTH Recharge', 'Dish TV'],
    requiresOperator: true,
    identifierLabel: 'Subscriber ID',
    amountFetched: false,
  },
  {
    id: 'electricity',
    labels: ['Electricity', 'Electricity Bill'],
    requiresOperator: true,
    identifierLabel: 'Consumer number',
    amountFetched: true,
  },
  {
    id: 'gas-piped',
    labels: ['Piped Gas', 'Gas'],
    requiresOperator: true,
    identifierLabel: 'Customer ID',
    amountFetched: true,
  },
  {
    id: 'gas-cylinder',
    labels: ['Book a Cylinder', 'LPG', 'Cylinder'],
    requiresOperator: true,
    identifierLabel: 'Registered mobile number',
    amountFetched: true,
  },
  {
    id: 'water',
    labels: ['Water', 'Water Bill'],
    requiresOperator: true,
    identifierLabel: 'Consumer number',
    amountFetched: true,
  },
  {
    id: 'broadband',
    labels: ['Broadband', 'Broadband Bill'],
    requiresOperator: true,
    identifierLabel: 'Account number',
    amountFetched: true,
  },
  {
    id: 'landline',
    labels: ['Landline'],
    requiresOperator: true,
    identifierLabel: 'Landline number',
    amountFetched: true,
  },
  {
    id: 'credit-card',
    labels: ['Credit Card', 'Credit Card Bill'],
    requiresOperator: true,
    identifierLabel: 'Card number',
    amountFetched: false,
  },
  {
    id: 'loan-repayment',
    labels: ['Loan Repayment', 'Loan'],
    requiresOperator: true,
    identifierLabel: 'Loan account number',
    amountFetched: true,
  },
  {
    id: 'insurance',
    labels: ['Insurance', 'Insurance Premium'],
    requiresOperator: true,
    identifierLabel: 'Policy number',
    amountFetched: true,
  },
  {
    id: 'fastag',
    labels: ['FASTag', 'Fastag Recharge'],
    requiresOperator: true,
    identifierLabel: 'Vehicle number',
    amountFetched: false,
  },
  {
    id: 'municipal-tax',
    labels: ['Municipal Tax', 'Municipality', 'Property Tax'],
    requiresOperator: true,
    identifierLabel: 'Property ID',
    amountFetched: true,
  },
  {
    id: 'cable-tv',
    labels: ['Cable TV', 'Cable'],
    requiresOperator: true,
    identifierLabel: 'Subscriber ID',
    amountFetched: true,
  },
  {
    id: 'education-fee',
    labels: ['Education Fee', 'School Fee'],
    requiresOperator: true,
    identifierLabel: 'Registration number',
    amountFetched: true,
  },
  {
    id: 'subscription',
    labels: ['Subscription', 'OTT'],
    requiresOperator: true,
    identifierLabel: 'Subscriber ID',
    amountFetched: false,
  },
];

export function category(id: BillCategory): CategorySpec {
  const found = CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown category: ${id}`);
  return found;
}

/** Categories that are safe to exercise end-to-end short of payment. */
export const CORE_CATEGORIES: readonly BillCategory[] = [
  'mobile-prepaid',
  'dth',
  'electricity',
  'broadband',
  'credit-card',
];

export const CIRCLES: readonly string[] = [
  'Delhi NCR',
  'Mumbai',
  'Karnataka',
  'Maharashtra',
  'Tamil Nadu',
  'Andhra Pradesh',
  'West Bengal',
  'Gujarat',
  'Rajasthan',
  'Kerala',
  'Punjab',
  'UP East',
  'UP West',
  'Bihar Jharkhand',
  'Madhya Pradesh',
  'Haryana',
  'Assam',
  'Orissa',
  'North East',
  'Himachal Pradesh',
  'Jammu Kashmir',
  'Chennai',
  'Kolkata',
];

export const MOBILE_OPERATORS: readonly string[] = ['Airtel', 'Jio', 'Vi', 'Vodafone', 'Idea', 'BSNL', 'MTNL'];

export const DTH_OPERATORS: readonly string[] = [
  'Tata Play',
  'Tata Sky',
  'Airtel Digital TV',
  'Dish TV',
  'd2h',
  'Sun Direct',
];
