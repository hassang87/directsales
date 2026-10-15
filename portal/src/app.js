import http from 'node:http';
import { config } from './config.js';
import { createRouter, HttpError, fail, readJson, parseCookies, clientIp, securityHeaders, sendJson, serveStatic } from './lib/http.js';
import { safeEqual } from './lib/security.js';
import { loadSession, staffNeedsMfa } from './lib/session.js';
import authRoutes from './routes/auth.js';
import passkeyRoutes from './routes/passkeys.js';
import agentRoutes from './routes/agent.js';
import teamRoutes from './routes/team.js';
import adminRoutes from './routes/admin.js';

export const router = createRouter();
authRoutes(router);
passkeyRoutes(router);
agentRoutes(router);
teamRoutes(router);
adminRoutes(router);

/* ---------- request pipeline ---------- */
async function handleApi(req, res, url) {
  const ctx = { req, res, url, query: url.searchParams, ip: clientIp(req), cookies: [], cookieJar: parseCookies(req.headers.cookie), session: null, user: null, params: {} };
  try {
    const m = router.match(req.method, url.pathname);
    if (!m) fail(404, 'Not found.');
    if (m.methodNotAllowed) fail(405, 'Method not allowed.');
    const { route, params } = m; const o = route.opts;
    ctx.params = params;
    loadSession(ctx);

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {
      // Origin check for every state change, signed in or not.
      const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
      if (origin !== config.origin) fail(403, 'Request blocked: it did not come from this site.', 'bad_origin');
    }
    if (o.auth !== 'public') {
      if (!ctx.user) fail(401, 'Please sign in.', 'signed_out');
      if (o.roles && !o.roles.includes(ctx.user.role)) fail(403, 'You don’t have access to this.', 'forbidden');
      if (!o.preMfa && staffNeedsMfa(ctx.user, ctx.session)) fail(403, 'Finish two-step sign-in first.', 'mfa_required');
    }
    if (mutating && ctx.session && o.auth !== 'public') {
      if (!safeEqual(req.headers['x-csrf-token'] || '', ctx.session.csrf)) fail(403, 'Your session expired. Reload the page and try again.', 'bad_csrf');
    }
    ctx.body = mutating ? await readJson(req, o.bodyLimit || 64 * 1024) : {};

    const result = await route.handler(ctx);
    if (res.writableEnded || ctx.streamed) return;
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    sendJson(res, ctx.status || 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
    if (/UNIQUE constraint failed/.test(e.message)) return sendJson(res, 409, { error: 'That conflicts with an existing record.', code: 'conflict' });
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}:`, e);
    sendJson(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    securityHeaders(res);
    let url;
    try { url = new URL(req.url, config.origin); } catch { res.writeHead(400).end(); return; }
    if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (!serveStatic(req, res, url.pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
  });
}
