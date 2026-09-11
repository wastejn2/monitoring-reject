/**
 * MONITORING REJECT — Dashboard page: multi-select filters, KPI cards,
 * bar chart (reject per line), trend line chart, and a detail table.
 */

function allPlantOptions() {
  return PLANT_ORDER.slice();
}
function allLineOptions() {
  const set = new Set();
  Object.values(PLANT_CONFIG).forEach((lines) => lines.forEach((l) => set.add(l)));
  return Array.from(set).sort();
}

// Line options narrow down to only what's possible for the selected Plant(s)
// (all Plants if none picked yet) — same cascade idea as the input form.
function lineOptionsForPlant(selectedPlant) {
  const plantList = selectedPlant && selectedPlant.length ? selectedPlant : allPlantOptions();
  const set = new Set();
  plantList.forEach((p) => (PLANT_CONFIG[p] || []).forEach((l) => set.add(l)));
  return Array.from(set).sort();
}

// NOTE: deliberately NOT using d.toISOString() here — that formats in UTC,
// and since WIB is UTC+7, any local time between 00:00-06:59 is still
// "yesterday" in UTC, silently pushing every date back by one extra day
// during those hours. Format from the LOCAL y/m/d fields instead so the
// result always matches the calendar date shown on the device's own clock.
function toLocalISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalISODate(d);
}

// Same S1/S2/S3 palette the TV board uses, so the Dashboard's comparison
// chart reads as the same visual language once "Detail per Shift" is on.
const SHIFT_COLORS = { '1': '#d8b370', '2': '#c81e3a', '3': '#55091a' };
const SHIFT_LABELS = { '1': 'Shift 1', '2': 'Shift 2', '3': 'Shift 3' };

// low -> mid -> high color ramp, kept inside the maroon/gold palette — the
// default "Total" view's per-bar coloring (each bar's own reject level
// relative to the tallest bar on screen).
const COLOR_STOPS = [
  { t: 0, rgb: [46, 158, 88] },   // green  (rendah)
  { t: 0.5, rgb: [216, 179, 112] }, // gold  (sedang)
  { t: 1, rgb: [156, 16, 41] }    // maroon (tinggi)
];
function colorForRatio(t) {
  t = Math.max(0, Math.min(1, t));
  let a = COLOR_STOPS[0], b = COLOR_STOPS[1];
  if (t > 0.5) { a = COLOR_STOPS[1]; b = COLOR_STOPS[2]; }
  const localT = a.t === b.t ? 0 : (t - a.t) / (b.t - a.t);
  const rgb = a.rgb.map((v, i) => Math.round(v + (b.rgb[i] - v) * localT));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function aggregateByLine(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.line)) map.set(r.line, { line: r.line, plant: r.plant, output: 0, reject: 0 });
    const entry = map.get(r.line);
    entry.output += Number(r.output) || 0;
    entry.reject += Number(r.reject) || 0;
  });
  return Array.from(map.values()).map((e) => ({
    ...e,
    pct: e.output > 0 ? (e.reject / e.output) * 100 : 0
  }));
}

// Same grouping as aggregateByLine, but also splits each group's reject
// total by Shift 1/2/3 — used for BOTH comparison-chart modes: the default
// "Total" view just reads .reject (the sum), "Detail per Shift" reads
// .shift['1'/'2'/'3'] too, so a single aggregation pass covers both.
function aggregateByKeyPerShift(rows, keyField) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r[keyField];
    if (!map.has(key)) {
      const entry = { output: 0, reject: 0, shift: { '1': 0, '2': 0, '3': 0 } };
      entry[keyField] = key;
      map.set(key, entry);
    }
    const entry = map.get(key);
    const rejectVal = Number(r.reject) || 0;
    entry.output += Number(r.output) || 0;
    entry.reject += rejectVal;
    const shiftKey = String(r.shift);
    if (entry.shift[shiftKey] !== undefined) entry.shift[shiftKey] += rejectVal;
  });
  return Array.from(map.values());
}

