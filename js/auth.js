/**
 * MONITORING REJECT — login, register, logout, and the admin
 * "Kelola Akun" (account approval) page.
 */

const AuthUI = {
  loginCard: null,
  registerCard: null,

  init() {
    this.loginCard = document.getElementById('login-card');
    this.registerCard = document.getElementById('register-card');

    document.getElementById('btn-show-register').addEventListener('click', () => this.showRegister());
    document.getElementById('btn-show-login').addEventListener('click', () => this.showLogin());

    document.getElementById('form-login').addEventListener('submit', (e) => this.handleLogin(e));
    document.getElementById('form-register').addEventListener('submit', (e) => this.handleRegister(e));

    document.getElementById('btn-logout').addEventListener('click', () => this.handleLogout());
    document.getElementById('btn-logout-drawer').addEventListener('click', () => this.handleLogout());

    document.getElementById('current-username').addEventListener('click', () => this.openChangePassword());
    document.getElementById('btn-cp-cancel').addEventListener('click', () => this.closeChangePassword());
    document.getElementById('modal-backdrop').addEventListener('click', () => this.closeChangePassword());
    document.getElementById('form-change-password').addEventListener('submit', (e) => this.handleChangePassword(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeChangePassword();
    });
  },

  openChangePassword() {
    document.getElementById('form-change-password').reset();
    hideMessage(document.getElementById('cp-error'));
    hideMessage(document.getElementById('cp-success'));
    document.getElementById('modal-backdrop').hidden = false;
    document.getElementById('modal-change-password').hidden = false;
  },
  closeChangePassword() {
    document.getElementById('modal-backdrop').hidden = true;
    document.getElementById('modal-change-password').hidden = true;
  },

  async handleChangePassword(e) {
    e.preventDefault();
    const errorEl = document.getElementById('cp-error');
    const successEl = document.getElementById('cp-success');
    hideMessage(errorEl);
    hideMessage(successEl);

    const oldPassword = document.getElementById('cp-old').value;
    const newPassword = document.getElementById('cp-new').value;
    const newPassword2 = document.getElementById('cp-new2').value;

    if (newPassword.length < 6) {
      showMessage(errorEl, 'Password baru minimal 6 karakter.', 'error');
      return;
    }
    if (newPassword !== newPassword2) {
      showMessage(errorEl, 'Konfirmasi password baru tidak cocok.', 'error');
      return;
    }

    const btn = document.getElementById('btn-cp-submit');
    setButtonLoading(btn, true);
    const res = await Api.changePassword(oldPassword, newPassword);
    setButtonLoading(btn, false);

    if (!res.ok) {
      const map = {
        invalid_old_password: 'Password lama salah.',
        password_too_short: 'Password baru minimal 6 karakter.'
      };
      showMessage(errorEl, map[res.error] || 'Gagal mengganti password.', 'error');
      return;
    }

    showMessage(successEl, 'Password berhasil diganti.', 'success');
    toast('Password berhasil diganti.', 'success');
    setTimeout(() => this.closeChangePassword(), 900);
  },

  showRegister() {
    this.loginCard.hidden = true;
    this.registerCard.hidden = false;
  },
  showLogin() {
    this.registerCard.hidden = true;
    this.loginCard.hidden = false;
  },

  async handleLogin(e) {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    hideMessage(errorEl);
    hideMessage(successEl);

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) {
      showMessage(errorEl, 'Username dan password wajib diisi.', 'error');
      return;
    }

    const btn = document.getElementById('btn-login-submit');
    setButtonLoading(btn, true);
    const res = await Api.login(username, password);
    setButtonLoading(btn, false);

    if (!res.ok) {
      showMessage(errorEl, mapAuthError(res.error), 'error');
      return;
    }

    Session.setToken(res.token);
    Session.setUser({ username: res.username, role: res.role });
    App.enterApp();
  },

  async handleRegister(e) {
    e.preventDefault();
    const errorEl = document.getElementById('register-error');
    const successEl = document.getElementById('register-success');
    hideMessage(errorEl);
    hideMessage(successEl);

    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const password2 = document.getElementById('register-password2').value;

    if (username.length < 3) {
      showMessage(errorEl, 'Username minimal 3 karakter.', 'error');
      return;
    }
    if (password.length < 6) {
      showMessage(errorEl, 'Password minimal 6 karakter.', 'error');
      return;
    }
    if (password !== password2) {
      showMessage(errorEl, 'Konfirmasi password tidak cocok.', 'error');
      return;
    }

    const btn = document.getElementById('btn-register-submit');
    setButtonLoading(btn, true);
    const res = await Api.register(username, password);
    setButtonLoading(btn, false);

    if (!res.ok) {
      showMessage(errorEl, mapAuthError(res.error), 'error');
      return;
    }

    showMessage(successEl, 'Akun berhasil dibuat. Tunggu persetujuan admin sebelum login.', 'success');
    document.getElementById('form-register').reset();
  },

  handleLogout() {
    Session.clearAll();
    App.showAuth();
    toast('Berhasil keluar.', 'info');
  }
};

