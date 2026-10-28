/*!
 * TideOver bill reading: matches what a person typed against the text read from their bill photo.
 * Runs in the browser (and in tests). Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Apache-2.0.
 */

const DIGITS = { '०': 0, '१': 1, '२': 2, '३': 3, '४': 4, '५': 5, '६': 6, '७': 7, '८': 8, '९': 9 };
export function plainDigits(text) {
  return String(text || '')
    .replace(/[०-९]/g, (d) => DIGITS[d])
    .replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
}

/** All amounts written on a bill, as numbers. Handles 3,450.00 / 3.450,00 / 34,500 (Indian) / 3 450. */
export function amountsIn(text) {
  const out = new Set();
  const s = plainDigits(text).replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  for (const m of s.matchAll(/\d[\d,.\s']{0,14}\d|\d/g)) {
    const raw = m[0].replace(/\s+/g, ' ').trim();
    for (const part of raw.split(' ').concat([raw.replace(/ /g, '')])) {
      const t = part.replace(/'/g, '');
      if (!t) continue;
      const lastSep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
      let n;
      if (lastSep > -1 && t.length - lastSep - 1 === 2) n = Number(`${t.slice(0, lastSep).replace(/[.,]/g, '')}.${t.slice(lastSep + 1)}`);
      else n = Number(t.replace(/[.,]/g, ''));
      if (Number.isFinite(n)) out.add(Math.round(n * 100) / 100);
    }
  }
  return out;
}

export function amountFound(text, amount) {
  const want = Math.round(Number(amount) * 100) / 100;
  if (!want) return false;
  return amountsIn(text).has(want);
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** All calendar dates on a bill, as YYYY-MM-DD (day-first and month-first both kept when ambiguous). */
export function datesIn(text) {
  const out = new Set();
  const s = plainDigits(text);
  const add = (y, m, d) => {
    y = Number(y); if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  };
  for (const m of s.matchAll(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/g)) add(m[1], +m[2], +m[3]);
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})(?!\d)/g)) { add(m[3], +m[2], +m[1]); add(m[3], +m[1], +m[2]); }
  for (const m of s.toLowerCase().matchAll(/(\d{1,2})[\s.-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,-]*(\d{4}|\d{2})/g)) add(m[3], MON[m[2]], +m[1]);
  for (const m of s.toLowerCase().matchAll(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/g)) add(m[3], MON[m[1]], +m[2]);
  return out;
}

export function dateFound(text, isoDate) {
  return !!isoDate && datesIn(text).has(isoDate);
}

/** True when a distinctive word of the company's name appears on the bill. */
export function companyFound(text, name) {
  const hay = String(text || '').toLowerCase();
  const stop = new Set(['the', 'and', 'limited', 'ltd', 'company', 'corporation', 'distribution', 'electricity', 'power', 'postpaid', 'water', 'gas', 'services', 'mumbai', 'delhi']);
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
  return words.some((w) => hay.includes(w));
}

/** 64-bit difference hash of an image's 9×8 greyscale thumbnail, as 16 hex characters. */
export function dHashFromGrey(grey /* 72 values, row-major 9×8 */) {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += grey[y * 9 + x] < grey[y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
