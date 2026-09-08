/**
 * MONITORING REJECT — shared UI helpers: hamburger nav, toasts,
 * multiselect-with-checkboxes component, small formatting helpers.
 */

// ---------- toasts ----------
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

// ---------- number formatting (id-ID style: 1.234,56) ----------
function formatNumberID(n, decimals = 2) {
  const num = Number(n) || 0;
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

// ---------- button loading state ----------
function setButtonLoading(btn, loading) {
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  if (spinner) spinner.hidden = !loading;
  if (label) label.style.opacity = loading ? '0.6' : '1';
}

// ---------- form message helper ----------
function showMessage(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.className = `form-message form-${type}`;
}
function hideMessage(el) {
  if (!el) return;
  el.hidden = true;
}

// ---------- password show/hide toggles (login, register, change-password) ----------
// Wired once at startup since every password field already exists statically
// in the DOM (nothing here is created dynamically later).
function initPasswordToggles() {
  document.querySelectorAll('.btn-toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.textContent = willShow ? 'Sembunyikan' : 'Lihat';
      btn.setAttribute('aria-label', willShow ? 'Sembunyikan password' : 'Tampilkan password');
    });
  });
}

// ---------- hamburger nav drawer (auto-closes itself) ----------
function initHamburgerNav(onNavigate) {
  const hamburger = document.getElementById('btn-hamburger');
  const drawer = document.getElementById('nav-drawer');
  const backdrop = document.getElementById('nav-backdrop');
  const navItems = Array.from(drawer.querySelectorAll('.nav-item[data-target]'));

  function openDrawer() {
    drawer.classList.add('open');
    backdrop.hidden = false;
    hamburger.setAttribute('aria-expanded', 'true');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.hidden = true;
    hamburger.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-hidden', 'true');
  }

  hamburger.addEventListener('click', () => {
    if (drawer.classList.contains('open')) closeDrawer();
    else openDrawer();
  });

  backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      navItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      closeDrawer(); // auto-close after navigating, as requested
      if (typeof onNavigate === 'function') onNavigate(btn.dataset.target);
    });
  });

  return { openDrawer, closeDrawer };
}

// ---------- multiselect (checkbox panel, allows picking more than one) ----------
function createMultiSelect(container, initialOptions) {
  const placeholder = container.dataset.label || 'Pilih...';
  let options = initialOptions || [];
  let selected = new Set();
  let changeCallback = null;
  let open = false;

  const summary = document.createElement('div');
  summary.className = 'ms-summary placeholder';
  summary.textContent = placeholder;

  const caret = document.createElement('span');
  caret.className = 'ms-caret';
  caret.textContent = '▾';

  container.innerHTML = '';
  container.appendChild(summary);
  container.appendChild(caret);
  container.tabIndex = 0;

  let panel = null;

  function renderSummary() {
    if (selected.size === 0) {
      summary.textContent = placeholder;
      summary.classList.add('placeholder');
    } else if (selected.size === options.length) {
      summary.textContent = placeholder.replace('Semua', 'Semua'); // e.g. "Semua Divisi"
      summary.classList.remove('placeholder');
    } else if (selected.size <= 2) {
      summary.textContent = Array.from(selected).join(', ');
      summary.classList.remove('placeholder');
    } else {
      summary.textContent = `${selected.size} dipilih`;
      summary.classList.remove('placeholder');
    }
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.className = 'ms-panel';

    const actions = document.createElement('div');
    actions.className = 'ms-panel-actions';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.textContent = 'Pilih Semua';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Bersihkan';
    actions.appendChild(selectAllBtn);
    actions.appendChild(clearBtn);
    p.appendChild(actions);

    selectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selected = new Set(options);
      syncCheckboxes();
      renderSummary();
      if (changeCallback) changeCallback(Array.from(selected));
    });
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selected.clear();
      syncCheckboxes();
      renderSummary();
      if (changeCallback) changeCallback(Array.from(selected));
    });

    options.forEach((opt) => {
      const label = document.createElement('label');
      label.className = 'ms-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = opt;
      input.checked = selected.has(opt);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(opt);
        else selected.delete(opt);
        renderSummary();
        if (changeCallback) changeCallback(Array.from(selected));
      });
      const span = document.createElement('span');
      span.textContent = opt;
      label.appendChild(input);
      label.appendChild(span);
      label.addEventListener('click', (e) => e.stopPropagation());
      p.appendChild(label);
    });

    return p;
  }

  function syncCheckboxes() {
    if (!panel) return;
    panel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(cb.value);
    });
  }

  function openPanel() {
    if (open) return;
    panel = buildPanel();
    container.appendChild(panel);
    container.classList.add('open');
    open = true;
  }
  function closePanel() {
    if (!open) return;
    if (panel) panel.remove();
    panel = null;
    container.classList.remove('open');
    open = false;
  }

  container.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closePanel();
    else openPanel();
  });
  document.addEventListener('click', (e) => {
    if (open && !container.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  renderSummary();

  return {
    getSelected: () => Array.from(selected),
    setOptions(newOptions) {
      options = newOptions || [];
      selected = new Set(Array.from(selected).filter((s) => options.indexOf(s) !== -1));
      closePanel();
      renderSummary();
    },
    reset() {
      selected.clear();
      closePanel();
      renderSummary();
    },
    onChange(cb) { changeCallback = cb; }
  };
}
