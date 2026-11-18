import { BackendError } from './errors.js';
import { sessionStore as storage } from './storage.js';

const TOKEN = 'rai.rest.token';

/**
 * JSON/REST backend. The contract is documented in server/API.md and
 * implemented by server/cloudflare (Workers + D1). The login token is kept in
 * sessionStorage only: it survives a refresh but not closing the tab.
 */
export function createRestBackend({ url }) {
  const base = url.replace(/\/+$/, '');
  let token = storage.get(TOKEN);

  async function call(method, path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, keepalive: method !== 'GET' });
    } catch {
      throw new BackendError('network');
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const code = data?.error || (res.status === 401 ? 'unauthorized' : 'server');
      throw new BackendError(code, data?.message || `${res.status} ${path}`, data);
    }
    return data;
  }

  const setToken = (t) => { token = t; if (t) storage.set(TOKEN, t); else storage.remove(TOKEN); };
  const signedIn = (d) => { setToken(d.token); return { participant: d.participant, study: d.study }; };

  return {
    type: 'rest',
    async getStudy(code) { return call('GET', `/studies/${encodeURIComponent(code)}`, null, { auth: false }); },
    async requestEmailCode({ study, email }) { return call('POST', '/auth/email/request', { study, email }, { auth: false }); },
    async verifyEmailCode({ study, email, code }) { return signedIn(await call('POST', '/auth/email/verify', { study, email, code }, { auth: false })); },
    async smartLogin({ study, username, pin }) { return signedIn(await call('POST', '/auth/smart', { study, username, pin }, { auth: false })); },
    async idLogin({ study, identifier }) { return signedIn(await call('POST', '/auth/id', { study, identifier }, { auth: false })); },
    /** Continue a login from this tab (after a refresh), if the token is still valid. */
    async restore() {
      if (!token) return null;
      try { return await call('GET', '/me'); } catch (e) { if (e.code === 'unauthorized') setToken(null); return null; }
    },
    async logout() { setToken(null); },
    async startAdministration(body) { return call('POST', '/administrations', body); },
    async updateAdministration(id, body) { return call('PATCH', `/administrations/${encodeURIComponent(id)}`, body); },
    async saveTrials(trials) { return call('POST', '/trials', { trials }); },
  };
}
