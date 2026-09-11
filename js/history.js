/**
 * MONITORING REJECT — Riwayat Data page (admin only)
 * Browses the raw RejectData rows (same filters as Dashboard, but this one
 * targets individual rows) and lets an admin fix a mistyped entry or remove
 * a bad one outright. Edits/deletes go straight through to the Google
 * Sheet via updateRawData/deleteRawData — there's no undo, hence the
 * confirmation modal before a delete actually fires.
 */

const HistoryPage = {
  msPlant: null,
  msLine: null,
  rows: [],
  pendingDeleteId: null,

  init() {
    this.els = {
      start: document.getElementById('hist-filter-start'),
      end: document.getElementById('hist-filter-end'),
      applyBtn: document.getElementById('btn-hist-apply'),
      resetBtn: document.getElementById('btn-hist-reset'),
      count: document.getElementById('hist-count'),
      tableBody: document.getElementById('table-history-body'),
      emptyState: document.getElementById('empty-history'),

      editModal: document.getElementById('modal-edit-history'),
      editForm: document.getElementById('form-edit-history'),
      ehId: document.getElementById('eh-id'),
      ehTanggal: document.getElementById('eh-tanggal'),
      ehShift: document.getElementById('eh-shift'),
      ehPlant: document.getElementById('eh-plant'),
      ehLine: document.getElementById('eh-line'),
      ehOutput: document.getElementById('eh-output'),
      ehReject: document.getElementById('eh-reject'),
      ehGroupRejectTotal: document.getElementById('eh-group-reject-total'),
      ehGroupRejectSubdept: document.getElementById('eh-group-reject-subdept'),
      ehRejectProses: document.getElementById('eh-reject-proses'),
      ehRejectPackaging: document.getElementById('eh-reject-packing'),
      ehSubdeptTotal: document.getElementById('eh-subdept-total'),
      ehError: document.getElementById('eh-error'),
      ehSubmitBtn: document.getElementById('btn-eh-submit'),
      ehCancelBtn: document.getElementById('btn-eh-cancel'),

      confirmModal: document.getElementById('modal-confirm-delete'),
      cdMessage: document.getElementById('cd-message'),
      cdConfirmBtn: document.getElementById('btn-cd-confirm'),
      cdCancelBtn: document.getElementById('btn-cd-cancel')
    };

    this.msPlant = createMultiSelect(document.getElementById('hist-ms-plant'), allPlantOptions());
    this.msLine = createMultiSelect(document.getElementById('hist-ms-line'), allLineOptions());
    this.msPlant.onChange((selectedPlant) => {
      this.msLine.setOptions(lineOptionsForPlant(selectedPlant));
    });

    this.els.applyBtn.addEventListener('click', () => this.load());
    this.els.resetBtn.addEventListener('click', () => {
      this.els.start.value = '';
      this.els.end.value = '';
      this.msPlant.reset();
      this.msPlant.setOptions(allPlantOptions());
      this.msLine.reset();
      this.msLine.setOptions(allLineOptions());
      this.load();
    });

    this.els.ehPlant.addEventListener('change', () => {
      this.fillLineOptionsForEdit();
      this.applyEditSubdeptVisibility();
    });
    this.els.ehOutput.addEventListener('input', () => this.updateEditSubdeptTotalHint());
    this.els.ehRejectProses.addEventListener('input', () => this.updateEditSubdeptTotalHint());
    this.els.ehRejectPackaging.addEventListener('input', () => this.updateEditSubdeptTotalHint());
    this.els.editForm.addEventListener('submit', (e) => this.onEditSubmit(e));
    this.els.ehCancelBtn.addEventListener('click', () => this.closeEditModal());

    this.els.cdCancelBtn.addEventListener('click', () => this.closeConfirmModal());
    this.els.cdConfirmBtn.addEventListener('click', () => this.confirmDelete());

    // Same shared backdrop as the change-password modal — each modal's own
    // listener just closes itself, so they coexist without stepping on
    // each other regardless of which one (if any) is actually open.
    document.getElementById('modal-backdrop').addEventListener('click', () => {
      this.closeEditModal();
      this.closeConfirmModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeEditModal();
        this.closeConfirmModal();
      }
    });
  },

  async load() {
    setButtonLoading(this.els.applyBtn, true);
    const res = await Api.listRawData({
      startDate: this.els.start.value,
      endDate: this.els.end.value,
      plant: this.msPlant.getSelected(),
      line: this.msLine.getSelected()
    });
    setButtonLoading(this.els.applyBtn, false);

    if (!res.ok) {
      toast(res.error === 'unauthorized' ? 'Sesi berakhir, silakan login kembali.' : 'Gagal memuat riwayat data.', 'error');
      return;
    }

    this.rows = res.rows;
    this.render();
  },

  render() {
    this.els.count.textContent = this.rows.length;
    this.els.emptyState.hidden = this.rows.length > 0;
    this.els.tableBody.innerHTML = '';
    this.rows.forEach((r) => this.els.tableBody.appendChild(this.renderRow(r)));
  },

  renderRow(r) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.tanggal)}</td>
      <td>Shift ${escapeHtml(String(r.shift))}</td>
      <td>${escapeHtml(r.plant)}</td>
      <td>${escapeHtml(r.line)}</td>
      <td>${formatNumberID(r.output, 2)}</td>
      <td>${formatNumberID(r.reject, 2)}</td>
      <td>${formatNumberID(r.rejectPct, 2)}%</td>
      <td>${escapeHtml(r.inputBy || '-')}</td>
      <td class="hist-actions">
        <button type="button" class="btn-icon btn-edit-row" title="Edit">✏️</button>
        <button type="button" class="btn-icon btn-delete-row" title="Hapus">🗑️</button>
      </td>
    `;
    tr.querySelector('.btn-edit-row').addEventListener('click', () => this.openEditModal(r));
    tr.querySelector('.btn-delete-row').addEventListener('click', () => this.openConfirmModal(r));
    return tr;
  },

  fillLineOptionsForEdit() {
    const plant = this.els.ehPlant.value;
    const lines = PLANT_CONFIG[plant] || [];
    this.els.ehLine.innerHTML = lines.map((l) => `<option value="${l}">${l}</option>`).join('');
  },

  openEditModal(r) {
    hideMessage(this.els.ehError);
    this.els.ehId.value = r.id;
    this.els.ehTanggal.value = r.tanggal;
    this.els.ehShift.value = String(r.shift);
    this.els.ehPlant.value = r.plant;
    this.fillLineOptionsForEdit();
    this.els.ehLine.value = r.line;
    this.els.ehOutput.value = r.output;
    this.els.ehReject.value = r.reject;
    this.els.ehRejectProses.value = r.rejectProses || '';
    this.els.ehRejectPackaging.value = r.rejectPackaging || '';
    this.applyEditSubdeptVisibility();
    document.getElementById('modal-backdrop').hidden = false;
    this.els.editModal.hidden = false;
  },

  closeEditModal() {
    document.getElementById('modal-backdrop').hidden = true;
    this.els.editModal.hidden = true;
  },

  // 1112/1113 rows enter/edit as Reject Proses + Reject Packing, exactly
  // like the Input Data page — mirrors InputForm.onPlantChange so editing
  // an existing row never sends the old-style totalReject shape the backend
  // no longer accepts for those two Plants.
  applyEditSubdeptVisibility() {
    const subdept = plantHasSubDept(this.els.ehPlant.value);
    this.els.ehGroupRejectTotal.hidden = subdept;
    this.els.ehGroupRejectSubdept.hidden = !subdept;
    this.els.ehSubdeptTotal.hidden = !subdept;
    this.updateEditSubdeptTotalHint();
  },

  updateEditSubdeptTotalHint() {
    if (this.els.ehGroupRejectSubdept.hidden) return;
    const proses = parseFloat(this.els.ehRejectProses.value);
    const packaging = parseFloat(this.els.ehRejectPackaging.value);
    const total = (isNaN(proses) ? 0 : proses) + (isNaN(packaging) ? 0 : packaging);
    this.els.ehSubdeptTotal.innerHTML = `Total Reject: <b>${formatNumberID(total, 3)}</b> Kg`;
  },

  async onEditSubmit(e) {
    e.preventDefault();
    hideMessage(this.els.ehError);

    const id = this.els.ehId.value;
    const tanggal = this.els.ehTanggal.value;
    const shift = this.els.ehShift.value;
    const plant = this.els.ehPlant.value;
    const line = this.els.ehLine.value;
    const output = parseFloat(this.els.ehOutput.value);
    const subdept = plantHasSubDept(plant);

    if (!tanggal || !shift || !plant || !line || isNaN(output) || output < 0) {
      showMessage(this.els.ehError, 'Semua field wajib diisi dengan benar.', 'error');
      return;
    }

    // Mirrors InputForm.onSubmit's branching — resolveRejectFigures_ on the
    // backend applies the exact same logic, this is just for fast feedback.
    let reject;
    const payload = { id, tanggal, shift, plant, line, outputProduksi: output };
    if (subdept) {
      const rejectProses = parseFloat(this.els.ehRejectProses.value);
      const rejectPackaging = parseFloat(this.els.ehRejectPackaging.value);
      if (isNaN(rejectProses) || rejectProses < 0 || isNaN(rejectPackaging) || rejectPackaging < 0) {
        showMessage(this.els.ehError, 'Angka tidak valid.', 'error');
        return;
      }
      reject = rejectProses + rejectPackaging;
      payload.rejectProses = rejectProses;
      payload.rejectPackaging = rejectPackaging;
    } else {
      reject = parseFloat(this.els.ehReject.value);
      if (isNaN(reject) || reject < 0) {
        showMessage(this.els.ehError, 'Angka tidak valid.', 'error');
        return;
      }
      payload.totalReject = reject;
    }
    if (reject > output) {
      showMessage(this.els.ehError, 'Total reject tidak boleh lebih besar dari output produksi.', 'error');
      return;
    }

    setButtonLoading(this.els.ehSubmitBtn, true);
    const res = await Api.updateRawData(payload);
    setButtonLoading(this.els.ehSubmitBtn, false);

    if (!res.ok) {
      showMessage(this.els.ehError, mapSubmitError(res.error), 'error');
      return;
    }

    toast('Data berhasil diperbarui.', 'success');
    this.closeEditModal();
    this.load();
  },

  openConfirmModal(r) {
    this.pendingDeleteId = r.id;
    this.els.cdMessage.textContent =
      `Hapus data ${r.tanggal} — Shift ${r.shift} — ${r.plant} / ${r.line} (Reject ${formatNumberID(r.reject, 2)} Kg)? ` +
      `Data akan dihapus permanen dari Sheet dan tidak bisa dikembalikan.`;
    document.getElementById('modal-backdrop').hidden = false;
    this.els.confirmModal.hidden = false;
  },

  closeConfirmModal() {
    document.getElementById('modal-backdrop').hidden = true;
    this.els.confirmModal.hidden = true;
    this.pendingDeleteId = null;
  },

  async confirmDelete() {
    if (!this.pendingDeleteId) return;
    const id = this.pendingDeleteId;
    this.els.cdConfirmBtn.disabled = true;
    const res = await Api.deleteRawData(id);
    this.els.cdConfirmBtn.disabled = false;

    if (!res.ok) {
      toast('Gagal menghapus data.', 'error');
      return;
    }

    toast('Data berhasil dihapus.', 'success');
    this.closeConfirmModal();
    this.load();
  }
};
