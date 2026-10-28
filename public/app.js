/*!
 * TideOver website. Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the Apache License 2.0.
 * Bill photos are read inside the browser and never uploaded; only payment proofs are uploaded.
 */
import { amountFound, dateFound, companyFound, dHashFromGrey } from './billread.js';

const VERSION = '1.0.0';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const S = { me: { signedIn: false }, cfg: null, companies: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const regionName = (() => { try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); return (c) => { try { return d.of(c); } catch { return c; } }; } catch { return (c) => c; } })();
const flag = (c) => /^[A-Z]{2}$/.test(c || '') ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : '';
const money = (amount, currency) => { try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount); } catch { return `${currency} ${amount}`; } };
const fmtDate = (d) => { try { return new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysTo = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 864e5);
const dueText = (d) => { const n = daysTo(d); return n > 1 ? `Due in ${n} days` : n === 1 ? 'Due tomorrow' : n === 0 ? 'Due today' : `Overdue by ${-n} day${n === -1 ? '' : 's'}`; };
const typeName = (t) => S.cfg?.billTypes?.[t] || t;

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', role: 'status', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.method && opts.method !== 'GET') headers['X-TideOver'] = '1';
  let body = opts.body;
  if (body && !(body instanceof Blob) && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, { ...opts, headers, body, credentials: 'same-origin' });
  const data = (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) { const e = new Error(data?.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

async function companies() {
  if (!S.companies) S.companies = (await api('/api/companies')).companies;
  return S.companies;
}

// ------------------------------------------------------------------ images

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function fingerprint(img) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data;
  const grey = [];
  for (let i = 0; i < d.length; i += 4) grey.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  return dHashFromGrey(grey);
}

/** Shrinks a photo to at most 1600 px and re-encodes it as JPEG, so proofs stay small. PDFs pass through. */
async function compress(file) {
  if (file.type === 'application/pdf') return file;
  const img = await loadImage(file);
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.82));
}

let tesseractLoading;
async function readText(img, onProgress) {
  if (!window.Tesseract) {
    tesseractLoading = tesseractLoading || new Promise((res, rej) => { const s = document.createElement('script'); s.src = TESSERACT; s.onload = res; s.onerror = () => rej(new Error('The bill reader could not load. Check your connection.')); document.head.append(s); });
    await tesseractLoading;
  }
  const c = document.createElement('canvas');
  const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const r = await window.Tesseract.recognize(c, 'eng', { logger: (m) => m.status === 'recognizing text' && onProgress?.(Math.round(m.progress * 100)) });
  return r.data.text || '';
}

// ------------------------------------------------------------------ turnstile

let tsLoading;
async function turnstile(el) {
  const key = S.cfg?.turnstileSiteKey;
  if (!key) return () => '';
  tsLoading = tsLoading || new Promise((res) => { const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.onload = res; document.head.append(s); });
  await tsLoading;
  const id = window.turnstile.render(el, { sitekey: key, theme: 'auto' });
  return () => window.turnstile.getResponse(id) || '';
}

// ------------------------------------------------------------------ header

function renderWho() {
  const w = $('#who');
  if (!S.me.signedIn) {
    w.innerHTML = S.cfg?.signIn ? `<a class="btn sm" href="/auth/github?next=${encodeURIComponent('/' + location.hash)}">Sign in with GitHub</a>` : '';
    return;
  }
  w.innerHTML = `${S.me.admin ? '<a class="btn sm" href="#/admin">Admin</a>' : ''}<a class="btn sm" href="#/mine">My page</a><a class="muted" href="/auth/logout" style="font-size:.85rem">Sign out</a>`;
}

function setNav(v) { $$('nav.main a').forEach((a) => a.setAttribute('aria-current', a.dataset.v === v ? 'page' : 'false')); }

function signInBlock(why) {
  if (!S.cfg?.signIn) return `<div class="note warn">Sign-in is not switched on yet. The site owner needs to finish the GitHub sign-in setup.</div>`;
  return `<div class="panel"><h2>Sign in first</h2><p class="muted">${esc(why)} TideOver uses GitHub sign-in: it only learns your GitHub username, never your password or email.</p><div><a class="btn primary" href="/auth/github?next=${encodeURIComponent('/' + location.hash)}">Sign in with GitHub</a></div><p class="muted" style="font-size:.86rem">No GitHub account? Creating one is free at github.com. More sign-in options are planned.</p></div>`;
}

function acceptBlock() {
  return `<form class="panel" id="acceptForm"><h2>Before you start</h2>
    <label class="check"><input type="checkbox" name="adult" required> <span>I am 18 or older.</span></label>
    <label class="check"><input type="checkbox" name="terms" required> <span>I have read <a href="#/about" target="_blank">how TideOver works, its privacy notice and terms</a>. I understand that TideOver never handles money, that help is never guaranteed, and that I must only post my own real bills.</span></label>
    <div><button class="btn primary">Continue</button></div></form>`;
}
function wireAccept() {
  const f = $('#acceptForm');
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/me/accept', { method: 'POST', body: { adult: f.adult.checked, terms: f.terms.checked } }); S.me.accepted = true; route(); } catch (x) { toast(x.message); }
  };
}

// ------------------------------------------------------------------ browse

