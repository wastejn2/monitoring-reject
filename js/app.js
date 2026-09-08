/**
 * MONITORING REJECT — app bootstrap: wires auth, hamburger nav, and pages
 * together, and decides which screen to show on load.
 */

const PAGE_TITLES = {
  input: 'Input Data Reject',
  dashboard: 'Dashboard',
  accounts: 'Kelola Akun'
};

const App = {
  currentPage: 'input',

  init() {
    AuthUI.init();
    InputForm.init();
    Dashboard.init();
    initHamburgerNav((target) => this.handleNavigate(target));

    const user = Session.getUser();
    const token = Session.getToken();
    if (user && token) {
      this.enterApp();
    } else {
      this.showAuth();
    }
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
    document.getElementById('nav-role-badge').textContent = user ? user.role : 'user';

    const isAdmin = user && user.role === 'admin';
    document.getElementById('nav-accounts').hidden = !isAdmin;

    this.goToPage('input');
  },

  handleNavigate(target) {
    this.goToPage(target);
  },

  goToPage(target) {
    const user = Session.getUser();
    if (target === 'accounts' && !(user && user.role === 'admin')) target = 'input';

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
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
