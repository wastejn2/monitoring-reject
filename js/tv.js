/**
 * MONITORING REJECT — TV Monitoring board
 * Continuous-display page (requires login, same as every other page).
 * Shows H-1 (kemarin) reject per shift for one selected Plant, a 7-day
 * trend mini-chart per Line, and a Top Rank list (ranked by average reject
 * over however many days actually have data — total also shown) — all
 * scoped to the selected Plant. Fullscreen mode auto-cycles through every
 * Plant every 30 seconds with a soft fade transition.
 */

const TV_PLANT_KEY = 'mr_tv_plant';
const TV_REFRESH_MS = 5 * 60 * 1000; // 5 minutes — fine for a board that just sits on a TV
const TV_CYCLE_MS = 30 * 1000; // fullscreen-only: how long each Plant stays on screen
const TV_TOP_RANK_COUNT = 5;
const TV_FADE_MS = 320; // must match the CSS transition duration on .tv-board-body

function tvLast7DatesEndingYesterday() {
  const arr = [];
  for (let i = 7; i >= 1; i--) arr.push(isoDateDaysAgo(i));
  return arr;
}

function tvWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Explicit HH:mm:ss with colons — toLocaleTimeString('id-ID') renders with
// dots (e.g. "18.58.59"), which reads as an odd number rather than a clock
// at a glance on a TV board.
function tvFormatClock(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Draws the value on top of each bar, and a small S1/S2/S3 tag near the
// bottom of the bar itself — replaces the old top-of-chart color legend,
// since the tag on the bar already says which shift it is.
function tvBarDecorationsPlugin(shiftLabels) {
  return {
    id: 'tvBarDecorations',
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
          ctx.font = '700 11.5px "Segoe UI", sans-serif';
          ctx.fillText(formatNumberID(value, 1), bar.x, bar.y - 6);

          if (barHeight > 22) {
            ctx.fillStyle = dsIndex === 0 ? '#3a0510' : '#ffffff';
            ctx.font = '700 10px "Segoe UI", sans-serif';
            ctx.fillText(shiftLabels[dsIndex], bar.x, bar.base - 8);
          }
          ctx.restore();
        });
      });
    }
  };
}