// Draws the value on top of every bar/segment — same "number above the bar"
// style the TV board uses. When shiftTags is given (the "Semua Shift" view,
// one dataset per shift) it also stamps a small S1/S2/S3 tag near the base
// of each bar, exactly like the TV board's chart does, so the two read as
// the same visual language.
function barShiftValueLabelPlugin(shiftTags, pctByIndex) {
  return {
    id: 'barShiftValueLabel',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      chart.data.datasets.forEach((dataset, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if (meta.hidden) return;
        meta.data.forEach((bar, index) => {
          const value = dataset.data[index];
          if (!value) return;
          const barHeight = bar.base - bar.y;
          ctx.save();
          ctx.textAlign = 'center';
          ctx.fillStyle = '#3a0510';
          ctx.font = '700 11px "Segoe UI", sans-serif';
          // pctByIndex (Sub Dept bars only) adds "(X%)" of Output next to
          // the Kg value — same idea as the TV board's Trend point labels.
          const pct = pctByIndex ? pctByIndex[index] : null;
          const label = pct != null
            ? `${formatNumberID(value, 1)} (${formatNumberID(pct, 1)}%)`
            : formatNumberID(value, 1);
          ctx.fillText(label, bar.x, bar.y - 6);
          if (shiftTags && barHeight > 22) {
            ctx.fillStyle = dsIndex === 0 ? '#3a0510' : '#ffffff';
            ctx.font = '700 9.5px "Segoe UI", sans-serif';
            ctx.fillText(shiftTags[dsIndex], bar.x, bar.base - 8);
          }
          ctx.restore();
        });
      });
    }
  };
}

// Plant 1112/1113 only — groups by Sub Dept (Proses/Packing) instead of by
// Line/Plant. Rows from every other Plant are ignored even if they're mixed
// into the same filtered `rows` (Bos: "Chart Sub Dept otomatis abaikan
// Plant lain"). Output isn't split by Sub Dept, so both percentages are
// each Sub Dept's reject against the SAME combined Output — mirrors how
// the backend computes RejectProsesPercent/RejectPackingPercent per row.
function aggregateBySubDept(rows, subDeptFilter) {
  const relevant = rows.filter((r) => plantHasSubDept(r.plant));
  let sumOutput = 0, sumProses = 0, sumPacking = 0;
  relevant.forEach((r) => {
    sumOutput += Number(r.output) || 0;
    sumProses += Number(r.rejectProses) || 0;
    sumPacking += Number(r.rejectPackaging) || 0;
  });
  const all = [
    { subdept: 'Proses', label: 'Reject Proses', reject: sumProses, output: sumOutput, pct: sumOutput > 0 ? (sumProses / sumOutput) * 100 : 0 },
    { subdept: 'Packing', label: 'Reject Packing', reject: sumPacking, output: sumOutput, pct: sumOutput > 0 ? (sumPacking / sumOutput) * 100 : 0 }
  ];
  if (!subDeptFilter || !subDeptFilter.length) return all;
  return all.filter((e) => subDeptFilter.indexOf(e.subdept) !== -1);
}

// Same Plant 1112/1113-only scope as aggregateBySubDept above, but also
// splits each Sub Dept's reject by Shift 1/2/3 — feeds the exact same
// renderBarChart() the Per Line/Per Plant "Detail per Shift" view uses (it
// already knows how to draw a per-category Shift breakdown from `.shift`,
// generic over whatever `labelKey` names the category), so Sub Dept gets
// the same Shift-detail chart for free instead of a separate renderer.
// Categories here are Proses/Packing instead of Line/Plant — mirrors the TV
// board's Mode Sub Dept bar chart (S1/S2/S3 x Proses/Packing), just
// aggregated across all of 1112/1113's Lines into 2 categories instead of
// one category per Line.
function aggregateSubDeptByShift(rows, subDeptFilter) {
  const relevant = rows.filter((r) => plantHasSubDept(r.plant));
  const makeEntry = (subdept, label) => ({ subdept, label, output: 0, reject: 0, shift: { '1': 0, '2': 0, '3': 0 } });
  const proses = makeEntry('Proses', 'Reject Proses');
  const packing = makeEntry('Packing', 'Reject Packing');

  relevant.forEach((r) => {
    const shiftKey = String(r.shift);
    const out = Number(r.output) || 0;
    const p = Number(r.rejectProses) || 0;
    const k = Number(r.rejectPackaging) || 0;
    // Both entries add the SAME row's Output — a row's Output is the one
    // denominator both Proses% and Packing% are computed against (matches
    // resolveRejectFigures_ on the backend), not a split-in-half output.
    proses.output += out;
    packing.output += out;
    proses.reject += p;
    packing.reject += k;
    if (proses.shift[shiftKey] !== undefined) proses.shift[shiftKey] += p;
    if (packing.shift[shiftKey] !== undefined) packing.shift[shiftKey] += k;
  });

  const all = [proses, packing];
  if (!subDeptFilter || !subDeptFilter.length) return all;
  return all.filter((e) => subDeptFilter.indexOf(e.subdept) !== -1);
}

