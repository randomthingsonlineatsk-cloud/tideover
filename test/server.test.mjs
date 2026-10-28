// Offline tests for the TideOver server and rules. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, upkeep, resetSchemaFlag } from '../src/server.js';
import { minimumFor, validateRequest, checkNote, hamming, addDays } from '../src/logic.js';
import { encrypt, decrypt, sign, unsign } from '../src/crypto.js';
import { makeD1 } from './shim.mjs';

const BASE = 'https://tideover.test';
const today = new Date().toISOString().slice(0, 10);

function makeEnv() {
  resetSchemaFlag();
  const env = { DB: makeD1(), GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret-for-tests', ADMIN_LOGINS: 'khan-admin' };
  let next = { id: 1, login: 'x' };
  env.setGitHubUser = (u) => { next = u; };
  env.fetchImpl = async (url) => {
    if (String(url).includes('access_token')) return new Response(JSON.stringify({ access_token: 'tok' }));
    if (String(url).includes('api.github.com/user')) return new Response(JSON.stringify(next));
    if (String(url).includes('turnstile')) return new Response(JSON.stringify({ success: true }));
    throw new Error(`unexpected fetch ${url}`);
  };
  return env;
}

async function call(env, method, path, { cookie, body, raw, type, csrf = true } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf && method !== 'GET') headers['X-TideOver'] = '1';
  if (body) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = type || 'image/jpeg';
  const res = await handle(new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : raw }), env);
  const ct = res.headers.get('Content-Type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
}

async function signIn(env, id, login, accept = true) {
  env.setGitHubUser({ id, login });
  const start = await call(env, 'GET', '/auth/github?next=/%23post');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const oauth = start.headers.get('Set-Cookie').split(';')[0];
  const cb = await call(env, 'GET', `/auth/github/callback?code=abc&state=${state}`, { cookie: oauth });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('Location'), '/#post');
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('to_session=')).split(';')[0];
  if (accept) assert.equal((await call(env, 'POST', '/api/me/accept', { cookie, body: { adult: true, terms: true } })).status, 200);
  return cookie;
}

const goodBill = (over = {}) => ({
  companyId: 'in-msedcl', billType: 'electricity', amount: 3450, dueDate: addDays(today, 10), account: '1700 1234 5678',
  note: 'Lost my job in August, two children at home.', displayName: 'Asha', city: 'Pune', imageHash: 'a1b2c3d4e5f60718', readAmount: true, readCompany: true, readDue: false, ...over,
});

test('rules: minimum amounts per currency', () => {
  assert.equal(minimumFor('INR'), 2000);
  assert.equal(minimumFor('USD'), 23);
  assert.equal(minimumFor('GBP'), 18);
  assert.equal(minimumFor('JPY'), 3500);
  assert.equal(minimumFor('KRW'), 33000);
  assert.equal(minimumFor('XYZ'), null);
  assert.equal(minimumFor('USD', 50), 50);
});

test('rules: notes cannot carry links, contacts or payment handles', () => {
  assert.equal(checkNote('Behind on rent after surgery.'), null);
  assert.match(checkNote('pay me at asha@okicici'), /not allowed/);
  assert.match(checkNote('call 98765 43210'), /not allowed/);
  assert.match(checkNote('see www.example.com'), /Links/);
  assert.match(checkNote('x'.repeat(301)), /300/);
});

test('rules: each check names itself when it fails', () => {
  const company = { id: 'c', active: 1, third_party_ok: 1, bill_types: '["electricity"]', currency: 'INR' };
  const ok = validateRequest(goodBill(), company, today);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.account, '170012345678');
  const cases = [
    [{ amount: 1999 }, 'amount'], [{ dueDate: addDays(today, 61) }, 'due'], [{ dueDate: addDays(today, -91) }, 'due'], [{ account: '!!' }, 'account'],
    [{ note: 'gpay me' }, 'note'], [{ displayName: '' }, 'name'], [{ imageHash: '' }, 'bill'], [{ readAmount: false }, 'bill'], [{ billType: 'gas' }, 'company'],
  ];
  for (const [over, check] of cases) assert.equal(validateRequest(goodBill(over), company, today).check, check, JSON.stringify(over));
  assert.equal(validateRequest(goodBill(), { ...company, third_party_ok: 0 }, today).check, 'company');
  assert.equal(validateRequest(goodBill(), null, today).check, 'company');
});

