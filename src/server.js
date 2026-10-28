/*!
 * TideOver server: a Cloudflare Worker with a D1 database and a private R2 bucket for payment proofs.
 * Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the Apache License 2.0.
 *
 * The app never receives or moves money. It lists bills, shows a donor how to pay the bill company
 * directly, and keeps the proof that the bill was paid.
 */
import {
  validateRequest, minimumFor, addDays, hamming, amountBand, BILL_TYPES, INR_PER_UNIT, MIN_INR,
  LOCK_HOURS, STAMP_DAYS, PURGE_DAYS, REPORTS_TO_HIDE, REMOVALS_TO_BLOCK, MAX_ACTIVE_CLAIMS, MAX_UPLOAD_BYTES, OVERDUE_DAYS,
} from './logic.js';
import { randomId, sha256Hex, sign, unsign, encrypt, decrypt } from './crypto.js';
import { SEED_COMPANIES } from './seed.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, gh_id INTEGER UNIQUE, login TEXT, created TEXT, accepted TEXT, blocked INTEGER DEFAULT 0, removed_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, country TEXT, name TEXT, bill_types TEXT, currency TEXT, pay_url TEXT, how_to_pay TEXT, route TEXT, third_party_ok INTEGER, checked_by TEXT, checked_on TEXT, active INTEGER, min_amount REAL);
CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, country TEXT, name TEXT, url TEXT, note TEXT, person TEXT, created TEXT, status TEXT DEFAULT 'new');
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, person TEXT, company TEXT, country TEXT, bill_type TEXT, amount REAL, currency TEXT, due_date TEXT, account_enc TEXT, dup_hash TEXT, img_hash TEXT, note TEXT, display_name TEXT, city TEXT, read_company INTEGER, read_due INTEGER, status TEXT, hidden INTEGER DEFAULT 0, lock_until TEXT, created TEXT, closed TEXT, purge_after TEXT);
CREATE INDEX IF NOT EXISTS req_status ON requests(status, hidden);
CREATE INDEX IF NOT EXISTS req_person ON requests(person);
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, request TEXT, donor TEXT, claimed_at TEXT, lock_until TEXT, receipt_key TEXT, receipt_at TEXT, stamped_key TEXT, stamped_at TEXT, status TEXT, show_name INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS claim_req ON claims(request);
CREATE INDEX IF NOT EXISTS claim_donor ON claims(donor, status);
CREATE TABLE IF NOT EXISTS reports (request TEXT, reporter TEXT, reason TEXT, created TEXT, PRIMARY KEY (request, reporter));
CREATE TABLE IF NOT EXISTS proofs (key TEXT PRIMARY KEY, type TEXT, data BLOB, created TEXT);
CREATE TABLE IF NOT EXISTS stats (month TEXT, country TEXT, bill_type TEXT, band TEXT, outcome TEXT, count INTEGER, PRIMARY KEY (month, country, bill_type, band, outcome));
`;

const OPEN_STATES = ['open', 'claimed', 'receipt'];
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const plusHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

// ------------------------------------------------------------------ helpers

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
const err = (status, message, extra = {}) => json({ error: message, ...extra }, status);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function secrets(env) {
  // Every secret is derived from the GitHub OAuth client secret unless a separate one is set.
  const base = env.APP_SECRET || env.GITHUB_CLIENT_SECRET;
  if (!base) throw new Error('GITHUB_CLIENT_SECRET is not set.');
  return base;
}

/**
 * Payment proofs are kept in the database itself (D1 allows values up to 2 MB), so no separate storage
 * service or payment card is needed. The interface matches a bucket: put, get, delete.
 */
export function proofStore(env) {
  if (env.PROOFS) return env.PROOFS; // tests may pass their own store
  return {
    put: (key, buf, opts) => env.DB.prepare('INSERT OR REPLACE INTO proofs (key, type, data, created) VALUES (?,?,?,?)').bind(key, opts?.httpMetadata?.contentType || 'application/octet-stream', buf, nowIso()).run(),
    get: async (key) => {
      const row = await env.DB.prepare('SELECT type, data FROM proofs WHERE key = ?').bind(key).first();
      return row ? { body: row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data), httpMetadata: { contentType: row.type } } : null;
    },
    delete: (key) => env.DB.prepare('DELETE FROM proofs WHERE key = ?').bind(key).run(),
  };
}

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  // Columns added after the first release (ALTER fails harmlessly when the column already exists).
  for (const sql of ['ALTER TABLE requests ADD COLUMN pending_name TEXT', 'ALTER TABLE requests ADD COLUMN pending_url TEXT', 'ALTER TABLE suggestions ADD COLUMN currency TEXT']) {
    try { await env.DB.prepare(sql).run(); } catch { /* already there */ }
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM companies').first();
  if (!n || !n.n) {
    await env.DB.batch(SEED_COMPANIES.map((c) => env.DB.prepare(
      'INSERT INTO companies (id, country, name, bill_types, currency, pay_url, how_to_pay, route, third_party_ok, checked_by, checked_on, active, min_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(c.id, c.country, c.name, c.bill_types, c.currency, c.pay_url, c.how_to_pay, c.route, c.third_party_ok, c.checked_by, c.checked_on, c.active, c.min_amount)));
  }
  schemaReady = true;
}
export function resetSchemaFlag() { schemaReady = false; }

async function currentUser(req, env) {
  if (!env.APP_SECRET && !env.GITHUB_CLIENT_SECRET) return null;
  const raw = await unsign(secrets(env), cookies(req).to_session);
  if (!raw) return null;
  const [id, exp] = raw.split('|');
  if (!id || Number(exp) < Date.now()) return null;
  const p = await env.DB.prepare('SELECT * FROM people WHERE id = ?').bind(id).first();
  if (!p) return null;
  const admins = String(env.ADMIN_LOGINS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return { ...p, admin: admins.includes(String(p.login).toLowerCase()) };
}

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not configured yet
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const r = await (env.fetchImpl || fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

function publicRequest(r, company) {
  return {
    id: r.id, country: r.country, billType: r.bill_type, amount: r.amount, currency: r.currency, dueDate: r.due_date,
    displayName: r.display_name, city: r.city, note: r.note, created: r.created, status: r.status,
    available: r.status === 'open' && !r.hidden && (!r.lock_until || r.lock_until < nowIso()),
    readCompany: !!r.read_company, readDue: !!r.read_due,
    company: company ? { id: company.id, name: company.name, route: company.route } : null,
  };
}

async function companyById(env, id) {
  return env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
}

async function readUpload(req) {
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(type)) return { error: 'Upload a photo (JPEG, PNG, WebP) or a PDF.' };
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return { error: 'The file is empty.' };
  if (buf.byteLength > MAX_UPLOAD_BYTES) return { error: 'The file is larger than 1.9 MB. Take a smaller photo, or a screenshot instead of a PDF.' };
  return { type, buf };
}

async function closeRequest(env, r, outcome, status) {
  const when = nowIso();
  await env.DB.prepare('UPDATE requests SET status = ?, closed = ?, account_enc = NULL, purge_after = ?, lock_until = NULL WHERE id = ?')
    .bind(status, when, addDays(when, PURGE_DAYS), r.id).run();
  await env.DB.prepare(`INSERT INTO stats (month, country, bill_type, band, outcome, count) VALUES (?,?,?,?,?,1)
    ON CONFLICT (month, country, bill_type, band, outcome) DO UPDATE SET count = count + 1`)
    .bind(when.slice(0, 7), r.country, r.bill_type, amountBand(r.amount, r.currency), outcome).run();
}

// ------------------------------------------------------------------ handlers

async function handleAuthStart(req, env, url) {
  if (!env.GITHUB_CLIENT_ID) return new Response('GitHub sign-in is not set up yet (GITHUB_CLIENT_ID is missing).', { status: 503 });
  const state = randomId(16);
  const next = (url.searchParams.get('next') || '/').startsWith('/') ? url.searchParams.get('next') || '/' : '/';
  const redirect = `${url.origin}/auth/github/callback`;
  const to = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&scope=read:user&state=${state}&allow_signup=true`;
  return new Response(null, { status: 302, headers: { Location: to, 'Set-Cookie': setCookie('to_oauth', `${state}|${next}`, 600) } });
}

