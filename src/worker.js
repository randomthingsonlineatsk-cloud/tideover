/*!
 * TideOver Worker entry point. Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Apache-2.0.
 * Only the default export is allowed here: Cloudflare treats every named export as an entry point.
 */
import { handle, upkeep } from './server.js';

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(upkeep(env)),
};
