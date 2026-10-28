/*!
 * TideOver crypto helpers (Web Crypto, works in Cloudflare Workers and Node 20+).
 * Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the Apache License 2.0.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function randomId(bytes = 12) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyCache = new Map();
async function derive(secret, label, usage) {
  const id = `${label}|${secret}`;
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const algo = usage === 'sign' ? { name: 'HMAC', hash: 'SHA-256', length: 256 } : { name: 'AES-GCM', length: 256 };
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tideover-v1'), info: enc.encode(label) },
    base, algo, false, usage === 'sign' ? ['sign', 'verify'] : ['encrypt', 'decrypt'],
  );
  keyCache.set(id, key);
  return key;
}

/** Signs a short value so it can be stored in a cookie and checked later. */
export async function sign(secret, value) {
  const key = await derive(secret, 'session', 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return `${value}.${b64url(mac)}`;
}

export async function unsign(secret, signed) {
  if (!signed || typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const key = await derive(secret, 'session', 'sign');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', key, unb64url(signed.slice(i + 1)), enc.encode(value)); } catch { ok = false; }
  return ok ? value : null;
}

/** Encrypts account numbers before they are stored. */
export async function encrypt(secret, text) {
  const key = await derive(secret, 'data', 'crypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decrypt(secret, blob) {
  if (!blob) return null;
  const [iv, ct] = blob.split('.');
  const key = await derive(secret, 'data', 'crypt');
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, key, unb64url(ct)));
  } catch {
    return null;
  }
}