function mapAuthError(code) {
  const map = {
    invalid_username: 'Username tidak valid.',
    password_too_short: 'Password minimal 6 karakter.',
    username_taken: 'Username sudah digunakan.',
    invalid_credentials: 'Username atau password salah.',
    account_pending: 'Akun masih menunggu persetujuan admin.',
    account_rejected: 'Akun ini ditolak. Hubungi admin.',
    network_error: 'Tidak bisa terhubung ke server. Periksa koneksi internet.',
    bad_response: 'Respons server tidak valid.'
  };
  return map[code] || 'Terjadi kesalahan. Coba lagi.';
}

// ---------- Accounts page (admin only) ----------
const ROLE_LABELS = { admin: 'Admin', operator: 'Operator', visitor: 'Visitor' };

function roleSelectHtml(selected) {
  return Object.keys(ROLE_LABELS)
    .map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)
    .join('');
}

const AccountsPage = {
  async load() {
    const pendingList = document.getElementById('pending-list');
    const emptyPending = document.getElementById('empty-pending');
    const allList = document.getElementById('all-users-list');

    pendingList.innerHTML = '';
    allList.innerHTML = '';

    const [pendingRes, allRes] = await Promise.all([Api.listPendingUsers(), Api.listUsers()]);

    if (pendingRes.ok) {
      if (pendingRes.users.length === 0) {
        emptyPending.hidden = false;
      } else {
        emptyPending.hidden = true;
        pendingRes.users.forEach((u) => pendingList.appendChild(this.renderPendingRow(u)));
      }
    }

    if (allRes.ok) {
      allRes.users.forEach((u) => allList.appendChild(this.renderUserRow(u)));
    }
  },

  renderPendingRow(u) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <div>
        <div class="acc-name">${escapeHtml(u.username)}</div>
        <div class="acc-meta">Daftar: ${escapeHtml(u.createdAt || '-')}</div>
      </div>
      <div class="acc-actions">
        <select class="role-select" data-user="${escapeHtml(u.username)}">${roleSelectHtml(u.role || 'operator')}</select>
        <button class="btn-approve" data-user="${escapeHtml(u.username)}">Setujui</button>
        <button class="btn-deny" data-user="${escapeHtml(u.username)}">Tolak</button>
      </div>
    `;
    row.querySelector('.btn-approve').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const role = row.querySelector('.role-select').value;
      const res = await Api.approveUser(u.username, role);
      if (res.ok) {
        toast(`Akun "${u.username}" disetujui sebagai ${ROLE_LABELS[role]}.`, 'success');
        AccountsPage.load();
      } else {
        toast('Gagal menyetujui akun.', 'error');
        e.currentTarget.disabled = false;
      }
    });
    row.querySelector('.btn-deny').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const res = await Api.rejectUser(u.username);
      if (res.ok) {
        toast(`Akun "${u.username}" ditolak.`, 'info');
        AccountsPage.load();
      } else {
        toast('Gagal menolak akun.', 'error');
        e.currentTarget.disabled = false;
      }
    });
    return row;
  },

  renderUserRow(u) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const statusBadge = `<span class="badge badge-${u.status}">${u.status}</span>`;
    row.innerHTML = `
      <div>
        <div class="acc-name">${escapeHtml(u.username)}</div>
        <div class="acc-meta">Dibuat: ${escapeHtml(u.createdAt || '-')}</div>
      </div>
      <div class="acc-actions">
        ${statusBadge}
        <select class="role-select" data-user="${escapeHtml(u.username)}" ${u.status !== 'approved' ? 'disabled' : ''}>${roleSelectHtml(u.role)}</select>
      </div>
    `;
    const select = row.querySelector('.role-select');
    if (u.status === 'approved') {
      select.addEventListener('change', async () => {
        const newRole = select.value;
        select.disabled = true;
        const res = await Api.setUserRole(u.username, newRole);
        select.disabled = false;
        if (res.ok) {
          toast(`Role "${u.username}" diubah jadi ${ROLE_LABELS[newRole]}.`, 'success');
        } else {
          toast('Gagal mengubah role.', 'error');
          select.value = u.role; // revert the dropdown on failure
        }
      });
    }
    return row;
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