async function handleAuthCallback(req, env, url) {
  const [state, next] = String(cookies(req).to_oauth || '').split('|');
  if (!state || state !== url.searchParams.get('state')) return new Response('Sign-in expired. Please try again.', { status: 400 });
  const f = env.fetchImpl || fetch;
  const tok = await f('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/github/callback` }),
  }).then((r) => r.json());
  if (!tok.access_token) return new Response('GitHub did not confirm the sign-in. Please try again.', { status: 400 });
  const gh = await f('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'TideOver', Accept: 'application/vnd.github+json' } }).then((r) => r.json());
  if (!gh.id) return new Response('Could not read your GitHub account.', { status: 400 });
  let p = await env.DB.prepare('SELECT * FROM people WHERE gh_id = ?').bind(gh.id).first();
  if (!p) {
    p = { id: randomId(), gh_id: gh.id, login: gh.login, created: nowIso() };
    await env.DB.prepare('INSERT INTO people (id, gh_id, login, created) VALUES (?,?,?,?)').bind(p.id, p.gh_id, p.login, p.created).run();
  } else if (p.login !== gh.login) {
    await env.DB.prepare('UPDATE people SET login = ? WHERE id = ?').bind(gh.login, p.id).run();
  }
  const session = await sign(secrets(env), `${p.id}|${Date.now() + 30 * 864e5}`);
  const headers = new Headers({ Location: next && next.startsWith('/') ? next : '/' });
  headers.append('Set-Cookie', setCookie('to_session', session, 30 * 86400));
  headers.append('Set-Cookie', setCookie('to_oauth', '', 0));
  return new Response(null, { status: 302, headers });
}