test('crypto: signed sessions and encrypted account numbers', async () => {
  const s = await sign('k', 'abc|123');
  assert.equal(await unsign('k', s), 'abc|123');
  assert.equal(await unsign('other', s), null);
  assert.equal(await unsign('k', s.replace('abc', 'abd')), null);
  const e = await encrypt('k', '170012345678');
  assert.notEqual(e, '170012345678');
  assert.equal(await decrypt('k', e), '170012345678');
  assert.equal(hamming('ffffffffffffffff', 'fffffffffffffffe'), 1);
});

test('directory is seeded and public listing is safe', async () => {
  const env = makeEnv();
  const companies = await call(env, 'GET', '/api/companies?country=IN');
  assert.ok(companies.data.companies.length >= 10);
  assert.equal(companies.data.companies[0].currency, 'INR');
  assert.equal(companies.data.companies[0].minimum, 2000);
  const cfg = await call(env, 'GET', '/api/config');
  assert.equal(cfg.data.minInr, 2000);
  const me = await call(env, 'GET', '/api/me');
  assert.equal(me.data.signedIn, false);
});

test('writes need the site header, sign-in and accepted terms', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/requests', { body: goodBill(), csrf: false })).status, 403);
  assert.equal((await call(env, 'POST', '/api/requests', { body: goodBill() })).status, 401);
  const c = await signIn(env, 11, 'asha', false);
  const r = await call(env, 'POST', '/api/requests', { cookie: c, body: goodBill() });
  assert.equal(r.status, 403);
  assert.equal(r.data.check, 'terms');
});

