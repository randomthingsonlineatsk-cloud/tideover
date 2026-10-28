// Test doubles for Cloudflare D1 and R2, backed by an in-memory SQLite database and a Map.
import Database from 'better-sqlite3';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a instanceof ArrayBuffer ? Buffer.from(a) : a))); }
  _s() { return this.db.prepare(this.sql); }
  async first(col) { const s = this._s(); const row = s.reader ? s.get(...this.args) : (s.run(...this.args), null); return row && col ? row[col] : row ?? null; }
  async all() { const s = this._s(); return { results: s.reader ? s.all(...this.args) : (s.run(...this.args), []) }; }
  async run() { const s = this._s(); if (s.reader) { const rows = s.all(...this.args); return { meta: { changes: rows.length }, results: rows }; } const r = s.run(...this.args); return { meta: { changes: r.changes } }; }
}

export function makeD1() {
  const db = new Database(':memory:');
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => { const out = []; db.transaction(() => { for (const s of stmts) { const st = s._s(); out.push(st.reader ? st.all(...s.args) : st.run(...s.args)); } })(); return out; },
    exec: async (sql) => db.exec(sql),
  };
}

export function makeR2() {
  const m = new Map();
  return {
    store: m,
    put: async (k, v, o) => { m.set(k, { body: Buffer.from(v), httpMetadata: o?.httpMetadata }); },
    get: async (k) => (m.has(k) ? { body: m.get(k).body, httpMetadata: m.get(k).httpMetadata } : null),
    delete: async (k) => { m.delete(k); },
  };
}
