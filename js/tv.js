/**
 * MONITORING REJECT — TV Monitoring board
 * Continuous-display page (requires login, same as every other page).
 * Shows H-1 (kemarin) reject per shift for one selected Plant, a 7-day
 * trend mini-chart per Line, and a Top Rank list (ranked by average reject
 * over however many days actually have data — total also shown) — all
 * scoped to the selected Plant. Fullscreen mode auto-cycles through every
 * Plant every 30 seconds with a sliding transition — the next Plant's data
 * is fetched in the background a few seconds early so the slide never has
 * to wait on the network (and never fires if that data isn't ready yet).
 */

const TV_PLANT_KEY = 'mr_tv_plant';
const TV_REFRESH_MS = 5 * 60 * 1000; // 5 minutes — fine for a board that just sits on a TV
const TV_CYCLE_MS = 30 * 1000; // fullscreen-only: how long each Plant stays on screen
const TV_TOP_RANK_COUNT = 5;
const TV_SLIDE_MS = 380; // must match the CSS transition duration on .tv-board-body
// How long before the 30s mark to start fetching the NEXT Plant's data in the
// background, so it's already sitting ready by the time the slide happens —
// the switch itself never has to wait on the network.
const TV_PREFETCH_LEAD_MS = 6000;
// Mode Scroll: the 3 panels shown one at a time, full-screen, in this order,
// each held on screen for TV_SCROLL_SLIDE_MS before swapping to the next.
// After the last one, the normal Plant auto-cycle (prefetch + slide
// transition) advances to the next Plant and this sequence starts over.
const TV_SCROLL_SLIDES = ['bar', 'trend', 'rank'];
const TV_SCROLL_SLIDE_MS = 10 * 1000;