async function viewBrowse() {
  setNav('browse');
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const data = await api(`/api/requests?${q}`);
  const countries = data.countries.map((c) => [c.country, `${flag(c.country)} ${regionName(c.country)} (${c.n})`]);
  const opt = (pairs, sel, blank) => `<option value="">${blank}</option>` + pairs.map(([k, v]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const cards = data.requests.map((r) => `<a class="card" href="#/r/${r.id}">
      <div class="row"><span class="pill acc">${esc(typeName(r.billType))}</span><span class="grow"></span><span class="muted" style="font-size:.84rem">${flag(r.country)} ${esc(r.city ? `${r.city}, ` : '')}${esc(regionName(r.country))}</span></div>
      <div class="amt">${money(r.amount, r.currency)}</div>
      <div class="co">${esc(r.company?.name)}</div>
      <div class="meta"><span class="${daysTo(r.dueDate) < 0 ? 'pill bad' : daysTo(r.dueDate) <= 7 ? 'pill warn' : ''}">${dueText(r.dueDate)}</span><span>${esc(r.displayName)}</span></div>
      ${r.note ? `<p class="say">“${esc(r.note)}”</p>` : ''}
    </a>`).join('');
  return `<div class="lead"><span class="kicker">Help someone</span><h1>Pay a stranger's bill, straight to the bill company</h1>
    <p>Each card is a real household bill. If you choose one, TideOver shows you the account number and how to pay that company directly. Your money never passes through TideOver or the person asking.</p></div>
    <form class="panel filters" id="filters" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
      <label class="field"><span>Country</span><select name="country">${opt(countries, q.get('country'), 'All countries')}</select></label>
      <label class="field"><span>Bill type</span><select name="type">${opt(Object.entries(S.cfg.billTypes), q.get('type'), 'All bills')}</select></label>
      <label class="field"><span>Order</span><select name="sort">${opt([['due', 'Due soonest'], ['newest', 'Newest'], ['smallest', 'Smallest amount']], q.get('sort') || 'due', 'Due soonest').replace('<option value="">Due soonest</option>', '')}</select></label>
    </form>
    ${data.requests.length ? `<div class="cards">${cards}</div>` : `<div class="panel empty"><h2>No open bills right now</h2><p>Every request has been picked up, or none has been posted yet. Check back later, or <a href="#/ask">ask for help with your own bill</a>.</p></div>`}
    <p class="muted" style="font-size:.86rem">TideOver checks each request automatically, but it cannot prove every bill is genuine. Only ever pay the bill company shown, never a person. <a href="#/about">How the checks work</a>.</p>`;
}
function wireBrowse() {
  const f = $('#filters');
  if (!f) return;
  f.onchange = () => {
    const q = new URLSearchParams();
    for (const k of ['country', 'type', 'sort']) if (f[k].value) q.set(k, f[k].value);
    location.hash = `#/?${q}`;
  };
}

// ------------------------------------------------------------------ one request

async function viewRequest(id) {
  setNav('browse');
  let r;
  try { r = await api(`/api/requests/${encodeURIComponent(id)}`); } catch (e) { return `<div class="panel empty"><h2>Not available</h2><p>${esc(e.message)} <a href="#/">See other bills</a>.</p></div>`; }
  const status = { open: ['Open', 'acc'], claimed: ['Someone is paying it', 'warn'], receipt: ['Paid; waiting for the stamped bill', 'ok'], paid: ['Paid and confirmed', 'ok'], paid_unconfirmed: ['Paid, not confirmed', 'ok'], expired: ['Expired', ''], removed: ['Removed', 'bad'], pending: ['Waiting for the company check', 'warn'], rejected: ['Company could not be added', 'bad'] }[r.status] || [r.status, ''];
  const facts = `<dl class="facts">
      <dt>Bill company</dt><dd>${esc(r.company?.name)}</dd>
      <dt>Bill type</dt><dd>${esc(typeName(r.billType))}</dd>
      <dt>Due</dt><dd>${fmtDate(r.dueDate)} (${dueText(r.dueDate)})</dd>
      <dt>Where</dt><dd>${flag(r.country)} ${esc(r.city ? `${r.city}, ` : '')}${esc(regionName(r.country))}</dd>
      <dt>Posted</dt><dd>${fmtDate(r.created)} by ${esc(r.displayName)}</dd>
      <dt>Bill reading</dt><dd>Amount found on the bill photo${r.readCompany ? '; company name found' : ''}${r.readDue ? '; due date found' : ''}</dd>
    </dl>`;
  let side = '';
  if (r.mine) {
    side = ownerPanel(r);
  } else if (r.myClaim && r.myClaim.status === 'active') {
    side = `<div class="panel" id="payPanel"><span class="kicker">You are paying this bill</span>
      <ol class="steps">
        <li><strong>Pay ${esc(r.company?.name)}</strong> using this account or consumer number:<div class="row" style="margin-top:6px"><span class="acct" id="acct">${esc(r.account)}</span><button class="btn sm" id="copyAcct">Copy</button></div>
          <p style="margin-top:8px">${esc(r.howToPay)}</p>${r.payUrl ? `<p style="margin-top:6px"><a class="btn sm" href="${esc(r.payUrl)}" target="_blank" rel="noopener">Official payment page ↗</a></p>` : ''}
          <p class="muted" style="font-size:.86rem;margin-top:6px">Check that the company shows the same name and roughly the same amount due before you pay.</p></li>
        <li><strong>Upload the receipt</strong> the company or your payment app gave you (screenshot, photo or PDF).
          <div class="row" style="margin-top:6px"><input type="file" id="receiptFile" accept="image/*,application/pdf"><button class="btn primary sm" id="sendReceipt">Upload receipt</button></div></li>
      </ol>
      <p class="muted" style="font-size:.86rem">This bill is hidden from other donors until ${new Date(r.myClaim.lockUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. If you upload no receipt by then, it reopens for others.</p>
      <div><button class="btn sm" id="release">I can't pay it after all</button></div></div>`;
  } else if (r.myClaim) {
    side = `<div class="panel"><span class="kicker">Thank you</span><h2>You paid this bill</h2><p>${r.myClaim.stamped ? 'The person has confirmed it with the stamped bill.' : 'Your receipt is uploaded. The person will add the stamped or paid bill.'}</p>${proofLinks(r)}</div>`;
  } else if (r.available) {
    side = `<div class="panel"><span class="kicker">Want to pay this?</span>
      <p>Click below and TideOver shows you the account number and how to pay ${esc(r.company?.name)} directly. The bill is held for you for ${S.cfg.lockHours} hours so nobody else pays it twice.</p>
      ${S.me.signedIn ? (S.me.accepted ? `<label class="check"><input type="checkbox" id="showName"> <span>Let ${esc(r.displayName)} see my GitHub username</span></label><div id="ts"></div><div><button class="btn primary" id="claim">I'm paying this</button></div>` : acceptBlock()) : signInBlock('Sign in so the bill can be held for you while you pay.')}
      <p class="muted" style="font-size:.86rem">Never send money to a person, and never pay through a link someone sends you. TideOver only ever points to the bill company.</p></div>`;
  } else {
    side = `<div class="panel"><span class="pill ${status[1]}">${esc(status[0])}</span><p>This bill is not available to pay right now.</p><a class="btn" href="#/">See other bills</a></div>`;
  }
  const report = !r.mine && S.me.signedIn ? `<details class="panel"><summary style="cursor:pointer">Report this request</summary><form id="reportForm" class="row" style="margin-top:8px"><input type="text" name="reason" maxlength="300" placeholder="What looks wrong?" required class="grow" style="max-width:420px"><button class="btn sm">Report</button></form><p class="muted" style="font-size:.84rem">Three reports from different people hide a request until it is reviewed.</p></details>` : '';
  const admin = S.me.admin ? `<div class="panel"><span class="kicker">Admin</span><p>Account number: <span class="mono">${esc(r.account || '—')}</span></p>${(r.reports || []).map((x) => `<p class="muted">Report: ${esc(x.reason)}</p>`).join('')}${proofLinks(r)}<div class="row"><button class="btn sm" data-admin="restore">Restore</button><button class="btn sm danger" data-admin="remove">Remove</button></div></div>` : '';
  return `<div><a href="#/" class="muted">← All bills</a></div>
    <div class="two"><div class="panel"><div class="row"><span class="pill ${status[1]}">${esc(status[0])}</span></div>
      <div class="big">${money(r.amount, r.currency)}</div>
      ${r.note ? `<p style="font-size:1.05rem">“${esc(r.note)}”</p>` : ''}${facts}</div>
      <div style="display:grid;gap:14px;align-content:start">${side}${admin}</div></div>${report}`;
}

function proofLinks(r) {
  if (!r.proofs) return '';
  return `<div class="row">${r.proofs.receipt ? `<a class="btn sm" href="/api/requests/${r.id}/proof/receipt" target="_blank">View receipt</a>` : ''}${r.proofs.stamped ? `<a class="btn sm" href="/api/requests/${r.id}/proof/stamped" target="_blank">View stamped bill</a>` : ''}</div>${r.proofs.donorName ? `<p class="muted">Paid by GitHub user ${esc(r.proofs.donorName)}.</p>` : ''}`;
}

function ownerPanel(r) {
  if (r.status === 'receipt') {
    return `<div class="panel"><span class="kicker">Good news</span><h2>A donor paid your bill</h2><p>Check the receipt, then confirm with a photo of your bill stamped or marked paid. If your bill is electronic, a screenshot of the company's page showing it paid works too. You have ${S.cfg.stampDays} days.</p>${proofLinks(r)}
      <div class="row"><input type="file" id="stampFile" accept="image/*,application/pdf"><button class="btn primary sm" id="sendStamp">Upload stamped bill</button></div></div>`;
  }
  const msg = { open: 'Your request is live. Donors can see it now.', claimed: 'A donor is paying your bill right now.', paid: 'Paid and confirmed. Thank the donor in your heart; this request will be deleted 30 days after closing.', paid_unconfirmed: 'Closed as paid, not confirmed.', expired: 'This request expired.', removed: 'This request was removed after review.', pending: `Your bill is saved but not public yet. ${r.company?.name || 'Your bill company'} is being checked to make sure donors can pay it directly with your account number. Once it is added, your bill goes live automatically.`, rejected: 'Your bill company could not be added, because donors cannot pay it directly with an account number. You can delete this request.' }[r.status] || '';
  return `<div class="panel"><span class="kicker">Your request</span><p>${esc(msg)}</p>${proofLinks(r)}${['open', 'expired', 'pending', 'rejected'].includes(r.status) ? '<div><button class="btn sm danger" id="deleteReq">Delete this request</button></div>' : ''}</div>`;
}

function wireRequest(id) {
  const tsEl = $('#ts');
  let getToken = () => '';
  if (tsEl) turnstile(tsEl).then((f) => { getToken = f; });
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = async (e) => { e.preventDefault(); el.disabled = true; try { await fn(); } catch (x) { toast(x.message); } finally { el.disabled = false; } }; };
  on('#claim', async () => { await api(`/api/requests/${id}/claim`, { method: 'POST', body: { showName: $('#showName')?.checked, turnstile: getToken() } }); route(); });
  on('#copyAcct', async () => { await navigator.clipboard.writeText($('#acct').textContent); toast('Account number copied'); });
  on('#release', async () => { if (confirm('Release this bill so someone else can pay it?')) { await api(`/api/requests/${id}/release`, { method: 'POST' }); route(); } });
  on('#sendReceipt', async () => {
    const f = $('#receiptFile').files[0];
    if (!f) throw new Error('Choose the receipt file first.');
    const blob = await compress(f);
    await api(`/api/requests/${id}/receipt`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || f.type } });
    toast('Receipt uploaded. Thank you!');
    route();
  });
  on('#sendStamp', async () => {
    const f = $('#stampFile').files[0];
    if (!f) throw new Error('Choose the photo of the stamped bill first.');
    const blob = await compress(f);
    await api(`/api/requests/${id}/stamped`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || f.type } });
    toast('Confirmed. This request is now closed.');
    route();
  });
  on('#deleteReq', async () => { if (confirm('Delete this request? This cannot be undone.')) { await api(`/api/requests/${id}`, { method: 'DELETE' }); location.hash = '#/mine'; } });
  $$('[data-admin]').forEach((b) => { b.onclick = async () => { try { await api(`/api/admin/requests/${id}`, { method: 'POST', body: { action: b.dataset.admin } }); toast('Done'); route(); } catch (x) { toast(x.message); } }; });
  const rf = $('#reportForm');
  if (rf) rf.onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/requests/${id}/report`, { method: 'POST', body: { reason: rf.reason.value } }); toast('Thanks. The report was recorded.'); rf.reset(); } catch (x) { toast(x.message); } };
  wireAccept();
}

