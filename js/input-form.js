/**
 * MONITORING REJECT — Input Data Reject page
 * Plant -> Line cascade (mirrored on the backend for validation).
 * Plant codes: 1111 Waferflat, 1111 Waferstick, 1112, 1113.
 */

function genLines(prefix, suffix, from, to) {
  const arr = [];
  for (let i = from; i <= to; i++) arr.push(`${prefix}${i}${suffix}`);
  return arr;
}

const PLANT_CONFIG = {
  '1111 Waferflat': genLines('Line ', ' WF', 1, 14),
  '1111 Waferstick': genLines('Line ', ' WS', 1, 9),
  '1112': genLines('Line ', '.1', 1, 5),
  '1113': genLines('Line ', '.2', 1, 5)
};

// Explicit display order. IMPORTANT: do NOT use Object.keys(PLANT_CONFIG)
// for anything user-facing — '1112'/'1113' are numeric-looking keys, and JS
// silently reorders those ahead of '1111 Waferflat'/'1111 Waferstick' in
// Object.keys() (integer-like string keys always iterate first, in
// ascending order, regardless of insertion order).
const PLANT_ORDER = ['1111 Waferflat', '1111 Waferstick', '1112', '1113'];

// Mirrors SUBDEPT_PLANTS in gas/Sheet.gs — these two Plants enter reject as
// Reject Proses + Reject Packing instead of one Total (backend computes and
// validates Total the same way regardless, this just decides which fields
// the form shows/sends).
const SUBDEPT_PLANTS = ['1112', '1113'];
function plantHasSubDept(plant) {
  return SUBDEPT_PLANTS.indexOf(plant) !== -1;
}

function hasMaxDecimals(value, max) {
  const str = String(value);
  const parts = str.split('.');
  return !parts[1] || parts[1].length <= max;
}

