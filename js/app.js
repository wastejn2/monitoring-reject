/**
 * MONITORING REJECT — app bootstrap: wires auth, hamburger nav, and pages
 * together, and decides which screen to show on load.
 */

const PAGE_TITLES = {
  input: 'Input Data Reject',
  dashboard: 'Dashboard',
  tv: 'Monitoring TV',
  accounts: 'Kelola Akun'
};

// Which pages each role is allowed to reach — admin sees everything, operator
// gets Input + Dashboard + TV, visitor is read-only (Dashboard + TV only, no
// Input, no account management).
const ROLE_PAGES = {
  admin: ['input', 'dashboard', 'tv', 'accounts'],
  operator: ['input', 'dashboard', 'tv'],
  visitor: ['dashboard', 'tv']
};
// First page to land on for a role that isn't allowed on "input" (the
// hard-coded default in the nav's markup) — Dashboard is always allowed.
const ROLE_HOME_PAGE = { admin: 'input', operator: 'input', visitor: 'dashboard' };

const App = {
  currentPage: 'input',

  init() {
    AuthUI.init();
    InputForm.init();
    Dashboard.init();
    TvBoard.init();
    initHamburgerNav((target) => this.handleNavigate(target));
    this.initVersionBadge();

    const user = Session.getUser();
    const token = Session.getToken();
    if (user && token) {
      this.enterApp();
    } else {
      this.showAuth();
    }
  },

  // Nav-drawer version label: reads APP_VERSION straight from whichever
  // service worker is currently controlling the page (see the 'message'
  // handler in service-worker.js), so it can never drift out of sync with
  // the actual cached version like a hand-copied number could. Tapping it
  // re-checks GitHub Pages for a newer service-worker.js and, if one is
  // found and takes over, reloads automatically.
  initVersionBadge() {
    const btn = document.getElementById('nav-version-btn');
    const label = document.getElementById('nav-version-text');
    if (!btn || !label || !('serviceWorker' in navigator)) {
      if (btn) btn.hidden = true;
      return;
    }

    const askControllerForVersion = () => new Promise((resolve) => {
      if (!navigator.serviceWorker.controller) { resolve(null); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data && e.data.version);
      };
      navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });

    const showVersion = async () => {
      const version = await askControllerForVersion();
      label.textContent = version ? `Versi ${version}` : 'Versi —';
    };

    // The controller may not exist yet on a brand-new install until it
    // claims this page, so ask again once that happens.
    showVersion();
    navigator.serviceWorker.addEventListener('controllerchange', showVersion);

    btn.addEventListener('click', async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('Service worker belum aktif.', 'error'); return; }

      btn.classList.add('checking');
      label.textContent = 'Mengecek update…';

      let updateFound = false;
      const onUpdateFound = () => {
        updateFound = true;
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'activated') {
            toast('Update ditemukan, memuat ulang…', 'success');
            setTimeout(() => window.location.reload(), 700);
          }
        });
      };
      reg.addEventListener('updatefound', onUpdateFound);

      try {
        await reg.update();
      } catch (e) {
        // ignore — handled by the timeout fallback below
      }

      setTimeout(() => {
        reg.removeEventListener('updatefound', onUpdateFound);
        btn.classList.remove('checking');
        if (!updateFound) {
          toast('Sudah pakai versi terbaru.', 'info');
          showVersion();
        }
      }, 2500);
    });
  },

  showAuth() {
    document.getElementById('view-auth').hidden = false;
    document.getElementById('view-app').hidden = true;
    AuthUI.showLogin();
  },

  enterApp() {
    const user = Session.getUser();
    document.getElementById('view-auth').hidden = true;
    document.getElementById('view-app').hidden = false;
    document.getElementById('current-username').textContent = user ? user.username : '-';

    const role = (user && ROLE_PAGES[user.role]) ? user.role : 'visitor';
    document.getElementById('nav-role-badge').textContent = (typeof ROLE_LABELS !== 'undefined' && ROLE_LABELS[role]) || role;

    // Show only the nav items this role is allowed to open — Input Data is
    // hidden for visitor, Kelola Akun only ever shows for admin.
    const allowed = ROLE_PAGES[role];
    document.querySelectorAll('.nav-item[data-target]').forEach((btn) => {
      btn.hidden = allowed.indexOf(btn.dataset.target) === -1;
    });

    this.goToPage(allowed.indexOf('dashboard') !== -1 ? 'dashboard' : allowed[0]);
  },

  handleNavigate(target) {
    this.goToPage(target);
  },

  goToPage(target) {
    const user = Session.getUser();
    const role = (user && ROLE_PAGES[user.role]) ? user.role : 'visitor';
    if (ROLE_PAGES[role].indexOf(target) === -1) target = ROLE_HOME_PAGE[role] || 'dashboard';

    if (this.currentPage === 'tv' && target !== 'tv') TvBoard.stop();

    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    const pageEl = document.getElementById(`page-${target}`);
    if (pageEl) pageEl.classList.add('active');

    document.querySelectorAll('.nav-item[data-target]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.target === target);
    });

    document.getElementById('page-title').textContent = PAGE_TITLES[target] || 'Monitoring Reject';
    this.currentPage = target;

    if (target === 'dashboard') Dashboard.refresh();
    if (target === 'accounts') AccountsPage.load();
    if (target === 'tv') TvBoard.start();
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
