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
    this.els.error = document.getElementById('input-error');
    this.els.success = document.getElementById('input-success');
    this.els.submitBtn = document.getElementById('btn-input-submit');

    // default date = today
    this.els.tanggal.value = new Date().toISOString().slice(0, 10);

    this.els.plant.addEventListener('change', () => this.onPlantChange());
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
  },

  resetCascade() {
    this.els.groupLine.hidden = true;
    this.els.line.innerHTML = '<option value="" disabled selected>Pilih Line...</option>';
    this.els.tanggal.value = new Date().toISOString().slice(0, 10);
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
    const rejectRaw = this.els.reject.value;

    if (!tanggal || !shift || !plant || !line || outputRaw === '' || rejectRaw === '') {
      showMessage(this.els.error, 'Semua field wajib diisi.', 'error');
      return;
    }
    if (!hasMaxDecimals(outputRaw, 3) || !hasMaxDecimals(rejectRaw, 3)) {
      showMessage(this.els.error, 'Desimal maksimal 3 angka di belakang koma.', 'error');
      return;
    }
    const output = parseFloat(outputRaw);
    const reject = parseFloat(rejectRaw);
    if (isNaN(output) || output < 0 || isNaN(reject) || reject < 0) {
      showMessage(this.els.error, 'Angka tidak valid.', 'error');
      return;
    }
    if (reject > output) {
      showMessage(this.els.error, 'Total reject tidak boleh lebih besar dari output produksi.', 'error');
      return;
    }

    setButtonLoading(this.els.submitBtn, true);
    const res = await Api.submitReject({
      tanggal, shift, plant, line,
      outputProduksi: output,
      totalReject: reject
    });
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
    reject_exceeds_output: 'Total reject tidak boleh lebih besar dari output produksi.',
    network_error: 'Tidak bisa terhubung ke server.'
  };
  return map[code] || 'Gagal menyimpan data. Coba lagi.';
}