const InputForm = {
  els: {},

  init() {
    this.els.form = document.getElementById('form-input-reject');
    this.els.tanggal = document.getElementById('input-tanggal');
    this.els.shift = document.getElementById('input-shift');
    this.els.plant = document.getElementById('input-plant');
    this.els.groupLine = document.getElementById('group-line');
    this.els.line = document.getElementById('input-line');
    this.els.output = document.getElementById('input-output');
    this.els.reject = document.getElementById('input-reject');
    this.els.groupRejectTotal = document.getElementById('group-reject-total');
    this.els.groupRejectSubdept = document.getElementById('group-reject-subdept');
    this.els.rejectProses = document.getElementById('input-reject-proses');
    this.els.rejectPackaging = document.getElementById('input-reject-packing');
    this.els.subdeptTotalHint = document.getElementById('reject-subdept-total');
    this.els.error = document.getElementById('input-error');
    this.els.success = document.getElementById('input-success');
    this.els.submitBtn = document.getElementById('btn-input-submit');

    // default date = today
    this.els.tanggal.value = new Date().toISOString().slice(0, 10);

    this.els.plant.addEventListener('change', () => this.onPlantChange());
    this.els.output.addEventListener('input', () => this.updateSubdeptTotalHint());
    this.els.rejectProses.addEventListener('input', () => this.updateSubdeptTotalHint());
    this.els.rejectPackaging.addEventListener('input', () => this.updateSubdeptTotalHint());
    this.els.form.addEventListener('submit', (e) => this.onSubmit(e));
    this.els.form.addEventListener('reset', () => setTimeout(() => this.resetCascade(), 0));
  },

  fillSelect(select, options, placeholder) {
    select.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
      options.map((o) => `<option value="${o}">${o}</option>`).join('');
  },

  onPlantChange() {
    const plant = this.els.plant.value;
    const lines = PLANT_CONFIG[plant] || [];
    if (lines.length) {
      this.fillSelect(this.els.line, lines, 'Pilih Line...');
      this.els.groupLine.hidden = false;
    } else {
      this.els.groupLine.hidden = true;
    }

    // 1112/1113: Total Reject is computed from Proses + Packing, never
    // typed directly — swap which field group is shown/required. Values
    // left over in the field(s) being hidden are cleared so a stray number
    // from before a Plant switch never silently rides along into a submit
    // it no longer applies to.
    const subdept = plantHasSubDept(plant);
    this.els.groupRejectTotal.hidden = subdept;
    this.els.groupRejectSubdept.hidden = !subdept;
    this.els.subdeptTotalHint.hidden = !subdept;
    if (subdept) {
      this.els.reject.value = '';
    } else {
      this.els.rejectProses.value = '';
      this.els.rejectPackaging.value = '';
    }
    this.updateSubdeptTotalHint();
  },

  // Live "Total Reject: X Kg" readout while typing Proses/Packing — Total
  // itself is never a field the user types into for these two Plants, so
  // this is the only place they see it before actually submitting.
  updateSubdeptTotalHint() {
    if (this.els.groupRejectSubdept.hidden) return;
    const proses = parseFloat(this.els.rejectProses.value);
    const packaging = parseFloat(this.els.rejectPackaging.value);
    const total = (isNaN(proses) ? 0 : proses) + (isNaN(packaging) ? 0 : packaging);
    this.els.subdeptTotalHint.innerHTML = `Total Reject: <b>${formatNumberID(total, 3)}</b> Kg`;
  },

  resetCascade() {
    this.els.groupLine.hidden = true;
    this.els.line.innerHTML = '<option value="" disabled selected>Pilih Line...</option>';
    this.els.tanggal.value = new Date().toISOString().slice(0, 10);
    this.els.groupRejectTotal.hidden = false;
    this.els.groupRejectSubdept.hidden = true;
    this.els.subdeptTotalHint.hidden = true;
    this.els.rejectProses.value = '';
    this.els.rejectPackaging.value = '';
    hideMessage(this.els.error);
    hideMessage(this.els.success);
  },

  async onSubmit(e) {
    e.preventDefault();
    hideMessage(this.els.error);
    hideMessage(this.els.success);

    const tanggal = this.els.tanggal.value;
    const shift = this.els.shift.value;
    const plant = this.els.plant.value;
    const line = this.els.line.value;
    const outputRaw = this.els.output.value;
    const subdept = plantHasSubDept(plant);
    const rejectRaw = this.els.reject.value;
    const prosesRaw = this.els.rejectProses.value;
    const packagingRaw = this.els.rejectPackaging.value;

    if (!tanggal || !shift || !plant || !line || outputRaw === '') {
      showMessage(this.els.error, 'Semua field wajib diisi.', 'error');
      return;
    }
    if (subdept ? (prosesRaw === '' || packagingRaw === '') : rejectRaw === '') {
      showMessage(this.els.error, 'Semua field wajib diisi.', 'error');
      return;
    }
    const decimalFields = subdept ? [outputRaw, prosesRaw, packagingRaw] : [outputRaw, rejectRaw];
    if (decimalFields.some((v) => !hasMaxDecimals(v, 3))) {
      showMessage(this.els.error, 'Desimal maksimal 3 angka di belakang koma.', 'error');
      return;
    }
    const output = parseFloat(outputRaw);
    if (isNaN(output) || output < 0) {
      showMessage(this.els.error, 'Angka tidak valid.', 'error');
      return;
    }

    // payload/reject start as the non-Sub-Dept shape and get overridden
    // below for 1112/1113 — resolveRejectFigures_ on the backend applies
    // the exact same branching, so validation here is just for fast
    // feedback, not the source of truth.
    let reject = parseFloat(rejectRaw);
    const payload = { tanggal, shift, plant, line, outputProduksi: output };
    if (subdept) {
      const rejectProses = parseFloat(prosesRaw);
      const rejectPackaging = parseFloat(packagingRaw);
      if (isNaN(rejectProses) || rejectProses < 0 || isNaN(rejectPackaging) || rejectPackaging < 0) {
        showMessage(this.els.error, 'Angka tidak valid.', 'error');
        return;
      }
      reject = rejectProses + rejectPackaging;
      payload.rejectProses = rejectProses;
      payload.rejectPackaging = rejectPackaging;
    } else {
      if (isNaN(reject) || reject < 0) {
        showMessage(this.els.error, 'Angka tidak valid.', 'error');
        return;
      }
      payload.totalReject = reject;
    }
    if (reject > output) {
      showMessage(this.els.error, 'Total reject tidak boleh lebih besar dari output produksi.', 'error');
      return;
    }

    setButtonLoading(this.els.submitBtn, true);
    const res = await Api.submitReject(payload);
    setButtonLoading(this.els.submitBtn, false);

    if (!res.ok) {
      showMessage(this.els.error, mapSubmitError(res.error), 'error');
      return;
    }

    showMessage(this.els.success, `Data tersimpan. Reject: ${res.rejectPercent}%`, 'success');
    toast('Data reject berhasil disimpan.', 'success');

    // Keep Tanggal/Shift/Plant (common case: logging several lines in a row
    // for the same shift), just clear Line + numbers for the next entry.
    this.els.line.value = '';
    this.els.output.value = '';
    this.els.reject.value = '';
    this.els.rejectProses.value = '';
    this.els.rejectPackaging.value = '';
    this.updateSubdeptTotalHint();
    this.els.line.focus();
  }
};

function mapSubmitError(code) {
  const map = {
    unauthorized: 'Sesi berakhir, silakan login kembali.',
    invalid_tanggal: 'Tanggal tidak valid.',
    invalid_shift: 'Shift tidak valid.',
    invalid_combo: 'Kombinasi Plant/Line tidak valid.',
    invalid_output: 'Output produksi tidak valid.',
    invalid_reject: 'Total reject tidak valid.',
    invalid_reject_proses: 'Reject Proses tidak valid.',
    invalid_reject_packaging: 'Reject Packing tidak valid.',
    reject_exceeds_output: 'Total reject tidak boleh lebih besar dari output produksi.',
    network_error: 'Tidak bisa terhubung ke server.'
  };
  return map[code] || 'Gagal menyimpan data. Coba lagi.';
}
