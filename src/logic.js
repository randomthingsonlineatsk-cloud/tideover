/*!
 * TideOver rules: amounts, dates, notes and duplicate keys. No I/O, so every rule is tested offline.
 * Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the Apache License 2.0.
 */

export const MIN_INR = 2000;
export const LOCK_HOURS = 2;           // a claim hides the request for this long
export const STAMP_DAYS = 14;          // time the person has to upload the stamped bill after the receipt
export const PURGE_DAYS = 30;          // closed requests are deleted after this
export const DUE_AHEAD_DAYS = 60;
export const OVERDUE_DAYS = 90;
export const REPORTS_TO_HIDE = 3;
export const REMOVALS_TO_BLOCK = 2;
export const MAX_ACTIVE_CLAIMS = 3;
export const MAX_UPLOAD_BYTES = 1900000; // D1 stores values up to 2 MB

// Approximate value of one unit of each currency in Indian rupees (October 2026). Used only to turn the
// ₹2,000 minimum into a local minimum; a company entry can set its own minimum instead.
export const INR_PER_UNIT = {
  INR: 1, USD: 88, EUR: 102, GBP: 117, CHF: 110, CAD: 63, AUD: 58, NZD: 51, SGD: 68, AED: 24, SAR: 23.5, QAR: 24, KWD: 287, OMR: 228, BHD: 234,
  JPY: 0.58, CNY: 12.3, HKD: 11.3, KRW: 0.062, TWD: 2.75, PHP: 1.52, IDR: 0.0054, MYR: 20.5, THB: 2.7, VND: 0.0034,
  PKR: 0.31, BDT: 0.72, LKR: 0.29, NPR: 0.625, BRL: 16, MXN: 4.8, ARS: 0.07, COP: 0.022, CLP: 0.093, PEN: 23.5,
  ZAR: 5, NGN: 0.058, KES: 0.68, GHS: 5.6, EGP: 1.8, MAD: 9.6, TRY: 2.1, SEK: 9.3, NOK: 8.7, DKK: 13.7, PLN: 24, CZK: 4.1, HUF: 0.26, ILS: 26,
};

/** Smallest amount a request may ask for, in the company's currency, rounded up to a tidy number. */
export function minimumFor(currency, companyMinimum) {
  if (companyMinimum) return Number(companyMinimum);
  const rate = INR_PER_UNIT[currency];
  if (!rate) return null;
  const raw = MIN_INR / rate;
  const step = raw >= 10000 ? 1000 : raw >= 1000 ? 100 : raw >= 100 ? 10 : 1;
  return Math.ceil(raw / step) * step;
}

export function amountBand(amount, currency) {
  const inr = amount * (INR_PER_UNIT[currency] || 0);
  if (!inr) return 'unknown';
  if (inr < 5000) return 'under ₹5k';
  if (inr < 20000) return '₹5k–20k';
  if (inr < 100000) return '₹20k–1L';
  return 'over ₹1L';
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|org|net|io|me|co|ly|gg|xyz|app|link)\b)/i;
const CONTACT_RE = /(@|\b\d[\d\s-]{7,}\d\b|upi|paytm|gpay|phonepe|whatsapp|telegram|venmo|cash ?app|paypal|zelle|iban|ifsc|bank account)/i;

/** Checks a note written by the person asking. Payment handles and contact details are not allowed. */
export function checkNote(note) {
  const n = String(note || '').trim();
  if (n.length > 300) return 'The note can be at most 300 characters.';
  if (URL_RE.test(n)) return 'Links are not allowed in the note.';
  if (CONTACT_RE.test(n)) return 'Phone numbers, emails and payment details are not allowed in the note. Donors only ever pay the bill company.';
  return null;
}

export function normaliseAccount(acc) {
  return String(acc || '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Validates a new request against its company and today's date.
 * Returns { ok: true, value } or { ok: false, check, message } naming the check that failed.
 */
export function validateRequest(input, company, today) {
  const fail = (check, message) => ({ ok: false, check, message });
  if (!company || !company.active) return fail('company', 'Pick the bill company from the list for your country.');
  if (!company.third_party_ok) return fail('company', 'This company does not accept payments from other people, so donors could not pay it.');
  const billType = String(input.billType || '');
  const types = JSON.parse(company.bill_types || '[]');
  if (!types.includes(billType)) return fail('company', 'Choose the type of bill this company sends.');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return fail('amount', 'Enter the amount due, in numbers.');
  const min = minimumFor(company.currency, company.min_amount);
  if (min === null) return fail('amount', 'This currency is not set up yet. Please suggest it through the directory.');
  if (amount < min) return fail('amount', `Requests must be at least ${company.currency} ${min.toLocaleString('en')} (about ₹${MIN_INR.toLocaleString('en-IN')}).`);
  const due = String(input.dueDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) return fail('due', 'Enter the due date shown on the bill.');
  if (due > addDays(today, DUE_AHEAD_DAYS)) return fail('due', `The bill must be due within ${DUE_AHEAD_DAYS} days.`);
  if (due < addDays(today, -OVERDUE_DAYS)) return fail('due', `Bills overdue by more than ${OVERDUE_DAYS} days can't be posted.`);
  const account = normaliseAccount(input.account);
  if (!/^[A-Z0-9/._]{3,40}$/.test(account)) return fail('account', 'Enter the account or consumer number exactly as printed on the bill.');
  const noteErr = checkNote(input.note);
  if (noteErr) return fail('note', noteErr);
  const displayName = String(input.displayName || '').trim();
  if (!displayName || displayName.length > 30 || /[@\d]/.test(displayName)) return fail('name', 'Give a first name or nickname (up to 30 letters, no numbers).');
  const city = String(input.city || '').trim();
  if (city.length > 40) return fail('city', 'Keep the city under 40 characters.');
  if (!/^[0-9a-f]{16}$/.test(String(input.imageHash || ''))) return fail('bill', 'Add a photo of the bill so it can be read.');
  if (!input.readAmount) return fail('bill', 'The amount you typed could not be found on the bill photo. Try a clearer, straight photo of the whole bill.');
  return {
    ok: true,
    value: {
      billType, amount, currency: company.currency, dueDate: due, account, note: String(input.note || '').trim(),
      displayName, city, imageHash: input.imageHash, readCompany: !!input.readCompany, readDue: !!input.readDue,
    },
  };
}

/** Number of bits that differ between two 64-bit image fingerprints written as hex. */
export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

export const BILL_TYPES = {
  electricity: 'Electricity', gas: 'Gas', water: 'Water', phone: 'Phone', internet: 'Internet', rent: 'Rent (paid to a company)',
  education: 'School or college fees', medical: 'Hospital or medical', other: 'Other essential bill',
};