test('full journey: post, claim, receipt, stamped bill, closed', async () => {
  const env = makeEnv();
  const asha = await signIn(env, 11, 'asha');
  const ravi = await signIn(env, 22, 'ravi');
  const meera = await signIn(env, 33, 'meera');

  const posted = await call(env, 'POST', '/api/requests', { cookie: asha, body: goodBill() });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const id = posted.data.id;

  assert.equal((await call(env, 'POST', '/api/requests', { cookie: asha, body: goodBill({ amount: 5000 }) })).data.check, 'one-open');
  assert.equal((await call(env, 'POST', '/api/requests', { cookie: meera, body: goodBill() })).data.check, 'duplicate');
  assert.equal((await call(env, 'POST', '/api/requests', { cookie: meera, body: goodBill({ amount: 9999, imageHash: 'a1b2c3d4e5f60719' }) })).data.check, 'duplicate', 'near-identical photo');

  const list = await call(env, 'GET', '/api/requests');
  assert.equal(list.data.requests.length, 1);
  assert.equal(list.data.requests[0].company.name.startsWith('Maharashtra'), true);
  assert.ok(!JSON.stringify(list.data).includes('170012345678'), 'account number never in the public list');
  const pub = await call(env, 'GET', `/api/requests/${id}`, { cookie: meera });
  assert.equal(pub.data.account, undefined);
  assert.match(pub.data.howToPay, /Pay bills/);

  assert.equal((await call(env, 'POST', `/api/requests/${id}/claim`, { cookie: asha, body: {} })).status, 400, 'no self-claims');
  const claim = await call(env, 'POST', `/api/requests/${id}/claim`, { cookie: ravi, body: { showName: true } });
  assert.equal(claim.status, 200);
  assert.equal((await call(env, 'POST', `/api/requests/${id}/claim`, { cookie: meera, body: {} })).status, 409, 'only one donor at a time');
  assert.equal((await call(env, 'GET', '/api/requests')).data.requests.length, 0, 'claimed bills leave the list');
  const forRavi = await call(env, 'GET', `/api/requests/${id}`, { cookie: ravi });
  assert.equal(forRavi.data.account, '170012345678');
  assert.equal((await call(env, 'GET', `/api/requests/${id}`, { cookie: meera })).data.account, undefined);

  assert.equal((await call(env, 'POST', `/api/requests/${id}/stamped`, { cookie: asha, raw: Buffer.from('x') })).status, 400, 'stamped bill only after a receipt');
  assert.equal((await call(env, 'POST', `/api/requests/${id}/receipt`, { cookie: ravi, raw: Buffer.from('fake'), type: 'text/html' })).status, 400, 'only images and PDFs');
  assert.equal((await call(env, 'POST', `/api/requests/${id}/receipt`, { cookie: ravi, raw: Buffer.from('receipt-bytes') })).status, 200);
  assert.equal((await call(env, 'GET', `/api/requests/${id}/proof/receipt`, { cookie: asha })).data, 'receipt-bytes');
  assert.equal((await call(env, 'GET', `/api/requests/${id}/proof/receipt`, { cookie: meera })).status, 403);
  const ashaView = await call(env, 'GET', `/api/requests/${id}`, { cookie: asha });
  assert.equal(ashaView.data.proofs.donorName, 'ravi');

  assert.equal((await call(env, 'POST', `/api/requests/${id}/stamped`, { cookie: asha, raw: Buffer.from('stamped-bytes'), type: 'image/png' })).status, 200);
  const row = env.DB.raw.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  assert.equal(row.status, 'paid');
  assert.equal(row.account_enc, null, 'account number removed on close');
  assert.ok(row.purge_after > today);
  const stats = await call(env, 'GET', '/api/stats');
  assert.equal(stats.data.closed[0].outcome, 'paid');

  const mine = await call(env, 'GET', '/api/mine', { cookie: ravi });
  assert.equal(mine.data.claims[0].stamped, true);

  // 31 days later the request and its proofs are gone.
  env.DB.raw.prepare('UPDATE requests SET purge_after = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
  const u = await upkeep(env);
  assert.equal(u.purged, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM proofs').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM stats').get().n, 1, 'anonymous counts stay');
});

