import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, amountFound, datesIn, dateFound, companyFound, dHashFromGrey, plainDigits } from '../public/billread.js';

const bill = `MAHARASHTRA STATE ELECTRICITY DISTRIBUTION CO. LTD
Consumer No: 170012345678  Bill Date: 05/10/2026
Due Date: 20-10-2026   Net Bill Amount Rs. 3,450.00
If paid after due date: 3,520.00   Last receipt 1,23,456 units`;

test('amounts in several number formats', () => {
  const a = amountsIn(bill);
  assert.ok(a.has(3450));
  assert.ok(a.has(3520));
  assert.ok(a.has(123456));
  assert.ok(amountFound('Total due EUR 1.234,56', 1234.56));
  assert.ok(amountFound('Amount: 34 500', 34500));
  assert.ok(amountFound('Rs. ३,४५०', 3450));
  assert.ok(!amountFound(bill, 3451));
});

test('dates day-first, month-first and with month names', () => {
  assert.ok(dateFound(bill, '2026-10-20'));
  assert.ok(datesIn(bill).has('2026-10-05'));
  assert.ok(dateFound('Pay by Oct 22, 2026', '2026-10-22'));
  assert.ok(dateFound('Due 22-Oct-26', '2026-10-22'));
  assert.ok(dateFound('Due 2026.10.22', '2026-10-22'));
  assert.ok(!dateFound(bill, '2026-10-21'));
});

test('company names and image fingerprints', () => {
  assert.ok(companyFound(bill, 'Maharashtra State Electricity Distribution (MSEDCL, Mahavitaran)'));
  assert.ok(!companyFound(bill, 'Adani Electricity Mumbai'));
  const grey = Array.from({ length: 72 }, (_, i) => i % 9);
  assert.equal(dHashFromGrey(grey), 'ffffffffffffffff');
  assert.equal(plainDigits('٢٠٢٦'), '2026');
});