async function listOpen(env, url) {
  const where = ["r.status = 'open'", 'r.hidden = 0', "(r.lock_until IS NULL OR r.lock_until < ?)"];
  const args = [nowIso()];
  const country = url.searchParams.get('country');
  const type = url.searchParams.get('type');
  if (country) { where.push('r.country = ?'); args.push(country); }
  if (type) { where.push('r.bill_type = ?'); args.push(type); }
  const order = url.searchParams.get('sort') === 'newest' ? 'r.created DESC' : url.searchParams.get('sort') === 'smallest' ? 'r.amount ASC' : 'r.due_date ASC';
  const rows = (await env.DB.prepare(`SELECT r.*, c.name AS c_name, c.route AS c_route FROM requests r JOIN companies c ON c.id = r.company WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`).bind(...args).all()).results;
  const countries = (await env.DB.prepare(`SELECT country, COUNT(*) AS n FROM requests WHERE status = 'open' AND hidden = 0 GROUP BY country`).all()).results;
  return json({ requests: rows.map((r) => publicRequest(r, { id: r.company, name: r.c_name, route: r.c_route })), countries });
}

async function getRequest(env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r || r.status === 'deleted' || r.status === 'removed') return err(404, 'This request is not available.');
  const isOwner = user && user.id === r.person;
  if (r.hidden && !isOwner && !user?.admin) return err(404, 'This request is under review.');
  if ((r.status === 'pending' || r.status === 'rejected') && !isOwner && !user?.admin) return err(404, 'This request is waiting for its bill company to be checked.');
  const company = r.status === 'pending' || r.status === 'rejected' ? { id: null, name: r.pending_name, route: 'Waiting to be checked', how_to_pay: '', pay_url: r.pending_url } : await companyById(env, r.company);
  const out = publicRequest(r, company);
  out.howToPay = company?.how_to_pay || '';
  out.payUrl = company?.pay_url || null;
  out.minimum = minimumFor(r.currency, company?.min_amount);
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE request = ? AND status IN ('active','receipt','done') ORDER BY claimed_at DESC LIMIT 1").bind(id).first();
  const isClaimer = user && claim && claim.donor === user.id;
  out.mine = !!isOwner;
  out.myClaim = isClaimer ? { status: claim.status, lockUntil: claim.lock_until, receipt: !!claim.receipt_key, stamped: !!claim.stamped_key } : null;
  if ((isClaimer && claim.status === 'active') || user?.admin) out.account = await decrypt(secrets(env), r.account_enc);
  if (isOwner || isClaimer || user?.admin) {
    out.proofs = claim ? { receipt: !!claim.receipt_key, stamped: !!claim.stamped_key, receiptAt: claim.receipt_at, stampedAt: claim.stamped_at, donorName: claim.show_name ? (await env.DB.prepare('SELECT login FROM people WHERE id = ?').bind(claim.donor).first())?.login : null } : null;
  }
  if (user?.admin) out.reports = (await env.DB.prepare('SELECT reason, created FROM reports WHERE request = ?').bind(id).all()).results;
  return json(out);
}