test('claims lapse, receipts without stamped bills close, old requests expire', async () => {
  const env = makeEnv();
  const a = await signIn(env, 1, 'a');
  const b = await signIn(env, 2, 'b');
  const d = await signIn(env, 3, 'd');
  const id1 = (await call(env, 'POST', '/api/requests', { cookie: a, body: goodBill() })).data.id;
  await call(env, 'POST', `/api/requests/${id1}/claim`, { cookie: d, body: {} });
  env.DB.raw.prepare("UPDATE claims SET lock_until = '2000-01-01T00:00:00.000Z'").run();
  env.DB.raw.prepare("UPDATE requests SET lock_until = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await upkeep(env)).lapsed, 1);
  assert.equal((await call(env, 'GET', '/api/requests')).data.requests.length, 1, 'reopened');

  await call(env, 'POST', `/api/requests/${id1}/claim`, { cookie: d, body: {} });
  await call(env, 'POST', `/api/requests/${id1}/receipt`, { cookie: d, raw: Buffer.from('r') });
  env.DB.raw.prepare("UPDATE claims SET receipt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'receipt'").run();
  assert.equal((await upkeep(env)).unconfirmed, 1);
  assert.equal(env.DB.raw.prepare('SELECT status FROM requests WHERE id = ?').get(id1).status, 'paid_unconfirmed');

  const id2 = (await call(env, 'POST', '/api/requests', { cookie: b, body: goodBill({ account: '99887766', imageHash: '0000ffff0000ffff' }) })).data.id;
  env.DB.raw.prepare("UPDATE requests SET due_date = '2000-01-01' WHERE id = ?").run(id2);
  assert.equal((await upkeep(env)).expired, 1);
});

test('reports hide a request; admin restores or removes; repeat offenders are blocked', async () => {
  const env = makeEnv();
  const owner = await signIn(env, 1, 'owner');
  const admin = await signIn(env, 9, 'khan-admin');
  const reporters = [await signIn(env, 2, 'r2'), await signIn(env, 3, 'r3'), await signIn(env, 4, 'r4')];
  const id = (await call(env, 'POST', '/api/requests', { cookie: owner, body: goodBill() })).data.id;
  for (const r of reporters) assert.equal((await call(env, 'POST', `/api/requests/${id}/report`, { cookie: r, body: { reason: 'Looks fake' } })).status, 200);
  await call(env, 'POST', `/api/requests/${id}/report`, { cookie: reporters[0], body: { reason: 'again' } });
  assert.equal((await call(env, 'GET', '/api/requests')).data.requests.length, 0, 'hidden after 3 different reporters');
  assert.equal((await call(env, 'GET', `/api/requests/${id}`, { cookie: reporters[0] })).status, 404);
  assert.equal((await call(env, 'GET', '/api/admin/overview', { cookie: reporters[0] })).status, 403);
  const ov = await call(env, 'GET', '/api/admin/overview', { cookie: admin });
  assert.equal(ov.data.hidden[0].reports, 3);
  assert.equal((await call(env, 'GET', `/api/requests/${id}`, { cookie: admin })).data.account, '170012345678');
  await call(env, 'POST', `/api/admin/requests/${id}`, { cookie: admin, body: { action: 'restore' } });
  assert.equal((await call(env, 'GET', '/api/requests')).data.requests.length, 1);
  await call(env, 'POST', `/api/admin/requests/${id}`, { cookie: admin, body: { action: 'remove' } });
  const id2 = (await call(env, 'POST', '/api/requests', { cookie: owner, body: goodBill({ account: '5555', imageHash: '1111222233334444' }) })).data.id;
  await call(env, 'POST', `/api/admin/requests/${id2}`, { cookie: admin, body: { action: 'remove' } });
  assert.equal((await call(env, 'POST', '/api/requests', { cookie: owner, body: goodBill({ account: '7777', imageHash: '9999888877776666' }) })).status, 403, 'blocked after two removals');
});

test('admin adds a company from a suggestion; account deletion removes everything', async () => {
  const env = makeEnv();
  const user = await signIn(env, 5, 'sam');
  const admin = await signIn(env, 9, 'khan-admin');
  assert.equal((await call(env, 'POST', '/api/suggestions', { cookie: user, body: { country: 'GB', name: 'Thames Water', url: 'https://www.thameswater.co.uk' } })).status, 201);
  const sug = (await call(env, 'GET', '/api/admin/overview', { cookie: admin })).data.suggestions[0];
  assert.equal((await call(env, 'POST', '/api/admin/companies', { cookie: admin, body: { country: 'GB', name: 'Thames Water', currency: 'GBP', pay_url: 'http://insecure', billTypes: ['water'] } })).status, 400);
  const add = await call(env, 'POST', '/api/admin/companies', { cookie: admin, body: { country: 'GB', name: 'Thames Water', currency: 'GBP', pay_url: 'https://www.thameswater.co.uk/pay', howToPay: 'Use "Pay a bill" with the account number.', billTypes: ['water'], suggestion: sug.id } });
  assert.equal(add.data.id, 'gb-thames-water');
  const gb = (await call(env, 'GET', '/api/companies?country=GB')).data.companies[0];
  assert.equal(gb.minimum, 18);
  assert.equal((await call(env, 'GET', '/api/admin/overview', { cookie: admin })).data.suggestions.length, 0);

  const id = (await call(env, 'POST', '/api/requests', { cookie: user, body: goodBill({ companyId: 'gb-thames-water', billType: 'water', amount: 120 }) })).data.id;
  assert.ok(id);
  const del = await call(env, 'DELETE', '/api/me', { cookie: user });
  assert.equal(del.status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM people WHERE login = 'sam'").get().n, 0);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: user })).data.signedIn, false);
});

test('sign-in state is checked and sessions cannot be forged', async () => {
  const env = makeEnv();
  const bad = await call(env, 'GET', '/auth/github/callback?code=x&state=nope', { cookie: 'to_oauth=other|/' });
  assert.equal(bad.status, 400);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: 'to_session=abc|9999999999999.forged' })).data.signedIn, false);
});

