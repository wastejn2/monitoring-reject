/**
 * MONITORING REJECT — Input Data Reject page
 * Cascading dropdown rules (mirrored on the backend for validation):
 *   Divisi = Biscuit -> Plant: Stage 1 / Stage 2
 *     Stage 1 -> Line: 1.1, 2.1, 3.1, 4.1, 5.1
 *     Stage 2 -> Line: 1.2, 2.2, 3.2, 4.2, 5.2
 *   Divisi = Wafer -> Plant: Waferstick / Waferflat
 *     Waferstick -> Line: Line 1 WS ... Line 9 WS
 *     Waferflat  -> Line: Line 1 WF ... Line 14 WF
 */

function genLines(prefix, suffix, from, to) {
  const arr = [];
  for (let i = from; i <= to; i++) arr.push(`${prefix}${i}${suffix}`);
  return arr;
}

const LINE_CONFIG = {
  Biscuit: {
    'Stage 1': ['1.1', '2.1', '3.1', '4.1', '5.1'],
    'Stage 2': ['1.2', '2.2', '3.2', '4.2', '5.2']
  },
  Wafer: {
    Waferstick: genLines('Line ', ' WS', 1, 9),
    Waferflat: genLines('Line ', ' WF', 1, 14)
  }
};

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
    this.els.divisi = document.getElementById('input-divisi');
    this.els.groupPlant = document.getElementById('group-plant');
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

    this.els.divisi.addEventListener('change', () => this.onDivisiChange());
    this.els.plant.addEventListener('change', () => this.onPlantChange());
    this.els.form.addEventListener('submit', (e) => this.onSubmit(e));
    this.els.form.addEventListener('reset', () => setTimeout(() => this.resetCascade(), 0));
  },

  fillSelect(select, options, placeholder) {
    select.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
      options.map((o) => `<option value="${o}">${o}</option>`).join('');
  },

  onDivisiChange() {
    const divisi = this.els.divisi.value;
    const plants = LINE_CONFIG[divisi] ? Object.keys(LINE_CONFIG[divisi]) : [];
    if (plants.length) {
      this.fillSelect(this.els.plant, plants, 'Pilih Plant...');
      this.els.groupPlant.hidden = false;
    } else {
      this.els.groupPlant.hidden = true;
    }
    this.els.groupLine.hidden = true;
    this.els.line.innerHTML = '<option value="" disabled selected>Pilih Line...</option>';
  },

  onPlantChange() {
    const divisi = this.els.divisi.value;
    const plant = this.els.plant.value;
    const lines = (LINE_CONFIG[divisi] && LINE_CONFIG[divisi][plant]) || [];
    if (lines.length) {
      this.fillSelect(this.els.line, lines, 'Pilih Line...');
      this.els.groupLine.hidden = false;
    } else {
      this.els.groupLine.hidden = true;
    }
  },

  resetCascade() {
    this.els.groupPlant.hidden = true;
    this.els.groupLine.hidden = true;
    this.els.plant.innerHTML = '<option value="" disabled selected>Pilih Plant...</option>';
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
    const divisi = this.els.divisi.value;
    const plant = this.els.plant.value;
    const line = this.els.line.value;
    const outputRaw = this.els.output.value;
    const rejectRaw = this.els.reject.value;

    if (!tanggal || !shift || !divisi || !plant || !line || outputRaw === '' || rejectRaw === '') {
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
      tanggal, shift, divisi, plant, line,
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

    // Keep Tanggal/Shift/Divisi/Plant (common case: logging several lines in
    // a row for the same shift), just clear Line + numbers for the next entry.
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
    invalid_combo: 'Kombinasi Divisi/Plant/Line tidak valid.',
    invalid_output: 'Output produksi tidak valid.',
    invalid_reject: 'Total reject tidak valid.',
    reject_exceeds_output: 'Total reject tidak boleh lebih besar dari output produksi.',
    network_error: 'Tidak bisa terhubung ke server.'
  };
  return map[code] || 'Gagal menyimpan data. Coba lagi.';
}