// Shift 3 runs 23:00-07:00, so it belongs to the production day it started
// on even though the clock has already rolled into the next calendar date.
// The TV board's notion of "today" (and therefore H-1 and the 7-day trend
// window) has to roll over at 07:00, not at midnight, or it would flip to
// showing "today" as H-1 for the last 7 hours of every Shift 3 while that
// shift's data is still being recorded under the previous date.
const TV_DAY_ROLLOVER_HOUR = 7;
function tvProductionToday() {
  const d = new Date();
  if (d.getHours() < TV_DAY_ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  return d;
}
function tvIsoDateDaysAgo(days) {
  const d = tvProductionToday();
  d.setDate(d.getDate() - days);
  // Local y/m/d, not d.toISOString() — see toLocalISODate() in
  // dashboard.js for why: toISOString() is UTC-based, and WIB (UTC+7)
  // being ahead of UTC means any local time before 07:00 is still
  // "yesterday" in UTC, which would silently subtract an extra day on
  // top of the shift-rollover adjustment above.
  return toLocalISODate(d);
}
function tvLast7DatesEndingYesterday() {
  const arr = [];
  for (let i = 7; i >= 1; i--) arr.push(tvIsoDateDaysAgo(i));
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
//
// Font sizes are computed from the chart's actual plotting-area height
// instead of being fixed pixel values — that's what made this text stay
// tiny in Mode Scroll: the CSS around the canvas grew a lot (a full TV
// screen instead of a shared half-screen panel) but a hardcoded '11.5px'
// canvas font doesn't know that. Scaling off chartArea.height means the
// same code draws normal-sized text in the compact dense layout and
// bigger text once Mode Scroll gives the chart the whole screen — no
// separate "large mode" flag needed, and it also re-scales automatically on
// every resize (Chart.js's ResizeObserver fires when Mode Scroll shows/hides
// a panel, since that's a 0-height <-> real-height size change).
// The max end is kept modest on purpose: unlike the trend/rank panels
// (which scroll internally if their content doesn't fit), this bar chart
// has no scroll fallback — Bos wants it to stay small enough to always show
// every Line's bar and its "Total: X Kg" tick label in full on one screen,
// rather than text so big it gets clipped off the bottom.
function tvBarDecorationsPlugin(shiftLabels) {
  return {
    id: 'tvBarDecorations',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const areaH = (chart.chartArea && chart.chartArea.height) || 300;
      const valueFontPx = Math.round(Math.max(11.5, Math.min(20, areaH / 40)));
      const tagFontPx = Math.round(Math.max(10, Math.min(15, areaH / 55)));
      const tagMinBarHeight = Math.max(22, tagFontPx * 2);

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
          ctx.font = `700 ${valueFontPx}px "Segoe UI", sans-serif`;
          ctx.fillText(formatNumberID(value, 1), bar.x, bar.y - Math.max(6, valueFontPx * 0.5));

          if (barHeight > tagMinBarHeight) {
            ctx.fillStyle = dsIndex === 0 ? '#3a0510' : '#ffffff';
            ctx.font = `700 ${tagFontPx}px "Segoe UI", sans-serif`;
            ctx.fillText(shiftLabels[dsIndex], bar.x, bar.base - Math.max(8, tagFontPx * 0.8));
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
  cyclePrefetchTimer: null,
  cycleActive: false,
  autoRotateOn: false,
  scrollModeOn: false,
  scrollPaused: false,
  scrollSlideIndex: 0,
  scrollSlideTimer: null,
  loading: false,
  fullscreenBound: false,
  // Background-prefetch bookkeeping for the auto-cycle: data fetched ahead
  // of time for whichever Plant comes next, keyed by Plant name, so the
  // slide transition can render instantly instead of waiting on the API.
  prefetchCache: new Map(),
  prefetchInFlight: new Map(),

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
      fullscreenBtn: document.getElementById('tv-fullscreen-btn'),
      autorotateBtn: document.getElementById('tv-autorotate-btn'),
      scrollModeBtn: document.getElementById('tv-scrollmode-btn'),
      scrollPauseBtn: document.getElementById('tv-scrollpause-btn')
    };
    // The 3 full-screen "slides" Mode Scroll pages through, found via the
    // canvases/lists already looked up above rather than adding new IDs.
    this.els.scrollSlideEls = {
      bar: this.els.barCanvas.closest('.tv-panel-bar'),
      trend: this.els.trendGrid.closest('.tv-panel-trend'),
      rank: this.els.rankList.closest('.tv-panel-rank')
    };

    const plants = PLANT_ORDER.slice();
    this.els.plantSelect.innerHTML = plants.map((p) => `<option value="${p}">${p}</option>`).join('');

    const saved = localStorage.getItem(TV_PLANT_KEY);
    this.els.plantSelect.value = plants.includes(saved) ? saved : plants[0];

    this.els.plantSelect.addEventListener('change', () => {
      localStorage.setItem(TV_PLANT_KEY, this.els.plantSelect.value);
      this.refresh();
      // manual override during an active auto-cycle: give it a fresh dwell
      // (also drops any stale prefetch, since the sequence just changed)
      if (this.scrollModeOn) {
        this.prefetchCache.clear();
        this.scrollPaused = false;
        this.updateScrollPauseBtn();
        this.showScrollSlide(0);
      } else if (this.cycleActive) {
        this.prefetchCache.clear();
        this.startCycle();
      }
    });

    this.els.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.els.autorotateBtn.addEventListener('click', () => this.toggleAutoRotate());
    this.els.scrollModeBtn.addEventListener('click', () => this.toggleScrollMode());
    this.els.scrollPauseBtn.addEventListener('click', () => this.toggleScrollPause());

    if (!this.fullscreenBound) {
      document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
      this.fullscreenBound = true;
    }

    this.updateAutoRotateBtn();
    this.updateScrollModeBtn();
  },

  start() {
    this.refresh();
    this.stop();
    this.timer = setInterval(() => this.refresh(), TV_REFRESH_MS);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Leaving the TV page entirely — always fully stop, regardless of
    // whether auto-rotate/scroll-mode was on, so it starts clean next time.
    this.autoRotateOn = false;
    this.updateAutoRotateBtn();
    this.stopCycle();
    this.scrollModeOn = false;
    this.scrollPaused = false;
    this.updateScrollModeBtn();
    this.applyScrollModeClass();
    this.els.scrollPauseBtn.hidden = true;
    this.updateScrollPauseBtn();
    this.stopScrollPaging();
  },

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      // Not every mobile browser supports the Fullscreen API on an
      // arbitrary element (iPhone Safari notably doesn't) — Auto-Ganti
      // Plant works either way since it's no longer tied to fullscreen.
      this.els.page.requestFullscreen().catch(() => toast('Browser ini tidak mendukung mode layar penuh. Coba tombol Auto-Ganti Plant saja.', 'error'));
    } else {
      document.exitFullscreen();
    }
  },

  onFullscreenChange() {
    const isFull = document.fullscreenElement === this.els.page;
    this.els.fullscreenBtn.textContent = isFull ? '⛶ Keluar Layar Penuh' : '⛶ Layar Penuh';
    // Entering fullscreen turns auto-rotate on by default (the classic TV
    // kiosk behavior). Exiting fullscreen no longer force-stops it — on a
    // phone (no real fullscreen support) Auto-Ganti Plant is the only way
    // to get rotation at all, so it has to keep running on its own.
    if (isFull && !this.autoRotateOn) {
      this.autoRotateOn = true;
      this.updateAutoRotateBtn();
      if (this.scrollModeOn) this.cycleActive = true; else this.startCycle();
    }
    // Mode Scroll shows the same slide index in whichever container fits —
    // fullscreen vs not only changes the CSS, not which panel is showing —
    // so nothing needs restarting here beyond leaving it exactly as it was.
  },

  toggleAutoRotate() {
    this.autoRotateOn = !this.autoRotateOn;
    this.updateAutoRotateBtn();
    if (this.scrollModeOn) {
      // Mode Scroll drives its own Plant-advance off its own slide sequence
      // finishing, never the timer-based cycle — just flip the flag that
      // advanceScrollSlide() checks instead of arming scheduleCycleStep().
      this.cycleActive = this.autoRotateOn;
      return;
    }
    if (this.autoRotateOn) this.startCycle(); else this.stopCycle();
  },

  updateAutoRotateBtn() {
    this.els.autorotateBtn.textContent = this.autoRotateOn ? '⏸ Auto-Ganti: Aktif' : '🔄 Auto-Ganti Plant';
    this.els.autorotateBtn.classList.toggle('active', this.autoRotateOn);
  },

  // ---------- Mode Scroll ----------
  // A second display mode: instead of squeezing the bar/rank/trend panels
  // onto one screen, ONE of them fills the ENTIRE screen at a time — bar
  // chart, then trend, then rank (TV_SCROLL_SLIDES) — held for
  // TV_SCROLL_SLIDE_MS (10s) each. After the last one, the existing Plant
  // auto-cycle (prefetch + slide transition) advances to the next Plant and
  // the sequence starts over from the bar chart.
  toggleScrollMode() {
    this.scrollModeOn = !this.scrollModeOn;
    this.scrollPaused = false;
    this.updateScrollModeBtn();
    this.applyScrollModeClass();
    this.els.scrollPauseBtn.hidden = !this.scrollModeOn;
    this.updateScrollPauseBtn();
    this.stopScrollPaging();
    if (this.scrollModeOn) {
      // Turning Mode Scroll on implies Auto-Ganti Plant — there'd be nothing
      // to advance to otherwise once the slide sequence finishes.
      if (!this.autoRotateOn) {
        this.autoRotateOn = true;
        this.updateAutoRotateBtn();
      }
      this.stopCycle();
      this.cycleActive = true;
      this.showScrollSlide(0);
    } else {
      // Back to the classic dense layout: no panel stays hidden.
      Object.values(this.els.scrollSlideEls).forEach((el) => el.classList.remove('tv-scroll-hide'));
      if (this.autoRotateOn) this.startCycle();
    }
  },

  updateScrollModeBtn() {
    this.els.scrollModeBtn.textContent = this.scrollModeOn ? '📜 Mode Scroll: Aktif' : '📜 Mode Scroll';
    this.els.scrollModeBtn.classList.toggle('active', this.scrollModeOn);
  },

  applyScrollModeClass() {
    this.els.page.classList.toggle('tv-scroll-mode', this.scrollModeOn);
  },

  // Lets Bos pause the bar/trend/rank sequence on whichever slide is
  // currently showing — e.g. to read it longer — without leaving the big
  // full-page Mode Scroll layout entirely (that's what the separate Mode
  // Scroll on/off button is for).
  toggleScrollPause() {
    if (this.scrollPaused) this.resumeScrollPaging(); else this.pauseScrollPaging();
  },

  pauseScrollPaging() {
    if (!this.scrollModeOn || this.scrollPaused) return;
    this.scrollPaused = true;
    if (this.scrollSlideTimer) { clearTimeout(this.scrollSlideTimer); this.scrollSlideTimer = null; }
    this.updateScrollPauseBtn();
  },

  resumeScrollPaging() {
    if (!this.scrollModeOn || !this.scrollPaused) return;
    this.scrollPaused = false;
    this.updateScrollPauseBtn();
    this.armNextSlideTimer(); // gives the current slide a fresh full dwell
  },

  updateScrollPauseBtn() {
    this.els.scrollPauseBtn.textContent = this.scrollPaused ? '▶ Lanjutkan Scroll' : '⏸ Jeda Scroll';
    this.els.scrollPauseBtn.classList.toggle('active', this.scrollPaused);
  },

  // Shows TV_SCROLL_SLIDES[index] full-screen and hides the other two, then
  // arms the timer for its dwell. Index 0 also happens to be exactly what a
  // freshly-shown Plant should start on, so this doubles as "reset to the
  // top of the sequence" whenever a new Plant just came on screen.
  showScrollSlide(index) {
    this.scrollSlideIndex = index;
    const activeKey = TV_SCROLL_SLIDES[index];
    Object.entries(this.els.scrollSlideEls).forEach(([key, el]) => {
      el.classList.toggle('tv-scroll-hide', key !== activeKey);
    });
    this.armNextSlideTimer();
  },

  armNextSlideTimer() {
    if (this.scrollSlideTimer) { clearTimeout(this.scrollSlideTimer); this.scrollSlideTimer = null; }
    if (!this.scrollModeOn || this.scrollPaused) return;
    this.scrollSlideTimer = setTimeout(() => this.advanceScrollSlide(), TV_SCROLL_SLIDE_MS);
    // On the last slide (rank) of this dwell, the next timer firing is what
    // moves to the next Plant — start fetching its data now so the slide
    // transition never has to wait on the network.
    if (TV_SCROLL_SLIDES[this.scrollSlideIndex] === 'rank' && this.cycleActive) {
      const plants = PLANT_ORDER;
      const nextPlant = plants[(plants.indexOf(this.els.plantSelect.value) + 1) % plants.length];
      this.prefetchPlant(nextPlant);
    }
  },

  stopScrollPaging() {
    if (this.scrollSlideTimer) { clearTimeout(this.scrollSlideTimer); this.scrollSlideTimer = null; }
  },

  async advanceScrollSlide() {
    if (!this.scrollModeOn) return;
    if (this.scrollSlideIndex < TV_SCROLL_SLIDES.length - 1) {
      this.showScrollSlide(this.scrollSlideIndex + 1);
      return;
    }
    // Finished the last slide (rank) for this Plant.
    if (!this.autoRotateOn) {
      // Auto-Ganti Plant was switched off while Mode Scroll stayed on — keep
      // looping the SAME Plant's bar/trend/rank sequence indefinitely rather
      // than stopping dead on a static rank list forever.
      this.showScrollSlide(0);
      return;
    }
    await this.advancePlant(); // reuses the existing prefetch + slide transition
    if (this.scrollModeOn) this.showScrollSlide(0);
  },

  startCycle() {
    this.stopCycle();
    this.cycleActive = true;
    this.scheduleCycleStep();
  },

  stopCycle() {
    this.cycleActive = false;
    if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    if (this.cyclePrefetchTimer) { clearTimeout(this.cyclePrefetchTimer); this.cyclePrefetchTimer = null; }
  },

  // Arms the two timers for one 30s dwell: one that kicks off a background
  // fetch of the next Plant a few seconds early, and one that actually
  // triggers the slide once the full 30s is up.
  scheduleCycleStep() {
    const plants = PLANT_ORDER;
    const nextPlant = plants[(plants.indexOf(this.els.plantSelect.value) + 1) % plants.length];
    const leadMs = Math.min(TV_PREFETCH_LEAD_MS, Math.floor(TV_CYCLE_MS / 2));

    this.cyclePrefetchTimer = setTimeout(() => {
      if (this.cycleActive) this.prefetchPlant(nextPlant);
    }, Math.max(0, TV_CYCLE_MS - leadMs));

    this.cycleTimer = setTimeout(() => this.advancePlant(), TV_CYCLE_MS);
  },

  // Fetches one Plant's dashboard data without touching the UI — used both
  // for the visible refresh() and for the silent background prefetch.
  async fetchPlantData(plant) {
    const dates = tvLast7DatesEndingYesterday();
    const h1 = dates[dates.length - 1];
    const res = await Api.getDashboardData({
      startDate: dates[0],
      endDate: h1,
      plant: [plant]
    });
    return { res, dates, h1 };
  },

  // Kicks off (or reuses) a background fetch for `plant` and stashes the
  // result in prefetchCache once it lands. Safe to call more than once for
  // the same Plant — later calls just await the same in-flight request.
  prefetchPlant(plant) {
    if (this.prefetchInFlight.has(plant)) return this.prefetchInFlight.get(plant);
    const promise = this.fetchPlantData(plant)
      .then(({ res, dates, h1 }) => {
        this.prefetchInFlight.delete(plant);
        if (!res.ok) return null;
        const entry = { rows: res.rows, dates, h1 };
        this.prefetchCache.set(plant, entry);
        return entry;
      })
      .catch(() => {
        this.prefetchInFlight.delete(plant);
        return null;
      });
    this.prefetchInFlight.set(plant, promise);
    return promise;
  },

  // Pushes fetched data onto the screen — shared by refresh() and by the
  // auto-cycle slide once the next Plant's (prefetched) data is in hand.
  applyData(plant, rows, dates, h1) {
    this.els.dateH1.textContent = formatShortDate(h1);
    this.els.barPlantLabel.textContent = plant;
    this.els.lastUpdated.textContent = tvFormatClock(new Date());
    this.renderBar(rows, plant, h1);
    this.renderTrendAndRank(rows, plant, dates);
  },

  // Auto-cycle step: waits for the next Plant's data to actually be ready
  // (prefetched ahead of time in the common case, so this resolves
  // instantly — but if the network was slow, this holds the CURRENT Plant
  // on screen rather than switching to something half-loaded) and only
  // then plays the slide transition.
  async advancePlant() {
    if (!this.cycleActive) return;
    const plants = PLANT_ORDER;
    const nextPlant = plants[(plants.indexOf(this.els.plantSelect.value) + 1) % plants.length];

    let data = this.prefetchCache.get(nextPlant);
    if (!data) data = await this.prefetchPlant(nextPlant);
    if (!this.cycleActive) return; // fullscreen may have been exited while we waited

    await this.playSlideTransition(nextPlant, data);
    this.prefetchCache.delete(nextPlant);

    // While Mode Scroll is active, advanceScrollSlide() (which called us) is
    // the one that re-arms the next dwell — never the timer-based cycle too.
    if (this.cycleActive && !this.scrollModeOn) this.scheduleCycleStep();
  },

  // PowerPoint-style push: current board slides out to the left, the new
  // Plant's (already-fetched) data is swapped in off-screen to the right,
  // then it slides into place. Because `data` was fetched ahead of time,
  // the chart rebuild happens while the board is off-screen and invisible,
  // so nothing pops in half-drawn once it slides into view.
  async playSlideTransition(nextPlant, data) {
    const board = this.els.board;

    board.classList.add('tv-slide-out');
    await tvWait(TV_SLIDE_MS);

    // Jump instantly to the staging position on the right (no transition),
    // then swap the content in while it's off-screen.
    board.classList.remove('tv-slide-out');
    board.classList.add('tv-slide-prep');
    void board.offsetWidth; // flush styles so 'transition: none' applies before the jump

    this.els.plantSelect.value = nextPlant;
    localStorage.setItem(TV_PLANT_KEY, nextPlant);
    if (data) {
      this.applyData(nextPlant, data.rows, data.dates, data.h1);
    } else {
      await this.refresh();
    }

    void board.offsetWidth; // flush again so removing tv-slide-prep animates back in

    board.classList.remove('tv-slide-prep');
    await tvWait(TV_SLIDE_MS);
  },

  async refresh() {
    if (this.loading) return;
    this.loading = true;

    const plant = this.els.plantSelect.value;
    const { res, dates, h1 } = await this.fetchPlantData(plant);

    this.loading = false;

    if (!res.ok) {
      if (res.error === 'unauthorized') toast('Sesi berakhir, silakan login kembali.', 'error');
      return;
    }

    this.applyData(plant, res.rows, dates, h1);
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
        // Off on purpose — the plant slide-transition already animates the
        // switch; having the bars also grow in on every 30s auto-cycle (or
        // any refresh) on top of that reads as sluggish/double-animated.
        animation: false,
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
              // Never let Chart.js auto-rotate these — a slanted two-line
              // label reads badly on a narrow phone. Instead, drop straight
              // to a compact single-line label (just the Line name) once
              // there isn't enough room per category for the full
              // "Line X / Total: Y Kg" version, and let autoSkip (still on
              // by default) thin out labels rather than overlap them.
              maxRotation: 0,
              minRotation: 0,
              autoSkipPadding: 6,
              // Scriptable (a function, not a fixed size) so this scales up
              // a bit whenever the chart itself gets taller — Mode Scroll
              // giving this canvas the whole TV screen, above all — but
              // capped modestly: this chart has no scroll fallback, so the
              // 2-line "Line X / Total: Y Kg" label has to reliably fit
              // under the bars instead of pushing the total content taller
              // than one screen and getting clipped off the bottom.
              font: (ctx) => {
                const h = (ctx.chart.chartArea && ctx.chart.chartArea.height) || 300;
                return { size: Math.round(Math.max(12, Math.min(18, h / 45))), weight: '700' };
              },
              color: '#3a0510',
              callback: function (value, index) {
                const perCategoryWidth = this.chart.width / activeLines.length;
                if (perCategoryWidth < 110) return activeLines[index];
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
            // Same reasoning as the bar chart above — no draw-in animation.
            animation: false,
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
              x: {
                grid: { display: false },
                ticks: {
                  maxRotation: 0,
                  minRotation: 0,
                  // Scriptable for the same reason as the bar chart's x-tick
                  // font above — these mini-charts get much taller in Mode
                  // Scroll (a whole TV screen for the trend grid instead of
                  // a shared strip), so a fixed 9.5px reads illegibly small
                  // there even though it's fine in the compact layout.
                  font: (ctx) => {
                    const h = (ctx.chart.chartArea && ctx.chart.chartArea.height) || 60;
                    return { size: Math.round(Math.max(9.5, Math.min(16, h / 8))) };
                  }
                }
              },
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