async function createRequest(req, env, user) {
  const body = await req.json().catch(() => ({}));
  if (!(await turnstileOk(env, body.turnstile, req.headers.get('CF-Connecting-IP')))) return err(400, 'The bot check failed. Please try again.', { check: 'bot' });
  const open = await env.DB.prepare(`SELECT id FROM requests WHERE person = ? AND status IN ('open','claimed','receipt','pending')`).bind(user.id).first();
  if (open) return err(400, 'You already have an open request. One request at a time keeps things fair.', { check: 'one-open' });
  let company;
  let pending = null;
  if (body.companyId === 'new') {
    // A company that is not in the directory yet: the request waits until the admin checks and adds it.
    const nc = body.newCompany || {};
    const name = String(nc.name || '').trim().slice(0, 120);
    const country = String(nc.country || '').toUpperCase();
    const url = String(nc.url || '').trim().slice(0, 300);
    if (!/^[A-Z]{2}$/.test(country)) return err(400, 'Choose your country.', { check: 'company' });
    if (name.length < 2) return err(400, 'Type the name of the bill company exactly as it appears on the bill.', { check: 'company' });
    if (url && !/^https?:\/\//i.test(url)) return err(400, "The company's website should start with https://", { check: 'company' });
    if (!INR_PER_UNIT[nc.currency]) return err(400, 'Choose the currency of the bill.', { check: 'amount' });
    company = { id: null, country, active: 1, third_party_ok: 1, bill_types: JSON.stringify(Object.keys(BILL_TYPES)), currency: nc.currency, min_amount: null };
    pending = { name, url, country, currency: nc.currency };
  } else {
    company = await companyById(env, body.companyId);
  }
  const v = validateRequest(body, company, today());
  if (!v.ok) return err(400, v.message, { check: v.check });
  const val = v.value;
  const dup = await sha256Hex(`${company.id || `${pending.country}:${pending.name.toLowerCase()}`}|${val.account}|${val.amount.toFixed(2)}`);
  if (await env.DB.prepare(`SELECT id FROM requests WHERE dup_hash = ? AND status != 'deleted'`).bind(dup).first()) return err(400, 'This bill has already been posted.', { check: 'duplicate' });
  const recent = (await env.DB.prepare(`SELECT img_hash FROM requests WHERE img_hash IS NOT NULL AND created > ?`).bind(addDays(today(), -365)).all()).results;
  if (recent.some((x) => hamming(x.img_hash, val.imageHash) <= 4)) return err(400, 'This bill photo has already been used for a request.', { check: 'duplicate' });
  const id = randomId(8);
  let companyRef = company.id;
  if (pending) {
    // Reuse an open suggestion for the same company so the admin checks it once.
    const same = await env.DB.prepare("SELECT id FROM suggestions WHERE status = 'new' AND country = ? AND lower(name) = lower(?)").bind(pending.country, pending.name).first();
    const sid = same?.id || randomId(8);
    if (!same) {
      await env.DB.prepare('INSERT INTO suggestions (id, country, name, url, note, person, created, currency) VALUES (?,?,?,?,?,?,?,?)')
        .bind(sid, pending.country, pending.name, pending.url, 'From a request waiting for this company', user.id, nowIso(), pending.currency).run();
    }
    companyRef = `pending:${sid}`;
  }
  await env.DB.prepare(`INSERT INTO requests (id, person, company, country, bill_type, amount, currency, due_date, account_enc, dup_hash, img_hash, note, display_name, city, read_company, read_due, status, created, pending_name, pending_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, user.id, companyRef, company.country, val.billType, val.amount, val.currency, val.dueDate, await encrypt(secrets(env), val.account), dup, val.imageHash,
    val.note, val.displayName, val.city, val.readCompany ? 1 : 0, val.readDue ? 1 : 0, pending ? 'pending' : 'open', nowIso(), pending?.name || null, pending?.url || null,
  ).run();
  return json({ id, pending: !!pending }, 201);
}

async function claimRequest(req, env, user, id) {
  const body = await req.json().catch(() => ({}));
  if (!(await turnstileOk(env, body.turnstile, req.headers.get('CF-Connecting-IP')))) return err(400, 'The bot check failed. Please try again.');
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r) return err(404, 'This request is not available.');
  if (r.person === user.id) return err(400, "You can't pay your own request through TideOver.");
  if (r.status !== 'open' || r.hidden || (r.lock_until && r.lock_until > nowIso())) return err(409, 'Someone else is paying this bill right now. Please choose another.');
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE donor = ? AND status = 'active'").bind(user.id).first();
  if (active.n >= MAX_ACTIVE_CLAIMS) return err(400, `You can hold at most ${MAX_ACTIVE_CLAIMS} bills at a time. Finish or release one first.`);
  const lock = plusHours(LOCK_HOURS);
  // Guarded update: only one donor can move the request from open to claimed.
  const res = await env.DB.prepare(`UPDATE requests SET status = 'claimed', lock_until = ? WHERE id = ? AND status = 'open' AND (lock_until IS NULL OR lock_until < ?)`).bind(lock, id, nowIso()).run();
  if (!res.meta || res.meta.changes !== 1) return err(409, 'Someone else is paying this bill right now. Please choose another.');
  await env.DB.prepare(`INSERT INTO claims (id, request, donor, claimed_at, lock_until, status, show_name) VALUES (?,?,?,?,?,'active',?)`)
    .bind(randomId(8), id, user.id, nowIso(), lock, body.showName ? 1 : 0).run();
  return json({ ok: true, lockUntil: lock });
}

async function releaseClaim(env, user, id) {
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE request = ? AND donor = ? AND status = 'active'").bind(id, user.id).first();
  if (!claim) return err(404, 'You are not paying this bill.');
  await env.DB.batch([
    env.DB.prepare("UPDATE claims SET status = 'released' WHERE id = ?").bind(claim.id),
    env.DB.prepare("UPDATE requests SET status = 'open', lock_until = NULL WHERE id = ? AND status = 'claimed'").bind(id),
  ]);
  return json({ ok: true });
}

async function uploadReceipt(req, env, user, id) {
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE request = ? AND donor = ? AND status = 'active'").bind(id, user.id).first();
  if (!claim) return err(400, 'Only the donor paying this bill can add the receipt, while the claim is active.');
  const up = await readUpload(req);
  if (up.error) return err(400, up.error);
  const key = `proofs/${id}/receipt-${randomId(6)}`;
  await proofStore(env).put(key, up.buf, { httpMetadata: { contentType: up.type } });
  await env.DB.batch([
    env.DB.prepare("UPDATE claims SET status = 'receipt', receipt_key = ?, receipt_at = ? WHERE id = ?").bind(key, nowIso(), claim.id),
    env.DB.prepare("UPDATE requests SET status = 'receipt', lock_until = NULL WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function uploadStamped(req, env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r || r.person !== user.id) return err(404, 'This is not your request.');
  if (r.status !== 'receipt') return err(400, 'The stamped or paid bill can be added once a donor has uploaded the payment receipt.');
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE request = ? AND status = 'receipt'").bind(id).first();
  const up = await readUpload(req);
  if (up.error) return err(400, up.error);
  const key = `proofs/${id}/stamped-${randomId(6)}`;
  await proofStore(env).put(key, up.buf, { httpMetadata: { contentType: up.type } });
  await env.DB.prepare("UPDATE claims SET status = 'done', stamped_key = ?, stamped_at = ? WHERE id = ?").bind(key, nowIso(), claim.id).run();
  await closeRequest(env, r, 'paid', 'paid');
  return json({ ok: true });
}

async function getProof(env, user, id, kind) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  const claim = r && await env.DB.prepare("SELECT * FROM claims WHERE request = ? AND status IN ('receipt','done') ORDER BY claimed_at DESC LIMIT 1").bind(id).first();
  if (!r || !claim) return err(404, 'No proof yet.');
  if (!(user.admin || user.id === r.person || user.id === claim.donor)) return err(403, 'Only the person asking, the donor and the admin can see proofs.');
  const key = kind === 'receipt' ? claim.receipt_key : claim.stamped_key;
  const obj = key && await proofStore(env).get(key);
  if (!obj) return err(404, 'No proof yet.');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' } });
}

async function reportRequest(req, env, user, id) {
  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason || '').slice(0, 300);
  if (!reason) return err(400, 'Say briefly what is wrong.');
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r) return err(404, 'Not found.');
  if (r.person === user.id) return err(400, "You can't report your own request.");
  await env.DB.prepare('INSERT OR IGNORE INTO reports (request, reporter, reason, created) VALUES (?,?,?,?)').bind(id, user.id, reason, nowIso()).run();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE request = ?').bind(id).first();
  if (n.n >= REPORTS_TO_HIDE) await env.DB.prepare('UPDATE requests SET hidden = 1 WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function deleteMine(env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r || r.person !== user.id) return err(404, 'This is not your request.');
  if (r.status === 'claimed' || r.status === 'receipt') return err(400, 'A donor is paying or has paid this bill. Add the stamped bill, or wait for the claim to end.');
  await purgeRequest(env, r);
  return json({ ok: true });
}

async function purgeRequest(env, r) {
  const claims = (await env.DB.prepare('SELECT * FROM claims WHERE request = ?').bind(r.id).all()).results;
  for (const c of claims) for (const k of [c.receipt_key, c.stamped_key]) if (k) await proofStore(env).delete(k);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM claims WHERE request = ?').bind(r.id),
    env.DB.prepare('DELETE FROM reports WHERE request = ?').bind(r.id),
    env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(r.id),
  ]);
}

async function deleteAccount(env, user) {
  const mine = (await env.DB.prepare('SELECT * FROM requests WHERE person = ?').bind(user.id).all()).results;
  for (const r of mine) await purgeRequest(env, r);
  // Donations stay attached to the request they paid, without the donor's identity.
  await env.DB.prepare("UPDATE claims SET donor = 'deleted', show_name = 0 WHERE donor = ?").bind(user.id).run();
  await env.DB.prepare("UPDATE claims SET status = 'released' WHERE donor = 'deleted' AND status = 'active'").run();
  await env.DB.prepare("UPDATE requests SET status = 'open', lock_until = NULL WHERE status = 'claimed' AND id NOT IN (SELECT request FROM claims WHERE status = 'active')").run();
  await env.DB.prepare('DELETE FROM reports WHERE reporter = ?').bind(user.id).run();
  await env.DB.prepare('DELETE FROM suggestions WHERE person = ?').bind(user.id).run();
  await env.DB.prepare('DELETE FROM people WHERE id = ?').bind(user.id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie('to_session', '', 0) });
}

async function mine(env, user) {
  const reqs = (await env.DB.prepare('SELECT r.*, c.name AS c_name, c.route AS c_route FROM requests r LEFT JOIN companies c ON c.id = r.company WHERE r.person = ? ORDER BY r.created DESC').bind(user.id).all()).results;
  const claims = (await env.DB.prepare("SELECT cl.*, r.amount, r.currency, r.bill_type, r.status AS r_status, c.name AS c_name FROM claims cl JOIN requests r ON r.id = cl.request LEFT JOIN companies c ON c.id = r.company WHERE cl.donor = ? AND cl.status != 'released' ORDER BY cl.claimed_at DESC").bind(user.id).all()).results;
  return json({
    requests: reqs.map((r) => ({ ...publicRequest(r, { id: r.company, name: r.c_name || r.pending_name, route: r.c_route || 'Waiting to be checked' }), hidden: !!r.hidden })),
    claims: claims.map((c) => ({ request: c.request, status: c.status, lockUntil: c.lock_until, receipt: !!c.receipt_key, stamped: !!c.stamped_key, amount: c.amount, currency: c.currency, billType: c.bill_type, company: c.c_name, requestStatus: c.r_status })),
  });
}

async function adminOverview(env) {
  const hidden = (await env.DB.prepare("SELECT r.id, r.country, r.amount, r.currency, r.bill_type, r.display_name, r.note, r.created, c.name AS company, (SELECT COUNT(*) FROM reports WHERE request = r.id) AS reports FROM requests r LEFT JOIN companies c ON c.id = r.company WHERE r.hidden = 1 AND r.status NOT IN ('removed','deleted')").all()).results;
  const reported = (await env.DB.prepare("SELECT request, COUNT(*) AS n FROM reports GROUP BY request HAVING n > 0").all()).results;
  const suggestions = (await env.DB.prepare("SELECT s.*, (SELECT COUNT(*) FROM requests r WHERE r.company = 'pending:' || s.id AND r.status = 'pending') AS waiting FROM suggestions s WHERE s.status = 'new' ORDER BY waiting DESC, created").all()).results;
  const counts = (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all()).results;
  const pending = (await env.DB.prepare("SELECT id, country, amount, currency, bill_type, pending_name, pending_url, company, created FROM requests WHERE status = 'pending' ORDER BY created").all()).results;
  return json({ hidden, reported, suggestions, counts, pending });
}

async function adminAction(req, env, id) {
  const { action } = await req.json().catch(() => ({}));
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r) return err(404, 'Not found.');
  if (action === 'restore') {
    await env.DB.batch([env.DB.prepare('UPDATE requests SET hidden = 0 WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM reports WHERE request = ?').bind(id)]);
  } else if (action === 'remove') {
    await closeRequest(env, r, 'removed', 'removed');
    const p = await env.DB.prepare('UPDATE people SET removed_count = removed_count + 1 WHERE id = ? RETURNING removed_count').bind(r.person).first();
    if (p && p.removed_count >= REMOVALS_TO_BLOCK) await env.DB.prepare('UPDATE people SET blocked = 1 WHERE id = ?').bind(r.person).run();
  } else return err(400, 'Unknown action.');
  return json({ ok: true });
}

async function adminCompany(req, env, user) {
  const c = await req.json().catch(() => ({}));
  if (!/^[A-Z]{2}$/.test(c.country || '')) return err(400, 'Country must be a two-letter code, for example IN or GB.');
  if (!c.name || !c.currency || !INR_PER_UNIT[c.currency] && !c.min_amount) return err(400, 'Name and a known currency (or a minimum amount) are needed.');
  if (c.pay_url && !/^https:\/\//.test(c.pay_url)) return err(400, 'The payment page must start with https://');
  const types = (c.billTypes || []).filter((t) => BILL_TYPES[t]);
  if (!types.length) return err(400, 'Choose at least one bill type.');
  const id = c.id || `${c.country.toLowerCase()}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
  await env.DB.prepare(`INSERT INTO companies (id, country, name, bill_types, currency, pay_url, how_to_pay, route, third_party_ok, checked_by, checked_on, active, min_amount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET country=excluded.country, name=excluded.name, bill_types=excluded.bill_types, currency=excluded.currency,
    pay_url=excluded.pay_url, how_to_pay=excluded.how_to_pay, route=excluded.route, third_party_ok=excluded.third_party_ok, checked_by=excluded.checked_by, checked_on=excluded.checked_on, active=excluded.active, min_amount=excluded.min_amount`)
    .bind(id, c.country, c.name.slice(0, 120), JSON.stringify(types), c.currency, c.pay_url || null, String(c.howToPay || '').slice(0, 800), c.route || 'Official website',
      c.thirdPartyOk === false ? 0 : 1, user.login, today(), c.active === false ? 0 : 1, c.min_amount ? Number(c.min_amount) : null).run();
  let released = 0;
  if (c.suggestion) {
    await env.DB.prepare("UPDATE suggestions SET status = 'added' WHERE id = ?").bind(c.suggestion).run();
    // Requests that were waiting for this company go live now, if their currency matches the company's.
    const res = await env.DB.prepare("UPDATE requests SET company = ?, status = 'open' WHERE company = ? AND status = 'pending' AND currency = ?").bind(id, `pending:${c.suggestion}`, c.currency).run();
    released = res.meta?.changes || 0;
    await env.DB.prepare("UPDATE requests SET company = ? WHERE company = ? AND status = 'pending'").bind(id, `pending:${c.suggestion}`).run();
  }
  return json({ ok: true, id, released });
}

// ------------------------------------------------------------------ daily upkeep

export async function upkeep(env) {
  await ensureSchema(env);
  const now = nowIso();
  // Claims whose 2-hour window passed without a receipt lapse, and the request reopens.
  const lapsed = (await env.DB.prepare("SELECT * FROM claims WHERE status = 'active' AND lock_until < ?").bind(now).all()).results;
  for (const c of lapsed) {
    await env.DB.batch([
      env.DB.prepare("UPDATE claims SET status = 'lapsed' WHERE id = ?").bind(c.id),
      env.DB.prepare("UPDATE requests SET status = 'open', lock_until = NULL WHERE id = ? AND status = 'claimed'").bind(c.request),
    ]);
  }
  // Receipt uploaded but no stamped bill within 14 days: close as paid, not confirmed.
  const waiting = (await env.DB.prepare("SELECT r.* FROM requests r JOIN claims c ON c.request = r.id AND c.status = 'receipt' WHERE r.status = 'receipt' AND c.receipt_at < ?").bind(new Date(Date.now() - STAMP_DAYS * 864e5).toISOString()).all()).results;
  for (const r of waiting) await closeRequest(env, r, 'paid-unconfirmed', 'paid_unconfirmed');
  // Open requests far past their due date expire.
  const old = (await env.DB.prepare("SELECT * FROM requests WHERE status IN ('open','pending') AND due_date < ?").bind(addDays(today(), -OVERDUE_DAYS)).all()).results;
  for (const r of old) await closeRequest(env, r, 'expired', 'expired');
  // Closed requests are deleted 30 days after closing, proofs included.
  const due = (await env.DB.prepare("SELECT * FROM requests WHERE purge_after IS NOT NULL AND purge_after < ?").bind(now).all()).results;
  for (const r of due) await purgeRequest(env, r);
  return { lapsed: lapsed.length, unconfirmed: waiting.length, expired: old.length, purged: due.length };
}

// ------------------------------------------------------------------ router

export async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    await ensureSchema(env);
    if (p === '/auth/github') return handleAuthStart(req, env, url);
    if (p === '/auth/github/callback') return handleAuthCallback(req, env, url);
    if (p === '/auth/logout') return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': setCookie('to_session', '', 0) } });
    if (!p.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

    // Writes must come from the site itself (a custom header cannot be sent cross-site without permission).
    if (req.method !== 'GET' && req.headers.get('X-TideOver') !== '1') return err(403, 'Request refused.');
    const user = await currentUser(req, env);
    const need = (opts = {}) => {
      if (!user) return err(401, 'Please sign in first.');
      if (user.blocked) return err(403, 'This account can no longer post or claim requests.');
      if (opts.accepted && !user.accepted) return err(403, 'Please confirm you are 18 or over and accept the terms first.', { check: 'terms' });
      if (opts.admin && !user.admin) return err(403, 'Admins only.');
      return null;
    };
    let m;

    if (p === '/api/config' && req.method === 'GET') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITEKEY || '', signIn: !!env.GITHUB_CLIENT_ID, billTypes: BILL_TYPES, minInr: MIN_INR, inrPerUnit: INR_PER_UNIT, lockHours: LOCK_HOURS, stampDays: STAMP_DAYS });
    }
    if (p === '/api/me' && req.method === 'GET') return json(user ? { signedIn: true, login: user.login, accepted: !!user.accepted, admin: user.admin, blocked: !!user.blocked } : { signedIn: false });
    if (p === '/api/me/accept' && req.method === 'POST') {
      const g = need(); if (g) return g;
      const b = await req.json().catch(() => ({}));
      if (!b.adult || !b.terms) return err(400, 'Both boxes need to be ticked.');
      await env.DB.prepare('UPDATE people SET accepted = ? WHERE id = ?').bind(nowIso(), user.id).run();
      return json({ ok: true });
    }
    if (p === '/api/me' && req.method === 'DELETE') { const g = need(); if (g) return g; return deleteAccount(env, user); }
    if (p === '/api/mine' && req.method === 'GET') { const g = need(); if (g) return g; return mine(env, user); }

    if (p === '/api/companies' && req.method === 'GET') {
      const country = url.searchParams.get('country');
      const rows = (await env.DB.prepare(`SELECT * FROM companies WHERE active = 1 ${country ? 'AND country = ?' : ''} ORDER BY country, name`).bind(...(country ? [country] : [])).all()).results;
      return json({ companies: rows.map((c) => ({ id: c.id, country: c.country, name: c.name, billTypes: JSON.parse(c.bill_types), currency: c.currency, payUrl: c.pay_url, howToPay: c.how_to_pay, route: c.route, checkedOn: c.checked_on, minimum: minimumFor(c.currency, c.min_amount) })) });
    }
    if (p === '/api/suggestions' && req.method === 'POST') {
      const g = need(); if (g) return g;
      const b = await req.json().catch(() => ({}));
      if (!/^[A-Z]{2}$/.test(b.country || '') || !b.name) return err(400, 'Give the country and the company name.');
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE person = ? AND created > ?").bind(user.id, addDays(today(), -1)).first();
      if (count.n >= 5) return err(429, 'Thanks! Five suggestions a day is the limit.');
      await env.DB.prepare('INSERT INTO suggestions (id, country, name, url, note, person, created) VALUES (?,?,?,?,?,?,?)')
        .bind(randomId(8), b.country, String(b.name).slice(0, 120), String(b.url || '').slice(0, 300), String(b.note || '').slice(0, 300), user.id, nowIso()).run();
      return json({ ok: true }, 201);
    }

    if (p === '/api/requests' && req.method === 'GET') return listOpen(env, url);
    if (p === '/api/requests' && req.method === 'POST') { const g = need({ accepted: true }); if (g) return g; return createRequest(req, env, user); }
    if ((m = p.match(/^\/api\/requests\/([\w-]+)$/))) {
      if (req.method === 'GET') return getRequest(env, user, m[1]);
      if (req.method === 'DELETE') { const g = need(); if (g) return g; return deleteMine(env, user, m[1]); }
    }
    if ((m = p.match(/^\/api\/requests\/([\w-]+)\/(claim|release|receipt|stamped|report)$/)) && req.method === 'POST') {
      const g = need({ accepted: m[2] !== 'release' }); if (g) return g;
      if (m[2] === 'claim') return claimRequest(req, env, user, m[1]);
      if (m[2] === 'release') return releaseClaim(env, user, m[1]);
      if (m[2] === 'receipt') return uploadReceipt(req, env, user, m[1]);
      if (m[2] === 'stamped') return uploadStamped(req, env, user, m[1]);
      if (m[2] === 'report') return reportRequest(req, env, user, m[1]);
    }
    if ((m = p.match(/^\/api\/requests\/([\w-]+)\/proof\/(receipt|stamped)$/)) && req.method === 'GET') { const g = need(); if (g) return g; return getProof(env, user, m[1], m[2]); }

    if (p === '/api/stats' && req.method === 'GET') {
      const rows = (await env.DB.prepare('SELECT outcome, country, bill_type, SUM(count) AS n FROM stats GROUP BY outcome, country, bill_type').all()).results;
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'open' AND hidden = 0").first();
      return json({ closed: rows, open: open.n });
    }

    if (p === '/api/admin/overview' && req.method === 'GET') { const g = need({ admin: true }); if (g) return g; return adminOverview(env); }
    if ((m = p.match(/^\/api\/admin\/requests\/([\w-]+)$/)) && req.method === 'POST') { const g = need({ admin: true }); if (g) return g; return adminAction(req, env, m[1]); }
    if (p === '/api/admin/companies' && req.method === 'POST') { const g = need({ admin: true }); if (g) return g; return adminCompany(req, env, user); }
    if ((m = p.match(/^\/api\/admin\/suggestions\/([\w-]+)$/)) && req.method === 'POST') {
      const g = need({ admin: true }); if (g) return g;
      await env.DB.prepare("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").bind(m[1]).run();
      const waiting = (await env.DB.prepare("SELECT * FROM requests WHERE company = ? AND status = 'pending'").bind(`pending:${m[1]}`).all()).results;
      for (const r of waiting) await closeRequest(env, r, 'company-not-payable', 'rejected');
      return json({ ok: true, rejected: waiting.length });
    }
    if (p === '/api/admin/upkeep' && req.method === 'POST') { const g = need({ admin: true }); if (g) return g; return json(await upkeep(env)); }

    return err(404, 'Not found.');
  } catch (e) {
    console.error(e);
    return err(500, 'Something went wrong on the server. Please try again.');
  }
}