// ------------------------------------------------------------------ ask for help

async function viewAsk() {
  setNav('ask');
  const intro = `<div class="lead"><span class="kicker">Ask for help</span><h1>Post one essential bill</h1><p>Donors pay the bill company directly, using the account or consumer number on your bill. You never receive money yourself, and you never need to share bank details.</p></div>`;
  if (!S.me.signedIn) return intro + signInBlock('Sign in to post a bill.');
  if (S.me.blocked) return intro + `<div class="note bad">This account can no longer post requests.</div>`;
  if (!S.me.accepted) return intro + acceptBlock();
  await companies();
  const countries = ISO.map((c) => [c, regionName(c)]).sort((a, b) => a[1].localeCompare(b[1]));
  const currencies = Object.keys(S.cfg.inrPerUnit).sort();
  return `${intro}
  <form class="panel" id="askForm" novalidate>
    <div class="filters">
      <label class="field"><span>Country</span><select name="country" required><option value="">Choose…</option>${countries.map(([c, n]) => `<option value="${c}">${flag(c)} ${esc(n)}</option>`).join('')}</select></label>
      <label class="field"><span>Bill company</span><select name="companyId" required disabled><option value="">Choose the country first</option></select></label>
      <label class="field"><span>Bill type</span><select name="billType" required disabled></select></label>
    </div>
    <div id="newCo" hidden class="panel" style="background:var(--paper)">
      <p><strong>Your bill company isn't in the directory yet.</strong> Post your bill anyway: it will wait until the company has been checked, which means confirming that donors can pay it directly with your account number. Usually within a few days.</p>
      <div class="filters">
        <label class="field"><span>Company name</span><input type="text" name="ncName" maxlength="120" placeholder="Exactly as printed on the bill"></label>
        <label class="field"><span>Company website (optional)</span><input type="url" name="ncUrl" placeholder="https://"></label>
        <label class="field"><span>Currency of the bill</span><select name="ncCurrency">${currencies.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></label>
      </div>
    </div>
    <div class="field"><span>Photo of the bill</span><input type="file" name="photo" accept="image/*" capture="environment" required><small>Take a straight, well-lit photo of the whole bill. It is read here on your device and is not uploaded or stored.</small></div>
    <div id="readOut" class="found" hidden></div>
    <div class="filters">
      <label class="field"><span>Amount due</span><input type="number" name="amount" step="0.01" min="0" inputmode="decimal" required><small id="minHint"></small></label>
      <label class="field"><span>Due date</span><input type="date" name="dueDate" required></label>
      <label class="field"><span>Account or consumer number</span><input type="text" name="account" autocomplete="off" required><small>Shown only to the donor who chooses to pay.</small></label>
    </div>
    <div class="filters">
      <label class="field"><span>First name or nickname</span><input type="text" name="displayName" maxlength="30" required></label>
      <label class="field"><span>City (optional)</span><input type="text" name="city" maxlength="40"></label>
    </div>
    <label class="field"><span>A short note (optional)</span><textarea name="note" maxlength="300" placeholder="In a sentence or two, what happened. No phone numbers, links or payment details."></textarea><small><span id="noteCount">0</span>/300</small></label>
    <div id="ts"></div>
    <div id="askErr"></div>
    <div class="row"><button class="btn primary" id="askBtn">Post my bill</button><span class="muted" style="font-size:.86rem">One open request at a time.</span></div>
  </form>`;
}