function aggregateByDate(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.tanggal)) map.set(r.tanggal, { tanggal: r.tanggal, output: 0, reject: 0 });
    const entry = map.get(r.tanggal);
    entry.output += Number(r.output) || 0;
    entry.reject += Number(r.reject) || 0;
  });
  return Array.from(map.values())
    .map((e) => ({ ...e, pct: e.output > 0 ? (e.reject / e.output) * 100 : 0 }))
    .sort((a, b) => (a.tanggal < b.tanggal ? -1 : 1));
}

const Dashboard = {
  msPlant: null,
  msLine: null,
  barChart: null,
  trendChart: null,
  loaded: false,
  barGroupBy: 'line', // 'line' | 'plant' — which grouping the comparison chart shows
  shiftDetailOn: false, // off (default) = original single Total-per-category bar; on = per-shift breakdown like the TV board
  shiftFilter: 'all', // 'all' | '1' | '2' | '3' — only matters while shiftDetailOn is true
  lastRows: [],

  init() {
    this.els = {
      start: document.getElementById('filter-start'),
      end: document.getElementById('filter-end'),
      applyBtn: document.getElementById('btn-filter-apply'),
      resetBtn: document.getElementById('btn-filter-reset'),
      kpiOutput: document.getElementById('kpi-output'),
      kpiReject: document.getElementById('kpi-reject'),
      kpiPct: document.getElementById('kpi-pct'),
      barCanvas: document.getElementById('chart-bar'),
      barTitle: document.getElementById('chart-bar-title'),
      barHint: document.getElementById('chart-bar-hint'),
      barGroupButtons: Array.from(document.querySelectorAll('#bar-groupby-toggle .seg-btn')),
      btnGroupSubdept: document.getElementById('btn-group-subdept'),
      barDetailToggle: document.getElementById('bar-detail-toggle'),
      barDetailButtons: Array.from(document.querySelectorAll('#bar-detail-toggle .seg-btn')),
      barShiftToggle: document.getElementById('bar-shift-toggle'),
      msSubdeptGroup: document.getElementById('group-ms-subdept'),
      barShiftButtons: Array.from(document.querySelectorAll('#bar-shift-toggle .seg-btn')),
      trendCanvas: document.getElementById('chart-trend'),
      emptyBar: document.getElementById('empty-bar'),
      emptyTrend: document.getElementById('empty-trend'),
      emptyTable: document.getElementById('empty-table'),
      tableBody: document.getElementById('table-detail-body')
    };

    this.els.barGroupButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.group === this.barGroupBy) return;
        this.barGroupBy = btn.dataset.group;
        this.els.barGroupButtons.forEach((b) => b.classList.toggle('active', b === btn));
        this.applyBarGroupModeUI();
        this.updateBarChart();
      });
    });

    this.els.barDetailButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const wantsOn = btn.dataset.detail === 'on';
        if (wantsOn === this.shiftDetailOn) return;
        this.shiftDetailOn = wantsOn;
        this.els.barDetailButtons.forEach((b) => b.classList.toggle('active', b === btn));
        // The Shift 1/2/3/Semua sub-filter only makes sense once Detail per
        // Shift is on — hidden the rest of the time so it's not shown
        // controlling a chart mode it has no effect on.
        this.els.barShiftToggle.hidden = !wantsOn;
        this.updateBarChart();
      });
    });

    this.els.barShiftButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.shift === this.shiftFilter) return;
        this.shiftFilter = btn.dataset.shift;
        this.els.barShiftButtons.forEach((b) => b.classList.toggle('active', b === btn));
        this.updateBarChart();
      });
    });

    this.els.end.value = isoDateDaysAgo(0);
    this.els.start.value = isoDateDaysAgo(13);

    this.msPlant = createMultiSelect(document.getElementById('ms-plant'), allPlantOptions());
    this.msLine = createMultiSelect(document.getElementById('ms-line'), allLineOptions());
    this.msSubDept = createMultiSelect(document.getElementById('ms-subdept'), ['Proses', 'Packing']);

    // Line narrows down to the selected Plant(s) — same cascade idea as the
    // input form. The Sub Dept filter/chart-mode button only make sense
    // while 1112 and/or 1113 is (or could be — "Semua Plant" counts) part
    // of the selection, so their visibility rides along with the same
    // change event.
    this.msPlant.onChange((selectedPlant) => {
      this.msLine.setOptions(lineOptionsForPlant(selectedPlant));
      this.updateSubDeptVisibility(selectedPlant);
    });
    this.msSubDept.onChange(() => {
      if (this.barGroupBy === 'subdept') this.updateBarChart();
    });
    this.updateSubDeptVisibility(this.msPlant.getSelected());

    this.els.applyBtn.addEventListener('click', () => this.refresh());
    this.els.resetBtn.addEventListener('click', () => {
      this.els.end.value = isoDateDaysAgo(0);
      this.els.start.value = isoDateDaysAgo(13);
      this.msPlant.reset();
      this.msPlant.setOptions(allPlantOptions());
      this.msLine.reset();
      this.msLine.setOptions(allLineOptions());
      this.msSubDept.reset();
      this.updateSubDeptVisibility(this.msPlant.getSelected());
      this.refresh();
    });
  },

  async refresh() {
    setButtonLoading(this.els.applyBtn, true);
    const res = await Api.getDashboardData({
      startDate: this.els.start.value,
      endDate: this.els.end.value,
      plant: this.msPlant.getSelected(),
      line: this.msLine.getSelected()
    });
    setButtonLoading(this.els.applyBtn, false);

    if (!res.ok) {
      toast(res.error === 'unauthorized' ? 'Sesi berakhir, silakan login kembali.' : 'Gagal memuat data dashboard.', 'error');
      return;
    }

    this.loaded = true;
    this.render(res.rows);
  },

  render(rows) {
    const totalOutput = rows.reduce((s, r) => s + (Number(r.output) || 0), 0);
    const totalReject = rows.reduce((s, r) => s + (Number(r.reject) || 0), 0);
    const avgPct = totalOutput > 0 ? (totalReject / totalOutput) * 100 : 0;

    this.els.kpiOutput.textContent = formatNumberID(totalOutput, 2);
    this.els.kpiReject.textContent = formatNumberID(totalReject, 2);
    this.els.kpiPct.textContent = `${formatNumberID(avgPct, 2)}%`;

    const byLine = aggregateByLine(rows).sort((a, b) => a.line.localeCompare(b.line));
    const byDate = aggregateByDate(rows);

    this.lastRows = rows;
    this.updateBarChart();
    this.renderTrendChart(byDate);
    this.renderTable(byLine);
  },

  // Shows/hides the Sub Dept filter + "Per Sub Dept" grouping button —
  // relevant only while 1112 and/or 1113 is part of the Plant selection
  // ("Semua Plant", i.e. nothing selected, counts too since it includes
  // them). Falls back to Per Line if Sub Dept mode was active and just lost
  // its relevance (e.g. the user narrowed the Plant filter down to Plants
  // that aren't 1112/1113).
  updateSubDeptVisibility(selectedPlant) {
    const relevant = !selectedPlant.length || selectedPlant.indexOf('1112') !== -1 || selectedPlant.indexOf('1113') !== -1;
    this.els.msSubdeptGroup.hidden = !relevant;
    this.els.btnGroupSubdept.hidden = !relevant;
    if (!relevant && this.msSubDept.getSelected().length) this.msSubDept.reset();
    if (!relevant && this.barGroupBy === 'subdept') {
      this.barGroupBy = 'line';
      this.els.barGroupButtons.forEach((b) => b.classList.toggle('active', b.dataset.group === 'line'));
      this.applyBarGroupModeUI();
      this.updateBarChart();
    }
  },

  // Title/hint/detail-toggle visibility for whichever comparison-chart
  // grouping mode is currently active — shared by the group-button click
  // handler and the Sub-Dept-relevance fallback above.
  applyBarGroupModeUI() {
    const isPlant = this.barGroupBy === 'plant';
    const isSubdept = this.barGroupBy === 'subdept';
    this.els.barTitle.textContent = isSubdept
      ? 'Perbandingan Reject per Sub Dept'
      : (isPlant ? 'Perbandingan Reject per Plant' : 'Perbandingan Reject per Line');
    this.els.barHint.hidden = !isPlant && !isSubdept;
    this.els.barHint.textContent = isSubdept
      ? 'Hanya menghitung baris Plant 1112 dan 1113 (Plant lain diabaikan).'
      : 'Setiap bar adalah total gabungan seluruh Line di Plant tersebut.';
    // Detail per Shift now works for Sub Dept too (S1/S2/S3 split within
    // each of the Proses/Packing bars) — same toggle row as Per Line/Per
    // Plant, never hidden just because the grouping is Sub Dept.
    this.els.barDetailToggle.hidden = false;
    this.els.barShiftToggle.hidden = !this.shiftDetailOn;
  },

  // Re-aggregates from the last fetched rows according to the current
  // Per Line / Per Plant / Per Sub Dept toggle (and the Detail per Shift
  // toggle) and re-renders the comparison chart — no need to hit the server
  // again, the raw rows already have everything, shift breakdown included.
  updateBarChart() {
    if (this.barGroupBy === 'subdept') {
      if (this.shiftDetailOn) {
        // Same generic per-category Shift-breakdown renderer Per Line/Per
        // Plant already use — categories are just Proses/Packing here.
        const items = aggregateSubDeptByShift(this.lastRows, this.msSubDept.getSelected());
        this.renderBarChart(items, 'label');
      } else {
        // Total (no Shift breakdown) keeps its own renderer — the one place
        // Sub Dept differs from Per Line/Per Plant is showing each bar's %
        // of Output in parentheses, which the generic Total-mode renderer
        // doesn't do.
        const items = aggregateBySubDept(this.lastRows, this.msSubDept.getSelected());
        this.renderSubDeptBarChart(items);
      }
      return;
    }
    const keyField = this.barGroupBy === 'plant' ? 'plant' : 'line';
    const items = aggregateByKeyPerShift(this.lastRows, keyField)
      .sort((a, b) => a[keyField].localeCompare(b[keyField]));
    this.renderBarChart(items, keyField);
  },

  renderBarChart(items, labelKey) {
    this.els.emptyBar.hidden = items.length > 0;
    if (!items.length) {
      if (this.barChart) { this.barChart.destroy(); this.barChart = null; }
      return;
    }
    const labels = items.map((e) => e[labelKey]);

    let datasets, shiftTags, xTicks;
    if (this.shiftDetailOn) {
      // Detail per Shift -> either one dataset per shift (Semua Shift,
      // colored/tagged just like the TV board's chart) or a single dataset
      // in that one shift's own color (Shift 1/2/3). Either way this
      // breakdown loses the at-a-glance combined total the plain single-bar
      // view used to show, so it comes back as a second line under the
      // category name on the x-axis — same trick the TV board's own chart
      // uses for the same reason.
      if (this.shiftFilter === 'all') {
        datasets = ['1', '2', '3'].map((shiftKey) => ({
          label: SHIFT_LABELS[shiftKey],
          data: items.map((e) => Number((e.shift[shiftKey] || 0).toFixed(3))),
          backgroundColor: SHIFT_COLORS[shiftKey],
          borderRadius: 5,
          maxBarThickness: 50,
          barPercentage: 0.98,
          categoryPercentage: 0.82
        }));
        shiftTags = ['S1', 'S2', 'S3'];
      } else {
        datasets = [{
          label: SHIFT_LABELS[this.shiftFilter],
          data: items.map((e) => Number((e.shift[this.shiftFilter] || 0).toFixed(3))),
          backgroundColor: SHIFT_COLORS[this.shiftFilter],
          borderRadius: 6,
          maxBarThickness: 50,
          barPercentage: 0.98,
          categoryPercentage: 0.82
        }];
        shiftTags = null;
      }
      xTicks = {
        autoSkip: false,
        maxRotation: 0,
        minRotation: 0,
        font: { size: 10.5, weight: '700' },
        callback: function (value, index) {
          // Same rule as the TV board: drop the "Total: X Kg" line once
          // there isn't enough width per category, so it never rotates
          // into a slanted mess on a narrow screen or a Plant with many
          // Lines — autoSkip then thins the plain labels instead.
          const perCategoryWidth = this.chart.width / items.length;
          if (perCategoryWidth < 110) return items[index][labelKey];
          return [items[index][labelKey], `Total: ${formatNumberID(items[index].reject, 1)} Kg`];
        }
      };
    } else {
      // Total (default) — the original single-bar view: one bar per
      // category, colored by its own reject level relative to the tallest
      // bar on screen.
      const maxReject = Math.max(...items.map((e) => e.reject), 1);
      datasets = [{
        label: 'Total Reject (Kg)',
        data: items.map((e) => Number(e.reject.toFixed(3))),
        backgroundColor: items.map((e) => colorForRatio(e.reject / maxReject)),
        borderRadius: 6,
        maxBarThickness: 34
      }];
      shiftTags = null;
      xTicks = { autoSkip: false, maxRotation: 60, minRotation: 45, font: { size: 10.5 } };
    }

    if (this.barChart) this.barChart.destroy();
    this.barChart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutQuart' },
        layout: { padding: { top: 22 } },
        plugins: {
          // Legend stays off even with 3 datasets — the S1/S2/S3 tag drawn
          // right on each bar (see barShiftValueLabelPlugin) already says
          // which shift it is, same reasoning as the TV board's chart.
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3a0510',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatNumberID(ctx.parsed.y, 2)} Kg`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: xTicks },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => formatNumberID(v, 0) } }
        }
      },
      plugins: [barShiftValueLabelPlugin(shiftTags)]
    });
  },

  // Sub Dept mode: a simple two-bar (or one, if the Sub Dept filter narrows
  // it) Total-style chart — Plant 1112/1113 only, no per-shift breakdown.
  // Each bar's value label also shows that Sub Dept's reject as a
  // percentage of combined Output, in parentheses.
  renderSubDeptBarChart(items) {
    this.els.emptyBar.hidden = items.length > 0;
    if (!items.length) {
      if (this.barChart) { this.barChart.destroy(); this.barChart = null; }
      return;
    }
    const labels = items.map((e) => e.label);
    const maxReject = Math.max(...items.map((e) => e.reject), 1);
    const datasets = [{
      label: 'Total Reject (Kg)',
      data: items.map((e) => Number(e.reject.toFixed(3))),
      backgroundColor: items.map((e) => colorForRatio(e.reject / maxReject)),
      borderRadius: 6,
      maxBarThickness: 70
    }];
    const pctByIndex = items.map((e) => e.pct);

    if (this.barChart) this.barChart.destroy();
    this.barChart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutQuart' },
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3a0510',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatNumberID(ctx.parsed.y, 2)} Kg (${formatNumberID(pctByIndex[ctx.dataIndex], 2)}%)`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, minRotation: 0, font: { size: 12.5, weight: '700' } } },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => formatNumberID(v, 0) } }
        }
      },
      plugins: [barShiftValueLabelPlugin(null, pctByIndex)]
    });
  },

  renderTrendChart(byDate) {
    this.els.emptyTrend.hidden = byDate.length > 0;
    if (!byDate.length) {
      if (this.trendChart) { this.trendChart.destroy(); this.trendChart = null; }
      return;
    }
    const labels = byDate.map((e) => formatShortDate(e.tanggal));
    const data = byDate.map((e) => Number(e.pct.toFixed(2)));

    const ctx = this.els.trendCanvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(200, 30, 58, 0.35)');
    gradient.addColorStop(1, 'rgba(200, 30, 58, 0.02)');

    if (this.trendChart) this.trendChart.destroy();
    this.trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Reject (%)',
          data,
          borderColor: '#9c1029',
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: '#9c1029',
          pointHoverRadius: 5,
          borderWidth: 2.5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3a0510',
            padding: 10,
            cornerRadius: 8,
            callbacks: { label: (ctx) => ` ${formatNumberID(ctx.parsed.y, 2)}%` }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10.5 } } },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => `${formatNumberID(Number(v), 1)}%` } }
        }
      }
    });
  },

  renderTable(byLine) {
    this.els.tableBody.innerHTML = '';
    this.els.emptyTable.hidden = byLine.length > 0;
    const sorted = [...byLine].sort((a, b) => b.reject - a.reject);
    sorted.forEach((e) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(e.line)}</td>
        <td>${escapeHtml(e.plant)}</td>
        <td>${formatNumberID(e.output, 2)}</td>
        <td>${formatNumberID(e.reject, 2)}</td>
        <td>${formatNumberID(e.pct, 2)}%</td>
      `;
      this.els.tableBody.appendChild(tr);
    });
  }
};

function formatShortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}
