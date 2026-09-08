/**
 * MONITORING REJECT — Dashboard page: multi-select filters, KPI cards,
 * bar chart (reject per line), trend line chart, and a detail table.
 */

function allDivisiOptions() {
  return Object.keys(LINE_CONFIG);
}
function allPlantOptions() {
  const set = new Set();
  Object.values(LINE_CONFIG).forEach((plants) => Object.keys(plants).forEach((p) => set.add(p)));
  return Array.from(set);
}
function allLineOptions() {
  const set = new Set();
  Object.values(LINE_CONFIG).forEach((plants) => Object.values(plants).forEach((lines) => lines.forEach((l) => set.add(l))));
  return Array.from(set).sort();
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// low -> mid -> high color ramp, kept inside the maroon/gold palette
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
    if (!map.has(r.line)) map.set(r.line, { line: r.line, divisi: r.divisi, plant: r.plant, output: 0, reject: 0 });
    const entry = map.get(r.line);
    entry.output += Number(r.output) || 0;
    entry.reject += Number(r.reject) || 0;
  });
  return Array.from(map.values()).map((e) => ({
    ...e,
    pct: e.output > 0 ? (e.reject / e.output) * 100 : 0
  }));
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
  msDivisi: null,
  msPlant: null,
  msLine: null,
  barChart: null,
  trendChart: null,
  loaded: false,

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
      trendCanvas: document.getElementById('chart-trend'),
      emptyBar: document.getElementById('empty-bar'),
      emptyTrend: document.getElementById('empty-trend'),
      emptyTable: document.getElementById('empty-table'),
      tableBody: document.getElementById('table-detail-body')
    };

    this.els.end.value = isoDateDaysAgo(0);
    this.els.start.value = isoDateDaysAgo(13);

    this.msDivisi = createMultiSelect(document.getElementById('ms-divisi'), allDivisiOptions());
    this.msPlant = createMultiSelect(document.getElementById('ms-plant'), allPlantOptions());
    this.msLine = createMultiSelect(document.getElementById('ms-line'), allLineOptions());

    this.els.applyBtn.addEventListener('click', () => this.refresh());
    this.els.resetBtn.addEventListener('click', () => {
      this.els.end.value = isoDateDaysAgo(0);
      this.els.start.value = isoDateDaysAgo(13);
      this.msDivisi.reset();
      this.msPlant.reset();
      this.msLine.reset();
      this.refresh();
    });
  },

  async refresh() {
    setButtonLoading(this.els.applyBtn, true);
    const res = await Api.getDashboardData({
      startDate: this.els.start.value,
      endDate: this.els.end.value,
      divisi: this.msDivisi.getSelected(),
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

    this.renderBarChart(byLine);
    this.renderTrendChart(byDate);
    this.renderTable(byLine);
  },

  renderBarChart(byLine) {
    this.els.emptyBar.hidden = byLine.length > 0;
    if (!byLine.length) {
      if (this.barChart) { this.barChart.destroy(); this.barChart = null; }
      return;
    }
    const maxReject = Math.max(...byLine.map((e) => e.reject), 1);
    const labels = byLine.map((e) => e.line);
    const data = byLine.map((e) => Number(e.reject.toFixed(3)));
    const colors = byLine.map((e) => colorForRatio(e.reject / maxReject));

    if (this.barChart) this.barChart.destroy();
    this.barChart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Total Reject (Kg)',
          data,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 34
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
            callbacks: {
              label: (ctx) => ` ${formatNumberID(ctx.parsed.y, 2)} Kg`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 60, minRotation: 45, font: { size: 10.5 } } },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => formatNumberID(v, 0) } }
        }
      }
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
        <td>${escapeHtml(e.divisi)}</td>
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
