import { randomBytes, createHash } from 'node:crypto';
                                                                 
import { bearerToken, readJson, json } from '../../shared/http/server.js';
import { ApiError } from '../../shared/http/errors.js';

const LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_FAILURE_SOURCES = 256;
/** Browser sessions contain independent credentials; the durable operator token never enters a cookie. */
export class WorkerAccess {
          sessions = new Map                ();
          failures = new Map                                          ();
          verify                         ;
          now              ;
          scope        ;
  constructor(verify                         , now = Date.now, scope = randomBytes(8).toString('hex')) { this.verify = verify; this.now = now; this.scope = scope; }
          cookieName(req                 ) { return `werk_worker_${req.socket.localPort ?? 0}_${this.scope}`; }
          digest(value        ) { return createHash('sha256').update(value).digest('hex'); }
          browserRequest(req                 ) {
    this.sameOrigin(req);
    if (!['GET', 'HEAD'].includes(req.method ?? '') && !req.headers.origin) throw new ApiError(403, 'Use the worker webview from its own address.');
    if (req.headers['x-werk-request'] !== 'webview') throw new ApiError(403, 'Open this action in the worker webview.');
  }
          sameOrigin(req                 ) {
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'Use the worker webview from its own address.');
  }
          cookie(req                 ) {
    const name = this.cookieName(req) + '=';
    const values = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name));
    if (values.length !== 1) return;
    const value = values[0].slice(name.length);
    return /^[a-f0-9]{64}$/.test(value) ? this.digest(value) : undefined;
  }
          prune() {
    for (const [key, expiry] of this.sessions) if (expiry <= this.now()) this.sessions.delete(key);
    for (const [key, value] of this.failures) if (value.until <= this.now()) this.failures.delete(key);
  }
          session(req                 ) {
    this.prune();
    const key = this.cookie(req);
    return key ? this.sessions.get(key) : undefined;
  }
          setCookie(req                 , res                , value        , seconds        ) {
    // HTTPS ingress is indicated by the browser Origin; forwarded headers are deliberately not trusted.
    const secure = req.headers.origin?.startsWith('https://') || 'encrypted' in req.socket;
    res.setHeader('set-cookie', `${this.cookieName(req)}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }
  authenticate(req                 ) {
    this.sameOrigin(req);
    // Never downgrade an invalid or ambiguous explicit bearer credential to cookie authentication.
    if (req.headers.authorization !== undefined) { this.verify(bearerToken(req)); return; }
    if (!this.session(req)) throw new ApiError(401, 'Worker access expired or the worker restarted. Unlock this worker again.');
    this.browserRequest(req);
  }
  async route(req                 , res                ) {
    if (req.url !== '/api/access') return false;
    this.sameOrigin(req);
    if (req.method === 'GET') {
      const expiry = this.session(req);
      if (expiry) this.browserRequest(req);
      json(res, 200, expiry ? { authenticated: true, expiresAt: new Date(expiry).toISOString() } : { authenticated: false });
      return true;
    }
    if (!['POST', 'DELETE'].includes(req.method ?? '')) { json(res, 405, { error: 'Use GET, POST or DELETE for worker access.' }); return true; }
    this.browserRequest(req);
    if (req.method === 'DELETE') {
      const key = this.cookie(req); if (key) this.sessions.delete(key);
      this.setCookie(req, res, '', 0); json(res, 200, { authenticated: false }); return true;
    }
    this.prune();
    const source = req.socket.remoteAddress ?? 'unknown';
    if ((this.failures.get(source)?.count ?? 0) >= 20) { res.setHeader('retry-after', '60'); throw new ApiError(429, 'Too many unlock attempts. Wait one minute and try again.'); }
    const body = await readJson(req);
    if (Object.keys(body).some(key => key !== 'token') || typeof body.token !== 'string' || body.token.length > 256) throw new ApiError(400, 'Enter the worker access token.');
    try { this.verify(body.token.trim()); }
    catch (error) {
      if (!this.failures.has(source) && this.failures.size >= MAX_FAILURE_SOURCES) this.failures.delete(this.failures.keys().next().value );
      const failure = this.failures.get(source) ?? { count: 0, until: this.now() + 60_000 };
      failure.count++; this.failures.set(source, failure); throw error;
    }
    this.failures.delete(source);
    const prior = this.cookie(req); if (prior) this.sessions.delete(prior);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value );
    const token = randomBytes(32).toString('hex'), expiry = this.now() + LIFETIME_MS;
    this.sessions.set(this.digest(token), expiry);
    this.setCookie(req, res, token, LIFETIME_MS / 1000);
    json(res, 200, { authenticated: true, expiresAt: new Date(expiry).toISOString() }); return true;
  }
}