function wireAsk() {
  const f = $('#askForm');
  if (!f) { wireAccept(); return; }
  let getToken = () => '';
  turnstile($('#ts')).then((g) => { getToken = g; });
  const st = { text: '', hash: '', reading: false };
  const isNew = () => f.companyId.value === 'new';
  const company = () => isNew() ? { id: 'new', name: f.ncName.value, billTypes: Object.keys(S.cfg.billTypes), currency: f.ncCurrency.value, minimum: localMinimum(f.ncCurrency.value) } : S.companies.find((c) => c.id === f.companyId.value);
  const showMin = () => { const c = company(); $('#minHint').textContent = c && c.minimum ? `At least ${money(c.minimum, c.currency)} (about ₹${S.cfg.minInr.toLocaleString('en-IN')}).` : ''; };

  f.country.onchange = () => {
    const list = S.companies.filter((c) => c.country === f.country.value);
    f.companyId.innerHTML = `<option value="">Choose…</option>` + list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + `<option value="new">My bill company isn't listed</option>`;
    f.companyId.disabled = !f.country.value;
    if (CUR[f.country.value]) f.ncCurrency.value = CUR[f.country.value];
    f.billType.innerHTML = ''; f.billType.disabled = true;
    $('#newCo').hidden = true;
    check();
  };
  f.companyId.onchange = () => {
    const c = company();
    $('#newCo').hidden = !isNew();
    f.billType.innerHTML = c ? c.billTypes.map((t) => `<option value="${t}">${esc(typeName(t))}</option>`).join('') : '';
    f.billType.disabled = !c;
    showMin();
    check();
  };
  f.ncCurrency.onchange = showMin;
  f.photo.onchange = async () => {
    const file = f.photo.files[0];
    if (!file) return;
    const out = $('#readOut');
    out.hidden = false;
    out.innerHTML = '<span class="muted">Reading your bill on this device… this can take up to a minute the first time.</span>';
    st.reading = true;
    try {
      const img = await loadImage(file);
      st.hash = fingerprint(img);
      st.text = await readText(img, (p) => { out.innerHTML = `<span class="muted">Reading your bill on this device… ${p}%</span>`; });
    } catch (e) {
      st.text = '';
      out.innerHTML = `<span class="n">${esc(e.message || 'The photo could not be read.')}</span>`;
    }
    st.reading = false;
    check();
  };
  f.note.oninput = () => { $('#noteCount').textContent = f.note.value.length; };
  for (const n of ['amount', 'dueDate']) f[n].oninput = check;

  function check() {
    const out = $('#readOut');
    if (!st.text || st.reading) return { amt: false };
    const c = company();
    const amt = f.amount.value && amountFound(st.text, f.amount.value);
    const due = f.dueDate.value && dateFound(st.text, f.dueDate.value);
    const co = c && companyFound(st.text, c.name);
    out.innerHTML = `<strong>What the bill photo shows</strong>
      <span class="${amt ? 'y' : 'n'}">${amt ? '✓ The amount you typed is on the bill.' : f.amount.value ? '✗ The amount you typed was not found on the photo. Check it, or take a clearer photo.' : 'Type the amount due to check it against the photo.'}</span>
      <span class="${due ? 'y' : 'n'}">${due ? '✓ The due date is on the bill.' : 'The due date was not found (this is optional).'}</span>
      <span class="${co ? 'y' : 'n'}">${co ? '✓ The company name is on the bill.' : 'The company name was not found (optional; bills in other scripts may not be read).'}</span>`;
    return { amt, due, co };
  }

  f.onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#askErr');
    errBox.innerHTML = '';
    const r = check();
    const btn = $('#askBtn');
    btn.disabled = true;
    try {
      if (st.reading) throw new Error('Wait until the bill photo has been read.');
      const body = {
        companyId: f.companyId.value, newCompany: isNew() ? { name: f.ncName.value, url: f.ncUrl.value, currency: f.ncCurrency.value, country: f.country.value } : undefined, billType: f.billType.value, amount: f.amount.value, dueDate: f.dueDate.value, account: f.account.value,
        displayName: f.displayName.value, city: f.city.value, note: f.note.value, imageHash: st.hash, readAmount: !!r.amt, readCompany: !!r.co, readDue: !!r.due, turnstile: getToken(),
      };
      const res = await api('/api/requests', { method: 'POST', body });
      location.hash = `#/r/${res.id}`;
      toast(res.pending ? 'Saved. Your bill goes live once the company has been checked.' : 'Your bill is posted.');
    } catch (x) {
      errBox.innerHTML = `<div class="note bad">${esc(x.message)}</div>`;
      if (window.turnstile) try { window.turnstile.reset(); } catch { /* ignore */ }
    } finally {
      btn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ my page

async function viewMine() {
  setNav('');
  if (!S.me.signedIn) return signInBlock('Sign in to see your requests and the bills you are paying.');
  const d = await api('/api/mine');
  const st = (s) => ({ open: 'Open', claimed: 'Being paid', receipt: 'Paid; add stamped bill', paid: 'Paid and confirmed', paid_unconfirmed: 'Paid, not confirmed', expired: 'Expired', removed: 'Removed', pending: 'Waiting for company check', rejected: 'Company not payable' }[s] || s);
  const reqs = d.requests.map((r) => `<tr><td><a href="#/r/${r.id}">${money(r.amount, r.currency)}</a></td><td>${esc(r.company?.name)}</td><td>${fmtDate(r.dueDate)}</td><td>${esc(st(r.status))}${r.hidden ? ' <span class="pill bad">under review</span>' : ''}</td></tr>`).join('');
  const claims = d.claims.map((c) => `<tr><td><a href="#/r/${c.request}">${money(c.amount, c.currency)}</a></td><td>${esc(c.company)}</td><td>${c.status === 'active' ? 'Pay and upload the receipt' : c.stamped ? 'Confirmed by the person' : c.receipt ? 'Receipt uploaded' : esc(c.status)}</td></tr>`).join('');
  return `<div class="lead"><span class="kicker">My page</span><h1>Hello, ${esc(S.me.login)}</h1></div>
    <div class="panel"><h2>My requests</h2>${reqs ? `<div class="tablewrap"><table><thead><tr><th>Amount</th><th>Company</th><th>Due</th><th>Status</th></tr></thead><tbody>${reqs}</tbody></table></div>` : '<p class="muted">None yet. <a href="#/ask">Ask for help with a bill</a>.</p>'}</div>
    <div class="panel"><h2>Bills I am paying or paid</h2>${claims ? `<div class="tablewrap"><table><thead><tr><th>Amount</th><th>Company</th><th>Status</th></tr></thead><tbody>${claims}</tbody></table></div>` : '<p class="muted">None yet. <a href="#/">Find a bill to pay</a>.</p>'}</div>
    <div class="panel"><h2>Delete my account</h2><p class="muted">Removes your requests, their proofs, your reports and your sign-in record. Bills you paid stay paid, without your name.</p><div><button class="btn danger" id="delAcct">Delete my account and data</button></div></div>`;
}
function wireMine() {
  const b = $('#delAcct');
  if (b) b.onclick = async () => { if (!confirm('Delete your account and all your data? This cannot be undone.')) return; try { await api('/api/me', { method: 'DELETE' }); location.href = '/'; } catch (x) { toast(x.message); } };
}

// ------------------------------------------------------------------ directory

const ISO = 'AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VN VU WS YE ZA ZM ZW'.split(' ');

// Usual currency for each country (people can change it if their bill uses another).
const CUR = Object.fromEntries('IN:INR US:USD GB:GBP AE:AED SA:SAR QA:QAR KW:KWD OM:OMR BH:BHD CA:CAD AU:AUD NZ:NZD SG:SGD MY:MYR TH:THB ID:IDR PH:PHP VN:VND JP:JPY CN:CNY HK:HKD KR:KRW TW:TWD PK:PKR BD:BDT LK:LKR NP:NPR BR:BRL MX:MXN AR:ARS CO:COP CL:CLP PE:PEN ZA:ZAR NG:NGN KE:KES GH:GHS EG:EGP MA:MAD TR:TRY SE:SEK NO:NOK DK:DKK PL:PLN CZ:CZK HU:HUF IL:ILS CH:CHF LI:CHF DE:EUR FR:EUR IT:EUR ES:EUR PT:EUR NL:EUR BE:EUR AT:EUR IE:EUR FI:EUR GR:EUR LU:EUR SK:EUR SI:EUR EE:EUR LV:EUR LT:EUR MT:EUR CY:EUR HR:EUR EC:USD SV:USD PA:USD PR:USD'.split(' ').map((x) => x.split(':')));
function localMinimum(currency) {
  const rate = S.cfg?.inrPerUnit?.[currency];
  if (!rate) return null;
  const raw = S.cfg.minInr / rate;
  const step = raw >= 10000 ? 1000 : raw >= 1000 ? 100 : raw >= 100 ? 10 : 1;
  return Math.ceil(raw / step) * step;
}

async function viewDirectory() {
  setNav('directory');
  const list = await companies();
  const by = new Map();
  for (const c of list) { if (!by.has(c.country)) by.set(c.country, []); by.get(c.country).push(c); }
  const sections = [...by.entries()].sort((a, b) => regionName(a[0]).localeCompare(regionName(b[0]))).map(([cc, cs]) => `<section class="panel"><h2>${flag(cc)} ${esc(regionName(cc))} <span class="muted" style="font-size:.9rem;font-family:var(--f-body);font-weight:400">${cs.length} compan${cs.length === 1 ? 'y' : 'ies'} · minimum ${money(cs[0].minimum, cs[0].currency)}</span></h2>
      <div class="tablewrap"><table><thead><tr><th>Company</th><th>Bills</th><th>How donors pay</th></tr></thead><tbody>${cs.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.billTypes.map(typeName).join(', ')}</td><td>${esc(c.route)}${c.payUrl ? ` · <a href="${esc(c.payUrl)}" target="_blank" rel="noopener">official page ↗</a>` : ''}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
  const suggest = S.me.signedIn ? `<form class="panel" id="suggestForm"><h2>Suggest a bill company</h2><p class="muted">Requests can only be posted for companies in this list. Each one is checked by hand before it is added, so donors are only ever sent to real payment pages.</p>
      <div class="filters"><label class="field"><span>Country</span><select name="country" required><option value="">Choose…</option>${ISO.map((c) => [c, regionName(c)]).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}</select></label>
      <label class="field"><span>Company name</span><input type="text" name="name" maxlength="120" required></label>
      <label class="field"><span>Official website (optional)</span><input type="url" name="url" placeholder="https://"></label></div>
      <label class="field"><span>Anything we should know (optional)</span><input type="text" name="note" maxlength="300" placeholder="For example: anyone can pay with the account number on the website"></label>
      <div><button class="btn primary">Send suggestion</button></div></form>` : `<div class="panel"><p>Missing a company? <a href="/auth/github?next=${encodeURIComponent('/#/directory')}">Sign in</a> to suggest one.</p></div>`;
  return `<div class="lead"><span class="kicker">Directory</span><h1>Bill companies donors can pay</h1><p>Only companies that accept payments from anyone with the account number are listed. In India, companies are paid through Bharat BillPay in any UPI app's "Pay bills" section. People in any country can post a bill for a company that isn't listed yet; it goes live once the company has been checked and added.</p></div>${sections || '<div class="panel empty">No companies yet.</div>'}${suggest}`;
}
function wireDirectory() {
  const f = $('#suggestForm');
  if (f) f.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/suggestions', { method: 'POST', body: { country: f.country.value, name: f.name.value, url: f.url.value, note: f.note.value } }); toast('Thank you. The company will be checked before it is added.'); f.reset(); } catch (x) { toast(x.message); } };
}

// ------------------------------------------------------------------ about

async function viewAbout() {
  setNav('about');
  let stats = { open: 0, closed: [] };
  try { stats = await api('/api/stats'); } catch { /* ignore */ }
  const paid = stats.closed.filter((x) => x.outcome === 'paid' || x.outcome === 'paid-unconfirmed').reduce((a, b) => a + b.n, 0);
  return `<div class="lead"><span class="kicker">How it works</span><h1>TideOver connects people; it never touches money</h1></div>
  <div class="panel prose">
    <p><strong>${stats.open}</strong> open bills · <strong>${paid}</strong> bills paid so far.</p>
    <h2>For people asking</h2>
    <ol><li>Sign in, choose your country and the company that sent the bill. If it isn't listed, type its name: your bill goes live once the company has been checked.</li><li>Photograph the bill. It is read on your own device to check the amount; the photo is not uploaded.</li><li>A donor pays the company directly using your account number.</li><li>You see their receipt, then confirm with a photo of the bill stamped or marked paid.</li></ol>
    <h2>For donors</h2>
    <ol><li>Pick a bill and click "I'm paying this". It is held for you for ${S.cfg.lockHours} hours.</li><li>Pay the company with the account number shown, through its own payment route.</li><li>Upload the receipt. The person confirms with the stamped bill.</li></ol>
    <h2>The checks, and their limits</h2>
    <ul><li>Donors are only ever sent to companies in the <a href="#/directory">directory</a>, each checked by hand, so payment routes cannot be faked. A bill for a company that isn't listed yet waits, unseen, until the company has been checked.</li><li>The amount typed must appear on the bill photo; the due date must be within ${60} days ahead or ${90} days overdue; each request must be at least about ₹${S.cfg.minInr.toLocaleString('en-IN')}.</li><li>One open request per person; the same bill or photo cannot be posted twice.</li><li>Three reports from different people hide a request until it is reviewed; two removals block an account.</li><li>These checks reduce fake requests but cannot rule them out. TideOver does not verify identities, and help is never guaranteed.</li></ul>
    <h2>Privacy</h2>
    <ul><li>Donors see a first name or nickname, city (optional), country, the company, amount, due date and your note. The account number is shown only to the donor who chooses to pay.</li><li>Bill photos are read on your device and never stored. Payment receipts and stamped bills are stored privately, visible only to the person asking, the donor and the admin.</li><li>Requests, proofs and account numbers are deleted 30 days after a request closes; only anonymous counts remain. You can delete your request or your whole account at any time.</li><li>TideOver only receives your GitHub username, not your email or password. No ads, no trackers, no analytics.</li></ul>
    <h2>Terms</h2>
    <ul><li>You must be 18 or older. Post only your own real, unpaid, essential bills.</li><li>TideOver never collects, holds or forwards money, and never asks for bank or card details. Anyone asking you to pay them directly is not following TideOver's rules: report them.</li><li>Help given here is a personal gift between individuals. TideOver is not a charity and issues no tax receipts.</li><li>TideOver is provided as is, without any guarantee that a bill will be paid or that a request is genuine.</li></ul>
    <h2>Credit</h2>
    <p>Made by Khan Gulrez Shagufa Fazal Ahmed (<a href="https://orcid.org/0009-0009-6195-0329" target="_blank" rel="noopener">ORCID 0009-0009-6195-0329</a>). Free and open source under the Apache License 2.0 on <a href="https://github.com/randomthingsonlineatsk-cloud/tideover" target="_blank" rel="noopener">GitHub</a>. Version ${VERSION}.</p>
  </div>`;
}

// ------------------------------------------------------------------ admin

async function viewAdmin() {
  setNav('');
  if (!S.me.admin) return `<div class="panel empty">Admins only.</div>`;
  const d = await api('/api/admin/overview');
  const hidden = d.hidden.map((r) => `<tr><td><a href="#/r/${r.id}">${money(r.amount, r.currency)}</a></td><td>${esc(r.company)}</td><td>${esc(r.display_name)}</td><td>${r.reports}</td></tr>`).join('');
  const sug = d.suggestions.map((s) => `<tr><td>${flag(s.country)} ${esc(s.country)}</td><td>${esc(s.name)}${s.waiting ? ` <span class="pill warn">${s.waiting} bill${s.waiting > 1 ? 's' : ''} waiting</span>` : ''}</td><td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}</td><td>${esc(s.note)}</td><td><button class="btn sm" data-fill='${esc(JSON.stringify({ country: s.country, name: s.name, url: s.url, id: s.id, currency: s.currency || CUR[s.country] || '' }))}'>Add</button> <button class="btn sm" data-dismiss="${s.id}">Dismiss</button></td></tr>`).join('');
  return `<div class="lead"><span class="kicker">Admin</span><h1>Review</h1><p>${d.counts.map((c) => `${esc(c.status)}: ${c.n}`).join(' · ') || 'No requests yet.'}</p></div>
  <div class="panel"><h2>Hidden after reports</h2>${hidden ? `<div class="tablewrap"><table><thead><tr><th>Amount</th><th>Company</th><th>Name</th><th>Reports</th></tr></thead><tbody>${hidden}</tbody></table></div>` : '<p class="muted">Nothing to review.</p>'}</div>
  <div class="panel"><h2>Bills waiting for a company check</h2>${d.pending.length ? `<div class="tablewrap"><table><thead><tr><th>Bill</th><th>Country</th><th>Company named</th><th>Website given</th></tr></thead><tbody>${d.pending.map((r) => `<tr><td><a href="#/r/${r.id}">${money(r.amount, r.currency)}</a> · ${esc(typeName(r.bill_type))}</td><td>${flag(r.country)} ${esc(r.country)}</td><td>${esc(r.pending_name)}</td><td>${r.pending_url ? `<a href="${esc(r.pending_url)}" target="_blank" rel="noopener">${esc(r.pending_url)}</a>` : ''}</td></tr>`).join('')}</tbody></table></div><p class="muted" style="font-size:.86rem">Check each company below. "Add" puts it in the directory and makes its waiting bills live; "Dismiss" closes them, for companies donors can't pay directly.</p>` : '<p class="muted">None.</p>'}</div>
  <div class="panel"><h2>Company suggestions</h2>${sug ? `<div class="tablewrap"><table><thead><tr><th>Country</th><th>Name</th><th>Website</th><th>Note</th><th></th></tr></thead><tbody>${sug}</tbody></table></div>` : '<p class="muted">No new suggestions.</p>'}</div>
  <form class="panel" id="coForm"><h2>Add or update a company</h2><p class="muted">Before adding, open the company's official website yourself and check that anyone can pay a bill with only the account number.</p>
    <input type="hidden" name="suggestion">
    <div class="filters"><label class="field"><span>Country code</span><input type="text" name="country" maxlength="2" placeholder="GB" required></label>
    <label class="field"><span>Name</span><input type="text" name="name" required></label>
    <label class="field"><span>Currency code</span><input type="text" name="currency" maxlength="3" placeholder="GBP" required></label>
    <label class="field"><span>Minimum (optional)</span><input type="number" name="min_amount" step="1"></label></div>
    <label class="field"><span>Official payment page</span><input type="url" name="pay_url" placeholder="https://"></label>
    <label class="field"><span>How donors pay (short steps)</span><textarea name="howToPay"></textarea></label>
    <div class="row">${Object.entries(S.cfg.billTypes).map(([k, v]) => `<label class="check"><input type="checkbox" name="bt" value="${k}"> <span>${esc(v)}</span></label>`).join('')}</div>
    <div class="row"><button class="btn primary">Save company</button><button type="button" class="btn" id="runUpkeep">Run daily clean-up now</button></div></form>`;
}
function wireAdmin() {
  const f = $('#coForm');
  if (!f) return;
  $$('[data-fill]').forEach((b) => { b.onclick = () => { const s = JSON.parse(b.dataset.fill); f.country.value = s.country; f.name.value = s.name; f.pay_url.value = s.url || ''; f.currency.value = s.currency || ''; f.suggestion.value = s.id; f.scrollIntoView({ behavior: 'smooth' }); }; });
  $$('[data-dismiss]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/suggestions/${b.dataset.dismiss}`, { method: 'POST' }); route(); }; });
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/companies', { method: 'POST', body: { country: f.country.value.toUpperCase(), name: f.name.value, currency: f.currency.value.toUpperCase(), min_amount: f.min_amount.value || null, pay_url: f.pay_url.value, howToPay: f.howToPay.value, billTypes: $$('input[name=bt]:checked', f).map((x) => x.value), suggestion: f.suggestion.value || undefined } });
      S.companies = null; toast(`Saved ${r.id}${r.released ? `; ${r.released} waiting bill${r.released > 1 ? 's' : ''} now live` : ''}`); route();
    } catch (x) { toast(x.message); }
  };
  $('#runUpkeep').onclick = async () => { try { const r = await api('/api/admin/upkeep', { method: 'POST' }); toast(`Clean-up: ${JSON.stringify(r)}`); } catch (x) { toast(x.message); } };
}