const TvBoard = {
  els: {},
  chart: null,
  trendCharts: [],
  timer: null,
  cycleTimer: null,
  loading: false,
  fullscreenBound: false,

  init() {
    this.els = {
      plantSelect: document.getElementById('tv-plant'),
      dateH1: document.getElementById('tv-date-h1'),
      lastUpdated: document.getElementById('tv-last-updated'),
      barPlantLabel: document.getElementById('tv-bar-plant-label'),
      barCanvas: document.getElementById('tv-chart-bar'),
      emptyBar: document.getElementById('tv-empty-bar'),
      rankList: document.getElementById('tv-rank-list'),
      emptyRank: document.getElementById('tv-empty-rank'),
      trendGrid: document.getElementById('tv-trend-grid'),
      emptyTrend: document.getElementById('tv-empty-trend'),
      board: document.getElementById('tv-board-body'),
      page: document.getElementById('page-tv'),
      fullscreenBtn: document.getElementById('tv-fullscreen-btn')
    };

    const plants = PLANT_ORDER.slice();
    this.els.plantSelect.innerHTML = plants.map((p) => `<option value="${p}">${p}</option>`).join('');

    const saved = localStorage.getItem(TV_PLANT_KEY);
    this.els.plantSelect.value = plants.includes(saved) ? saved : plants[0];

    this.els.plantSelect.addEventListener('change', () => {
      localStorage.setItem(TV_PLANT_KEY, this.els.plantSelect.value);
      this.refresh();
      // manual override during fullscreen auto-cycle: give it a fresh 30s
      if (this.cycleTimer) this.startCycle();
    });

    this.els.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

    if (!this.fullscreenBound) {
      document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
      this.fullscreenBound = true;
    }
  },

  start() {
    this.refresh();
    this.stop();
    this.timer = setInterval(() => this.refresh(), TV_REFRESH_MS);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopCycle();
  },

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.els.page.requestFullscreen().catch(() => toast('Browser ini tidak mendukung mode layar penuh.', 'error'));
    } else {
      document.exitFullscreen();
    }
  },

  onFullscreenChange() {
    const isFull = document.fullscreenElement === this.els.page;
    this.els.fullscreenBtn.textContent = isFull ? '⛶ Keluar Layar Penuh' : '⛶ Layar Penuh';
    if (isFull) {
      this.startCycle();
    } else {
      this.stopCycle();
    }
  },

  startCycle() {
    this.stopCycle();
    this.cycleTimer = setInterval(() => this.advancePlant(), TV_CYCLE_MS);
  },

  stopCycle() {
    if (this.cycleTimer) { clearInterval(this.cycleTimer); this.cycleTimer = null; }
  },

  async advancePlant() {
    const plants = PLANT_ORDER;
    const currentIndex = plants.indexOf(this.els.plantSelect.value);
    const nextPlant = plants[(currentIndex + 1) % plants.length];

    this.els.board.classList.add('tv-fading');
    await tvWait(TV_FADE_MS);

    this.els.plantSelect.value = nextPlant;
    localStorage.setItem(TV_PLANT_KEY, nextPlant);
    await this.refresh();

    this.els.board.classList.remove('tv-fading');
  },

  async refresh() {
    if (this.loading) return;
    this.loading = true;

    const plant = this.els.plantSelect.value;
    const dates = tvLast7DatesEndingYesterday();
    const h1 = dates[dates.length - 1];

    this.els.dateH1.textContent = formatShortDate(h1);
    this.els.barPlantLabel.textContent = plant;

    const res = await Api.getDashboardData({
      startDate: dates[0],
      endDate: h1,
      plant: [plant]
    });

    this.loading = false;

    if (!res.ok) {
      if (res.error === 'unauthorized') toast('Sesi berakhir, silakan login kembali.', 'error');
      return;
    }

    this.els.lastUpdated.textContent = tvFormatClock(new Date());

    this.renderBar(res.rows, plant, h1);
    this.renderTrendAndRank(res.rows, plant, dates);
  },

  renderBar(rows, plant, h1) {
    const lines = PLANT_CONFIG[plant] || [];
    const perLine = new Map();
    rows.forEach((r) => {
      if (r.tanggal !== h1) return;
      if (!perLine.has(r.line)) perLine.set(r.line, { 1: 0, 2: 0, 3: 0, total: 0 });
      const e = perLine.get(r.line);
      const val = Number(r.reject) || 0;
      const shiftKey = String(r.shift);
      if (e[shiftKey] !== undefined) e[shiftKey] += val;
      e.total += val;
    });

    // only lines that actually have H-1 data, in Plant's natural Line order
    const activeLines = lines.filter((l) => perLine.has(l));

    this.els.emptyBar.hidden = activeLines.length > 0;
    if (!activeLines.length) {
      if (this.chart) { this.chart.destroy(); this.chart = null; }
      return;
    }

    const totals = activeLines.map((l) => perLine.get(l).total);
    const shiftColors = { 1: '#d8b370', 2: '#c81e3a', 3: '#55091a' };
    const shiftLabels = ['S1', 'S2', 'S3'];

    const datasets = ['1', '2', '3'].map((shiftKey, i) => ({
      label: `Shift ${shiftKey}`,
      data: activeLines.map((l) => Number((perLine.get(l)[shiftKey] || 0).toFixed(3))),
      backgroundColor: shiftColors[shiftKey],
      borderRadius: 5,
      maxBarThickness: 50,
      barPercentage: 0.98,
      categoryPercentage: 0.82
    }));

    if (this.chart) this.chart.destroy();
    this.chart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels: activeLines, datasets },
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
            callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatNumberID(ctx.parsed.y, 2)} Kg` }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { size: 13, weight: '700' },
              color: '#3a0510',
              callback: function (value, index) {
                const total = totals[index];
                return [activeLines[index], `Total: ${formatNumberID(total, 1)} Kg`];
              }
            }
          },
          y: { display: false }
        }
      },
      plugins: [tvBarDecorationsPlugin(shiftLabels)]
    });
  },

  renderTrendAndRank(rows, plant, dates) {
    const lines = PLANT_CONFIG[plant] || [];
    const byLine = new Map();
    lines.forEach((l) => byLine.set(l, new Map(dates.map((d) => [d, 0]))));

    rows.forEach((r) => {
      const dayMap = byLine.get(r.line);
      if (!dayMap || !dayMap.has(r.tanggal)) return;
      dayMap.set(r.tanggal, dayMap.get(r.tanggal) + (Number(r.reject) || 0));
    });

    const summary = [];
    byLine.forEach((dayMap, line) => {
      const values = dates.map((d) => Number(dayMap.get(d).toFixed(3)));
      const total = Number(values.reduce((a, b) => a + b, 0).toFixed(3));
      if (total <= 0) return;
      // Average is total divided by however many days actually have reject
      // data, NOT a fixed /7 — a Line that only reported on 2 of the 7 days
      // gets its average from those 2 days, not diluted by 5 empty ones.
      const activeDays = values.filter((v) => v > 0);
      const daysWithData = activeDays.length || 1;
      summary.push({
        line,
        values,
        total,
        avg: total / daysWithData,
        max: Math.max(...activeDays),
        min: Math.min(...activeDays),
        daysWithData
      });
    });

    this.renderTrend(summary, dates);
    this.renderRank(summary);
  },

  renderTrend(summary, dates) {
    this.els.emptyTrend.hidden = summary.length > 0;
    this.trendCharts.forEach((c) => c.destroy());
    this.trendCharts = [];
    this.els.trendGrid.innerHTML = '';
    if (!summary.length) return;

    const labels = dates.map((d) => formatShortDate(d));

    summary
      .slice()
      .sort((a, b) => a.line.localeCompare(b.line))
      .forEach((entry) => {
        const card = document.createElement('div');
        card.className = 'tv-trend-item';
        card.innerHTML = `
          <div class="tv-trend-item-head">
            <span class="tv-trend-item-line">${escapeHtml(entry.line)}</span>
            <span class="tv-trend-item-total">Total: ${formatNumberID(entry.total, 1)} Kg</span>
          </div>
          <div class="tv-trend-item-stats">
            <span>Max <b>${formatNumberID(entry.max, 1)}</b></span>
            <span>Min <b>${formatNumberID(entry.min, 1)}</b></span>
            <span>Avg <b>${formatNumberID(entry.avg, 1)}</b></span>
          </div>
          <div class="tv-trend-item-chart"><canvas></canvas></div>
        `;
        this.els.trendGrid.appendChild(card);

        const canvas = card.querySelector('canvas');

        const chart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: entry.line,
                data: entry.values,
                borderColor: '#9c1029',
                backgroundColor: 'rgba(200,30,58,0.12)',
                fill: true,
                tension: 0.35,
                pointRadius: 2.5,
                pointBackgroundColor: '#9c1029',
                borderWidth: 2
              },
              {
                label: 'Max',
                data: dates.map(() => entry.max),
                borderColor: '#d8b370',
                borderDash: [5, 4],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false
              },
              {
                label: 'Rata-rata',
                data: dates.map(() => entry.avg),
                borderColor: '#55091a',
                borderDash: [2, 3],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 350, easing: 'easeOutQuart' },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#3a0510',
                padding: 8,
                cornerRadius: 8,
                filter: (ctx) => ctx.datasetIndex === 0,
                callbacks: { label: (ctx) => ` ${formatNumberID(ctx.parsed.y, 2)} Kg` }
              }
            },
            scales: {
              x: { grid: { display: false }, ticks: { font: { size: 9.5 } } },
              y: { display: false }
            }
          }
        });
        this.trendCharts.push(chart);
      });
  },

  renderRank(summary) {
    this.els.emptyRank.hidden = summary.length > 0;
    this.els.rankList.innerHTML = '';
    if (!summary.length) return;

    const ranked = summary.slice().sort((a, b) => b.avg - a.avg).slice(0, TV_TOP_RANK_COUNT);
    const medalClass = ['tv-rank-1', 'tv-rank-2', 'tv-rank-3'];

    ranked.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = `tv-rank-row ${medalClass[index] || ''}`;
      row.innerHTML = `
        <div class="tv-rank-pos">${index + 1}</div>
        <div class="tv-rank-info">
          <div class="tv-rank-line">${escapeHtml(entry.line)}</div>
          <div class="tv-rank-total">Total 7 hari: ${formatNumberID(entry.total, 1)} Kg (${entry.daysWithData} hari data)</div>
        </div>
        <div class="tv-rank-avg">
          <div class="tv-rank-avg-value">${formatNumberID(entry.avg, 1)}</div>
          <div class="tv-rank-avg-label">Kg/hari</div>
        </div>
      `;
      this.els.rankList.appendChild(row);
    });
  }
};
