/**
 * MONITORING REJECT — API client
 *
 * IMPORTANT: set API_BASE_URL to your deployed Cloudflare Worker URL
 * before uploading to GitHub, e.g.:
 *   const API_BASE_URL = 'https://monitoring-reject-proxy.yourname.workers.dev';
 */
const API_BASE_URL = 'https://wastejn2.triobagusnnnnnnnnnn.workers.dev';

const TOKEN_KEY = 'mr_token';
const USER_KEY = 'mr_user';

// How long to wait for a response before giving up and treating the call as
// a network failure. Without this, `fetch()` has no timeout of its own — if
// the wifi/signal drops in a way that just black-holes the connection
// (instead of failing fast with a clear error), the browser can leave that
// fetch() promise pending for minutes. On the TV board that's fatal to the
// whole auto-refresh loop: refresh() awaits fetchPlantData() before it ever
// resets its `loading` flag back to false, and every later refresh —
// the 5-minute timer, the connection-banner's own retry — bails out
// immediately while `loading` is still true. So one hung request during a
// signal drop was silently permanently wedging auto-refresh, even long
// after the signal came back, until someone manually reloaded the page.
const API_TIMEOUT_MS = 20000;

const Session = {
  getToken() { return localStorage.getItem(TOKEN_KEY) || ''; },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken() { localStorage.removeItem(TOKEN_KEY); },
  getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (e) { return null; }
  },
  setUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); },
  clearUser() { localStorage.removeItem(USER_KEY); },
  clearAll() { this.clearToken(); this.clearUser(); }
};

async function apiCall(action, payload) {
  const body = Object.assign({ action }, payload || {});
  if (Session.getToken()) body.token = Session.getToken();

  let resp;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    resp = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    // Covers both a normal network failure AND our own timeout abort
    // (AbortError) — either way the caller just needs to know this attempt
    // didn't get a response, so it can retry instead of waiting forever.
    return { ok: false, error: 'network_error' };
  } finally {
    clearTimeout(timeoutId);
  }

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    return { ok: false, error: 'bad_response' };
  }
  return json;
}

const Api = {
  register: (username, password) => apiCall('register', { username, password }),
  login: (username, password) => apiCall('login', { username, password }),
  listPendingUsers: () => apiCall('listPendingUsers', {}),
  listUsers: () => apiCall('listUsers', {}),
  approveUser: (username, role) => apiCall('approveUser', { username, role }),
  rejectUser: (username) => apiCall('rejectUser', { username }),
  setUserRole: (username, role) => apiCall('setUserRole', { username, role }),
  submitReject: (data) => apiCall('submitReject', data),
  getDashboardData: (filters) => apiCall('getDashboardData', filters),
  listRawData: (filters) => apiCall('listRawData', filters),
  updateRawData: (data) => apiCall('updateRawData', data),
  deleteRawData: (id) => apiCall('deleteRawData', { id }),
  changePassword: (oldPassword, newPassword) => apiCall('changePassword', { oldPassword, newPassword })
};