// ------------------------------------------------------------------ router

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const path = h.split('?')[0];
  const view = $('#view');
  let html;
  try {
    if (path.startsWith('/r/')) html = await viewRequest(path.slice(3));
    else if (path === '/ask') html = await viewAsk();
    else if (path === '/mine') html = await viewMine();
    else if (path === '/directory') html = await viewDirectory();
    else if (path === '/about') html = await viewAbout();
    else if (path === '/admin') html = await viewAdmin();
    else html = await viewBrowse();
  } catch (e) {
    html = `<div class="panel empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
  view.innerHTML = html;
  if (path.startsWith('/r/')) wireRequest(path.slice(3));
  else if (path === '/ask') wireAsk();
  else if (path === '/mine') wireMine();
  else if (path === '/directory') wireDirectory();
  else if (path === '/admin') wireAdmin();
  else wireBrowse();
  wireAccept();
  renderWho();
}

async function start() {
  [S.cfg, S.me] = await Promise.all([api('/api/config'), api('/api/me').catch(() => ({ signedIn: false }))]);
  window.addEventListener('hashchange', () => { route(); window.scrollTo({ top: 0 }); });
  await route();
}
start().catch((e) => { $('#view').innerHTML = `<div class="panel empty"><h2>TideOver could not start</h2><p>${esc(e.message)}</p></div>`; });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