test('any country: a request for an unlisted company waits for the admin, then goes live', async () => {
  const env = makeEnv();
  const nia = await signIn(env, 61, 'nia');
  const obi = await signIn(env, 62, 'obi');
  const admin = await signIn(env, 9, 'khan-admin');
  const donor = await signIn(env, 63, 'donor');
  const body = (over = {}) => goodBill({ companyId: 'new', billType: 'electricity', amount: 40000, newCompany: { name: 'Ikeja Electric', country: 'NG', currency: 'NGN', url: 'https://www.ikejaelectric.com' }, ...over });
  assert.equal((await call(env, 'POST', '/api/requests', { cookie: nia, body: body({ amount: 100 }) })).data.check, 'amount', 'minimum still applies (about ₹2,000)');
  assert.equal((await call(env, 'POST', '/api/requests', { cookie: nia, body: body({ newCompany: { name: 'X', country: 'NG', currency: 'NGN' } }) })).data.check, 'company');
  const a = await call(env, 'POST', '/api/requests', { cookie: nia, body: body() });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.pending, true);
  const b = await call(env, 'POST', '/api/requests', { cookie: obi, body: body({ account: '4455', imageHash: '1212121212121212', newCompany: { name: 'ikeja electric', country: 'NG', currency: 'NGN' } }) });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.equal((await call(env, 'GET', '/api/requests')).data.requests.length, 0, 'waiting requests are not public');
  assert.equal((await call(env, 'GET', `/api/requests/${a.data.id}`, { cookie: donor })).status, 404);
  const mine = await call(env, 'GET', `/api/requests/${a.data.id}`, { cookie: nia });
  assert.equal(mine.data.status, 'pending');
  assert.equal(mine.data.company.name, 'Ikeja Electric');
  const ov = (await call(env, 'GET', '/api/admin/overview', { cookie: admin })).data;
  assert.equal(ov.suggestions.length, 1, 'one suggestion shared by both requests');
  assert.equal(ov.suggestions[0].waiting, 2);
  assert.equal(ov.suggestions[0].currency, 'NGN');
  assert.equal(ov.pending.length, 2);
  const add = await call(env, 'POST', '/api/admin/companies', { cookie: admin, body: { country: 'NG', name: 'Ikeja Electric', currency: 'NGN', pay_url: 'https://www.ikejaelectric.com/pay', howToPay: 'Pay as a guest with the account number.', billTypes: ['electricity'], suggestion: ov.suggestions[0].id } });
  assert.equal(add.data.released, 2);
  const live = (await call(env, 'GET', '/api/requests?country=NG')).data.requests;
  assert.equal(live.length, 2);
  assert.equal(live[0].company.name, 'Ikeja Electric');
  assert.equal((await call(env, 'POST', `/api/requests/${a.data.id}/claim`, { cookie: donor, body: {} })).status, 200);

  // A company that can't be paid directly is dismissed, and the waiting request is closed.
  const c = await call(env, 'POST', '/api/requests', { cookie: donor, body: body({ account: '9090', imageHash: 'abababababababab', newCompany: { name: 'Cash Only Landlord Ltd', country: 'NG', currency: 'NGN' } }) });
  const sid = (await call(env, 'GET', '/api/admin/overview', { cookie: admin })).data.suggestions[0].id;
  const dis = await call(env, 'POST', `/api/admin/suggestions/${sid}`, { cookie: admin });
  assert.equal(dis.data.rejected, 1);
  assert.equal((await call(env, 'GET', `/api/requests/${c.data.id}`, { cookie: donor })).data.status, 'rejected');
  const cfg = await call(env, 'GET', '/api/config');
  assert.equal(cfg.data.inrPerUnit.NGN, 0.058);
});
