/*!
 * First entries of the TideOver bill company directory.
 * Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the Apache License 2.0.
 *
 * India starts with companies paid through Bharat BillPay (Bharat Connect), the national bill payment
 * system built into UPI apps: anyone can pay any customer's bill with the consumer number, and the money
 * goes to the company through the system itself, so there is no payment link that could be faked.
 * Other countries are added by the admin after checking each company's official payment page.
 */
const BBPS = (type, name) => `Open any UPI app with a "Pay bills" section (for example BHIM, Google Pay, PhonePe or Paytm). Choose ${type}, search for "${name}", enter the consumer or account number shown here, check that the amount due matches, and pay. Save the receipt the app shows.`;

const IN = (id, name, types, label) => ({
  id, country: 'IN', name, bill_types: JSON.stringify(types), currency: 'INR', pay_url: null, how_to_pay: BBPS(label, name),
  route: 'Bharat BillPay', third_party_ok: 1, checked_by: 'Bharat BillPay (standard route)', checked_on: '2026-10-28', active: 1, min_amount: null,
});

export const SEED_COMPANIES = [
  IN('in-msedcl', 'Maharashtra State Electricity Distribution (MSEDCL, Mahavitaran)', ['electricity'], 'Electricity'),
  IN('in-adani-mumbai', 'Adani Electricity Mumbai', ['electricity'], 'Electricity'),
  IN('in-tatapower-mumbai', 'Tata Power (Mumbai)', ['electricity'], 'Electricity'),
  IN('in-best', 'BEST Undertaking (Mumbai electricity)', ['electricity'], 'Electricity'),
  IN('in-bses-rajdhani', 'BSES Rajdhani Power (Delhi)', ['electricity'], 'Electricity'),
  IN('in-bses-yamuna', 'BSES Yamuna Power (Delhi)', ['electricity'], 'Electricity'),
  IN('in-tpddl', 'Tata Power Delhi Distribution', ['electricity'], 'Electricity'),
  IN('in-bescom', 'BESCOM (Bengaluru)', ['electricity'], 'Electricity'),
  IN('in-cesc', 'CESC (Kolkata)', ['electricity'], 'Electricity'),
  IN('in-mgl', 'Mahanagar Gas (Mumbai)', ['gas'], 'Gas (piped)'),
  IN('in-igl', 'Indraprastha Gas (Delhi)', ['gas'], 'Gas (piped)'),
  IN('in-airtel-postpaid', 'Airtel Postpaid', ['phone', 'internet'], 'Mobile postpaid or broadband'),
  IN('in-jio-postpaid', 'Jio Postpaid', ['phone', 'internet'], 'Mobile postpaid or broadband'),
  IN('in-vi-postpaid', 'Vi (Vodafone Idea) Postpaid', ['phone'], 'Mobile postpaid'),
  IN('in-bsnl', 'BSNL (landline and broadband)', ['phone', 'internet'], 'Landline or broadband'),
];
