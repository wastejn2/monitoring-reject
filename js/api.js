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
  try {
    resp = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return { ok: false, error: 'network_error' };
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
  approveUser: (username) => apiCall('approveUser', { username }),
  rejectUser: (username) => apiCall('rejectUser', { username }),
  submitReject: (data) => apiCall('submitReject', data),
  getDashboardData: (filters) => apiCall('getDashboardData', filters),
  changePassword: (oldPassword, newPassword) => apiCall('changePassword', { oldPassword, newPassword })
};
