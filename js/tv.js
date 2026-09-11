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
// If a trend/rank slide's content doesn't fit on one screen (many Lines, or
// a long Top Rank list), it auto-scrolls through the overflow at this speed
// instead of leaving an unused scrollbar sitting there — taking however
// long that needs (at least TV_SCROLL_SLIDE_MS) before moving on. Kept slow
// on purpose — the trend mini-charts need to actually be readable as they
// scroll past, not just skimmed.
const TV_SCROLL_INNER_SPEED_PX_PER_SEC = 45;
// A trend/rank slide that needs to auto-scroll holds still for this long
// both before the scroll starts (so the first item gets read, not just
// glimpsed) and after it reaches the bottom (so the last item does too),
// instead of the motion starting/ending the instant the slide appears or
// the scroll finishes.
const TV_SCROLL_SETTLE_MS = 3000;
// How long the slide-up/slide-in transition takes when Mode Scroll moves
// from one full-screen panel to the next — must match the CSS transition
// duration on .tv-panel-bar/.tv-panel-rank/.tv-panel-trend in scroll mode.
const TV_SCROLL_TRANSITION_MS = 420;

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
// every Line's bar and its per-shift value in full on one screen, rather
// than text so big it gets clipped off the bottom.
//
// In Mode Scroll specifically, Bos asked for a different arrangement (the
// compact/dense layout keeps the original one): the per-Line Total moves
// OFF the x-axis tick label and is instead drawn big, above that Line's
// tallest bar; the Line name tick label itself also gets bigger; and the
// per-shift value on each bar gets a bit bigger too, but stays smaller
// than the Total text — Total > Line name > per-shift value > shift tag.
// TvBoard.scrollModeOn is read live (not passed in at chart-creation time)
// so this keeps working correctly across Mode Scroll toggling without
// needing to recreate the chart — same trick the font-scaling already uses.
function tvBarDecorationsPlugin(shiftLabels, totals) {
  return {
    id: 'tvBarDecorations',
    // Mode Scroll's big "Total" text (drawn in afterDatasetsDraw below)
    // needs headroom above the tallest bar + its value label, on top of
    // the padding the per-bar value label already needs — reserve it here,
    // before layout runs, so the chart area shrinks to make room instead
    // of the Total text getting clipped at the top of the canvas.
    beforeLayout(chart) {
      const h = chart.height || 300;
      chart.options.layout.padding.top = TvBoard.scrollModeOn
        ? Math.round(Math.max(55, Math.min(95, h / 8)))
        : 22;
    },
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const areaH = (chart.chartArea && chart.chartArea.height) || 300;
      const isScroll = TvBoard.scrollModeOn;
      // Caps raised across the board (Bos: still too small on the actual
      // TV even after the first round of scaling) — Total > Line name >
      // per-shift value > shift tag stays the same hierarchy, just bigger.
      const valueFontPx = isScroll
        ? Math.round(Math.max(20, Math.min(38, areaH / 24)))
        : Math.round(Math.max(11.5, Math.min(20, areaH / 40)));
      const tagFontPx = Math.round(Math.max(24, Math.min(36, areaH / 23)));
      const tagMinBarHeight = Math.max(22, tagFontPx * 2);
      const totalFontPx = Math.round(Math.max(28, Math.min(46, areaH / 16)));

      // Tracks, per category (x-axis index), the topmost pixel any value
      // label reached — so the big Total text (Mode Scroll only) can be
      // drawn above whichever of the 3 shift bars is tallest, never
      // overlapping the value label already sitting on top of it.
      const categoryTopY = new Map();

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
          const labelY = bar.y - Math.max(6, valueFontPx * 0.5);
          ctx.fillText(formatNumberID(value, 1), bar.x, labelY);

          const labelTop = labelY - valueFontPx;
          const prevTop = categoryTopY.get(index);
          if (prevTop === undefined || labelTop < prevTop) categoryTopY.set(index, labelTop);

          if (barHeight > tagMinBarHeight) {
            ctx.fillStyle = dsIndex === 0 ? '#3a0510' : '#ffffff';
            ctx.font = `700 ${tagFontPx}px "Segoe UI", sans-serif`;
            ctx.fillText(shiftLabels[dsIndex], bar.x, bar.base - Math.max(8, tagFontPx * 0.8));
          }
          ctx.restore();
        });
      });

      if (isScroll && totals) {
        const xScale = chart.scales.x;
        totals.forEach((total, index) => {
          if (!total) return;
          const top = categoryTopY.get(index);
          if (top === undefined) return;
          const x = xScale.getPixelForTick(index);
          ctx.save();
          ctx.textAlign = 'center';
          ctx.fillStyle = '#3a0510';
          ctx.font = `800 ${totalFontPx}px "Segoe UI", sans-serif`;
          // Just the number + Kg now (no "Total:" prefix) — Bos: it was
          // eating up space unnecessarily, and the big bold text sitting
          // above the bars already reads as "the total" without saying so.
          ctx.fillText(`${formatNumberID(total, 1)} Kg`, x, top - 12);
          ctx.restore();
        });
      }
    }
  };
}

// Draws the daily value permanently above each point on a trend mini-chart
// — a TV screen has no mouse to hover for Chart.js's built-in tooltip, so
// without this the actual day-to-day numbers were only ever visible for the
// single day highlighted by the (unusable) tooltip. Font size scales off
// the chart's own plotting-area height, same reasoning as the bar chart's
// text above: these cards are much taller in Mode Scroll than in the
// compact dense layout, and a fixed pixel size would read fine in one and
// illegibly small (or oversized) in the other.
// `pctValues` (same length/index as the chart's own data — one per day) adds
// that day's Reject % in parentheses after the Kg value, e.g. "628,0
// (2,53%)" — null for a day with no Output to divide by (see
// renderTrendAndRank), which just prints the Kg value alone.
function tvTrendValueLabelsPlugin(pctValues) {
  return {
    id: 'tvTrendValueLabels',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || meta.hidden) return;
      const ctx = chart.ctx;
      const areaH = (chart.chartArea && chart.chartArea.height) || 90;
      // Cap raised again (Bos: still too small on the actual TV) — Mode
      // Scroll's trend chart height scales with the viewport (see
      // .tv-trend-item-chart in style.css), so a big/high-res TV grows this
      // chart taller and the label font should keep growing right along
      // with it instead of hitting a ceiling too soon.
      const fontPx = Math.round(Math.max(13, Math.min(42, areaH / 4.6)));
      const values = chart.data.datasets[0].data;
      const points = meta.data;
      const last = points.length - 1;

      ctx.save();
      ctx.fillStyle = '#3a0510';
      ctx.font = `700 ${fontPx}px "Segoe UI", sans-serif`;
      points.forEach((point, index) => {
        const value = values[index];
        if (value === null || value === undefined) return;
        const pct = pctValues && pctValues[index];
        const text = pct === null || pct === undefined
          ? formatNumberID(value, 1)
          : `${formatNumberID(value, 1)} (${formatNumberID(pct, 1)}%)`;
        // Center-aligned labels on the first/last point spill past the
        // canvas edge, so those two are anchored to their point instead of
        // straddling it.
        ctx.textAlign = index === 0 ? 'left' : index === last ? 'right' : 'center';
        ctx.fillText(text, point.x, point.y - Math.max(6, fontPx * 0.55));
      });
      ctx.restore();
    }
  };
}

// Mode Sub Dept's version of tvTrendValueLabelsPlugin above — draws a value
// label for BOTH lines on the chart instead of just one, colored to match
// each line so they stay identifiable without a legend. Proses (dataset 0)
// labels sit above its points like the normal single-line view; Packing
// (dataset 1) labels sit below its points instead of stacking on the same
// side, which is what the chart's extra headroom (suggestedMax * 1.5 in
// renderTrendSubDept) is reserved for.
function tvTrendValueLabelsDualPlugin() {
  return {
    id: 'tvTrendValueLabelsDual',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const areaH = (chart.chartArea && chart.chartArea.height) || 90;
      const fontPx = Math.round(Math.max(9, Math.min(26, areaH / 7)));
      ctx.save();
      ctx.font = `700 ${fontPx}px "Segoe UI", sans-serif`;
      chart.data.datasets.forEach((dataset, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if (meta.hidden) return;
        const points = meta.data;
        const last = points.length - 1;
        const values = dataset.data;
        ctx.fillStyle = dataset.borderColor;
        points.forEach((point, index) => {
          const value = values[index];
          if (value === null || value === undefined) return;
          ctx.textAlign = index === 0 ? 'left' : index === last ? 'right' : 'center';
          const y = dsIndex === 0
            ? point.y - Math.max(6, fontPx * 0.55)
            : point.y + fontPx + Math.max(2, fontPx * 0.25);
          ctx.fillText(formatNumberID(value, 1), point.x, y);
        });
      });
      ctx.restore();
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
  scrollAnimRAF: null,
  loading: false,
  fullscreenBound: false,
  // Manual toggle — only ever changes anything while the Plant on screen is
  // 1112/1113 (the two Plants with a Proses/Packing breakdown). Left ON
  // across Auto-Ganti Plant on purpose: Bos wants it to keep applying every
  // time the rotation comes back around to 1112/1113, not reset per-Plant.
  // Other Plants render exactly as before regardless of this flag.
  subDeptModeOn: false,
  // Whatever's currently on screen, cached so toggling Mode Sub Dept can
  // just re-render instantly — the Proses/Packing figures are already part
  // of the rows already fetched, no need to hit the server again.
  currentRows: null,
  currentPlant: null,
  currentDates: null,
  currentH1: null,
  // Connection-trouble tracking: how many refreshes in a row have failed,
  // and the shortened retry timer that fires while trouble is ongoing (see
  // handleRefreshFailure/handleRefreshSuccess below).
  consecutiveFailures: 0,
  retryTimer: null,
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
      connStatus: document.getElementById('tv-conn-status'),
      connStatusText: document.getElementById('tv-conn-status-text'),
      barPlantLabel: document.getElementById('tv-bar-plant-label'),
      barCanvas: document.getElementById('tv-chart-bar'),
      emptyBar: document.getElementById('tv-empty-bar'),
      rankList: document.getElementById('tv-rank-list'),
      rankPlantLabel: document.getElementById('tv-rank-plant-label'),
      emptyRank: document.getElementById('tv-empty-rank'),
      trendGrid: document.getElementById('tv-trend-grid'),
      trendPlantLabel: document.getElementById('tv-trend-plant-label'),
      emptyTrend: document.getElementById('tv-empty-trend'),
      board: document.getElementById('tv-board-body'),
      page: document.getElementById('page-tv'),
      fullscreenBtn: document.getElementById('tv-fullscreen-btn'),
      autorotateBtn: document.getElementById('tv-autorotate-btn'),
      scrollModeBtn: document.getElementById('tv-scrollmode-btn'),
      scrollPauseBtn: document.getElementById('tv-scrollpause-btn'),
      subdeptModeBtn: document.getElementById('tv-subdeptmode-btn'),
      barSubdeptSuffix: document.getElementById('tv-bar-subdept-suffix'),
      rankSubdeptSuffix: document.getElementById('tv-rank-subdept-suffix'),
      trendSubdeptSuffix: document.getElementById('tv-trend-subdept-suffix')
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
        // No slide-to-slide animation here — a manual Plant pick is its own
        // big change (refresh() above already swaps all the data at once).
        this.showScrollSlide(0, { animate: false });
      } else if (this.cycleActive) {
        this.prefetchCache.clear();
        this.startCycle();
      }
    });

    this.els.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.els.autorotateBtn.addEventListener('click', () => this.toggleAutoRotate());
    this.els.scrollModeBtn.addEventListener('click', () => this.toggleScrollMode());
    this.els.scrollPauseBtn.addEventListener('click', () => this.toggleScrollPause());
    this.els.subdeptModeBtn.addEventListener('click', () => this.toggleSubDeptMode());

    if (!this.fullscreenBound) {
      document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
      this.fullscreenBound = true;
    }

    this.updateAutoRotateBtn();
    this.updateScrollModeBtn();
    this.updateSubDeptModeBtn();
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
    this.stopSlideDwell();
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

  // ---------- Mode Sub Dept ----------
  // Independent of Mode Scroll/Auto-Ganti Plant — this just decides HOW the
  // bar/trend/rank panels render for whichever Plant is currently on
  // screen. Only Plant 1112/1113 actually have a Proses/Packing breakdown
  // to show, so renderBar()/renderTrendAndRank() fall back to their normal
  // rendering for every other Plant no matter what this flag is — toggling
  // it is safe to leave on across the whole Auto-Ganti rotation.
  toggleSubDeptMode() {
    this.subDeptModeOn = !this.subDeptModeOn;
    this.updateSubDeptModeBtn();
    // Re-render whatever's already on screen from the cached rows — no need
    // to hit the server again, Proses/Packing are already part of the same
    // fetched rows the normal view uses.
    if (this.currentRows) {
      this.renderBar(this.currentRows, this.currentPlant, this.currentH1);
      this.renderTrendAndRank(this.currentRows, this.currentPlant, this.currentDates);
    }
  },

  updateSubDeptModeBtn() {
    this.els.subdeptModeBtn.textContent = this.subDeptModeOn ? '🧩 Mode Sub Dept: Aktif' : '🧩 Mode Sub Dept';
    this.els.subdeptModeBtn.classList.toggle('active', this.subDeptModeOn);
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
    this.stopSlideDwell();
    if (this.scrollModeOn) {
      // Turning Mode Scroll on implies Auto-Ganti Plant — there'd be nothing
      // to advance to otherwise once the slide sequence finishes.
      if (!this.autoRotateOn) {
        this.autoRotateOn = true;
        this.updateAutoRotateBtn();
      }
      this.stopCycle();
      this.cycleActive = true;
      // Instant reveal — nothing was showing as a Mode Scroll "slide" yet
      // (the compact layout has all 3 panels visible at once), so there's
      // no previous slide to animate away from.
      this.showScrollSlide(0, { animate: false });
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
    this.stopSlideDwell();
    this.updateScrollPauseBtn();
  },

  resumeScrollPaging() {
    if (!this.scrollModeOn || !this.scrollPaused) return;
    this.scrollPaused = false;
    this.updateScrollPauseBtn();
    // armSlideDwell() re-measures scrollTop, so a slide that was mid-scroll
    // continues from exactly where it left off instead of jumping.
    this.armSlideDwell();
  },

  updateScrollPauseBtn() {
    this.els.scrollPauseBtn.textContent = this.scrollPaused ? '▶ Lanjutkan Scroll' : '⏸ Jeda Scroll';
    this.els.scrollPauseBtn.classList.toggle('active', this.scrollPaused);
  },

  // The bar chart is capped (in CSS/JS) to never overflow, so it never
  // scrolls. Trend and rank CAN overflow one screen (e.g. Waferflat's 14
  // Lines), so those two get an actual scrollable element instead — the
  // container that has `overflow-y: auto` in CSS for that slide. Both
  // target the LIST/GRID itself, not the whole panel — keeping each
  // panel's card-title fixed in place while only its content scrolls,
  // so the two behave (and feel) identically.
  getSlideScrollEl(key) {
    if (key === 'trend') return this.els.trendGrid;
    if (key === 'rank') return this.els.rankList;
    return null;
  },

  // Shows TV_SCROLL_SLIDES[index] full-screen and hides the other two, with
  // a conveyor-belt-style slide-up transition between them by default (the
  // old panel lifts up and fades out, the new one rises in from below) so
  // moving to the next chart reads as a continuation of scrolling down
  // rather than an abrupt cut. Pass { animate: false } for a plain instant
  // swap instead — used right after a big Plant change (the horizontal
  // Plant slide-transition already did the "something changed" motion, so
  // stacking a second animation on top of it would just look busy) and when
  // there's no previous slide to animate away from yet (turning Mode Scroll
  // on for the first time).
  async showScrollSlide(index, { animate = true } = {}) {
    const fromKey = TV_SCROLL_SLIDES[this.scrollSlideIndex];
    const toKey = TV_SCROLL_SLIDES[index];
    this.scrollSlideIndex = index;

    if (animate && fromKey !== toKey) {
      await this.playScrollSlideTransition(fromKey, toKey);
    } else {
      Object.entries(this.els.scrollSlideEls).forEach(([key, el]) => {
        el.classList.toggle('tv-scroll-hide', key !== toKey);
      });
    }

    // Clear any scroll position left over from the last time this slide was
    // shown, so it always starts back at the top of its content.
    const scrollEl = this.getSlideScrollEl(toKey);
    if (scrollEl) scrollEl.scrollTop = 0;
    this.armSlideDwell();
  },

  // Conveyor-belt slide: the outgoing panel lifts up and fades out, then
  // (once actually hidden) the incoming one jumps to a "waiting below"
  // position with no transition, gets revealed, and animates up into place.
  // Mirrors the existing Plant-to-Plant playSlideTransition() below — same
  // out/prep/in shape, just vertical instead of horizontal.
  //
  // EXCEPT for the trend panel, which is always swapped instantly instead —
  // profiling a stutter reported right before entering rank traced it to
  // this exact transform animation: trend can hold up to 14 Chart.js
  // canvases, and animating a transform on that subtree forces the browser
  // to promote it onto a fresh GPU compositing layer and rasterize it,
  // which was expensive enough to visibly stall the transition's first
  // frames. Bar and rank have at most one canvas (or none), so animating
  // THEM stays cheap — whichever of the two isn't trend still gets the
  // normal slide, so the transition still reads as continuous motion, just
  // with trend itself popping in/out instantly rather than sliding.
  async playScrollSlideTransition(fromKey, toKey) {
    const fromEl = this.els.scrollSlideEls[fromKey];
    const toEl = this.els.scrollSlideEls[toKey];
    const fromIsHeavy = fromKey === 'trend';
    const toIsHeavy = toKey === 'trend';

    if (fromIsHeavy) {
      fromEl.classList.add('tv-scroll-hide');
    } else {
      fromEl.classList.add('tv-scroll-out');
      await tvWait(TV_SCROLL_TRANSITION_MS);
      fromEl.classList.remove('tv-scroll-out');
      fromEl.classList.add('tv-scroll-hide');
    }

    if (toIsHeavy) {
      toEl.classList.remove('tv-scroll-hide');
    } else {
      toEl.classList.remove('tv-scroll-hide');
      toEl.classList.add('tv-scroll-prep');
      void toEl.offsetWidth; // flush styles so 'transition: none' applies before the jump
      toEl.classList.remove('tv-scroll-prep');
      await tvWait(TV_SCROLL_TRANSITION_MS);
    }
  },

  // Decides how long the current slide stays up. The bar slide (no
  // scrollable element) always gets the plain TV_SCROLL_SLIDE_MS dwell.
  // Trend/rank get that same plain dwell too IF everything already fits on
  // one screen — but the moment it doesn't (more Lines than fit, or a long
  // Top Rank list), this holds still on the very top for a moment (so the
  // first item actually gets read, not just glimpsed as motion starts),
  // then auto-scrolls through the overflow at a fixed speed, then holds
  // still again at the bottom — taking however long all that needs (at
  // least the normal dwell, longer if there's a lot to get through) before
  // moving to the next slide.
  armSlideDwell() {
    this.stopSlideDwell();
    if (!this.scrollModeOn || this.scrollPaused) return;

    const activeKey = TV_SCROLL_SLIDES[this.scrollSlideIndex];

    // On the rank slide, the next step (once its dwell ends) is what moves
    // to the next Plant — start fetching its data now so that slide
    // transition never has to wait on the network.
    if (activeKey === 'rank' && this.cycleActive) {
      const plants = PLANT_ORDER;
      const nextPlant = plants[(plants.indexOf(this.els.plantSelect.value) + 1) % plants.length];
      this.prefetchPlant(nextPlant);
    }

    const scrollEl = this.getSlideScrollEl(activeKey);
    const maxScrollTop = scrollEl ? Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight) : 0;
    const startTop = scrollEl ? scrollEl.scrollTop : 0;
    const distance = Math.max(0, maxScrollTop - startTop);

    if (distance < 20) {
      // Fits on one screen already (or this is the bar slide, which never
      // scrolls) — a plain timed dwell, nothing to animate.
      this.scrollSlideTimer = setTimeout(() => this.advanceScrollSlide(), TV_SCROLL_SLIDE_MS);
      return;
    }

    const scrollDurationMs = (distance / TV_SCROLL_INNER_SPEED_PX_PER_SEC) * 1000;
    const durationMs = Math.max(TV_SCROLL_SLIDE_MS, scrollDurationMs);
    const beginScrolling = () => {
      const startTime = performance.now();
      const step = (now) => {
        if (!this.scrollModeOn || this.scrollPaused) return;
        const t = Math.min(1, (now - startTime) / durationMs);
        scrollEl.scrollTop = startTop + distance * t;
        if (t < 1) {
          this.scrollAnimRAF = requestAnimationFrame(step);
          return;
        }
        // Reached the very bottom — pin it there exactly (rAF timing can
        // land a pixel or two short) and hold still for a moment before
        // moving on, instead of advancing the instant the motion stops.
        scrollEl.scrollTop = maxScrollTop;
        this.scrollAnimRAF = null;
        this.scrollSlideTimer = setTimeout(() => this.advanceScrollSlide(), TV_SCROLL_SETTLE_MS);
      };
      this.scrollAnimRAF = requestAnimationFrame(step);
    };

    // Hold still at the top before the scroll motion starts — same idea as
    // the settle pause at the bottom, mirrored at the beginning, so the
    // topmost item doesn't get skipped past the instant the slide appears.
    // Only applies at the true start (startTop is still 0): resuming from a
    // pause mid-scroll should continue moving right away, not re-pause.
    if (startTop < 1) {
      this.scrollSlideTimer = setTimeout(beginScrolling, TV_SCROLL_SETTLE_MS);
    } else {
      beginScrolling();
    }
  },

  stopSlideDwell() {
    if (this.scrollSlideTimer) { clearTimeout(this.scrollSlideTimer); this.scrollSlideTimer = null; }
    if (this.scrollAnimRAF) { cancelAnimationFrame(this.scrollAnimRAF); this.scrollAnimRAF = null; }
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
    // Flip the visible slide back to bar at the exact same invisible instant
    // the new Plant's data gets swapped in — not before, and not after.
    // Switching it BEFORE advancePlant() runs would show the OLD Plant's bar
    // chart the moment rank's dwell ends, only for the horizontal transition
    // to then carry that stale bar chart away — reading as "it went back to
    // the bar chart, THEN changed Plant". Switching it AFTER (once
    // advancePlant() resolves) would instead leave rank as the active slide
    // throughout the transition, flashing the NEW Plant's Top Rank first.
    // Passing this as advancePlant()'s onDataSwap hook means it runs while
    // the board is off-screen mid-transition (see playSlideTransition) —
    // the same hidden moment the data itself changes — so neither flash can
    // happen: what slides out is the OLD Plant's rank, what slides in is the
    // NEW Plant's bar chart, exactly like a normal Plant advance.
    await this.advancePlant(() => {
      this.scrollSlideIndex = 0;
      Object.entries(this.els.scrollSlideEls).forEach(([key, el]) => {
        el.classList.toggle('tv-scroll-hide', key !== 'bar');
      });
    });
    // Dwell timer only starts now, once the new Plant's bar chart is actually
    // on screen — starting it earlier would eat into the 10s viewing time
    // with however long advancePlant() took.
    if (this.scrollModeOn) this.armSlideDwell();
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
  // for the visible refresh() and for the silent background prefetch (Auto-
  // Ganti Plant / Mode Scroll fetch the *next* Plant ahead of time here, then
  // show it via applyData() directly in playSlideTransition() rather than
  // through refresh()).
  //
  // The connection-status banner is hooked here rather than in refresh()
  // precisely because of that second path: a prefetch succeeding is just as
  // much proof the connection is fine as a visible refresh succeeding is,
  // and a prefetch failing is just as real a connectivity problem — so both
  // need to reach the banner. Hooking it only in refresh() (the original
  // bug) left a stale "Gagal memperbarui data" banner stuck on screen
  // forever once Auto-Ganti Plant switched to using prefetched data, since
  // that path never touched the banner at all — the board could keep
  // showing fresh, correct data on every slide while the banner from one
  // earlier hiccup never went away.
  async fetchPlantData(plant) {
    const dates = tvLast7DatesEndingYesterday();
    const h1 = dates[dates.length - 1];
    const res = await Api.getDashboardData({
      startDate: dates[0],
      endDate: h1,
      plant: [plant]
    });
    this.noteFetchOutcome(res);
    return { res, dates, h1 };
  },

  // 'unauthorized' is deliberately left alone here (not treated as a
  // connection failure) — refresh() surfaces that with its own toast, and
  // an expired session isn't a "check your signal" situation. It's also
  // deliberately not surfaced from a background prefetch at all: that would
  // mean a session could expire mid-cycle and pop a login toast with no
  // visible refresh() ever having run, which reads as the app randomly
  // interrupting itself. It resurfaces naturally the next time a visible
  // refresh() runs.
  noteFetchOutcome(res) {
    if (res.ok) {
      this.handleRefreshSuccess();
    } else if (res.error !== 'unauthorized') {
      this.handleRefreshFailure();
    }
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
    // Cached so toggleSubDeptMode() can re-render instantly without a fresh
    // fetch — see its comment above.
    this.currentRows = rows;
    this.currentPlant = plant;
    this.currentDates = dates;
    this.currentH1 = h1;
    this.els.dateH1.textContent = formatShortDate(h1);
    this.els.barPlantLabel.textContent = plant;
    this.els.trendPlantLabel.textContent = plant;
    this.els.rankPlantLabel.textContent = plant;
    this.els.lastUpdated.textContent = tvFormatClock(new Date());
    this.renderBar(rows, plant, h1);
    this.renderTrendAndRank(rows, plant, dates);
  },

  // Auto-cycle step: waits for the next Plant's data to actually be ready
  // (prefetched ahead of time in the common case, so this resolves
  // instantly — but if the network was slow, this holds the CURRENT Plant
  // on screen rather than switching to something half-loaded) and only
  // then plays the slide transition.
  // `onDataSwap`, if given, runs at the exact moment the new Plant's data is
  // swapped in inside playSlideTransition() — while the board is off-screen
  // and invisible. Mode Scroll uses this to also flip the visible slide back
  // to the bar chart right then, so that hidden instant is the ONLY moment
  // anything changes — see playSlideTransition()'s comment for why.
  async advancePlant(onDataSwap) {
    if (!this.cycleActive) return;
    const plants = PLANT_ORDER;
    const nextPlant = plants[(plants.indexOf(this.els.plantSelect.value) + 1) % plants.length];

    let data = this.prefetchCache.get(nextPlant);
    if (!data) data = await this.prefetchPlant(nextPlant);
    if (!this.cycleActive) return; // fullscreen may have been exited while we waited

    await this.playSlideTransition(nextPlant, data, onDataSwap);
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
  async playSlideTransition(nextPlant, data, onDataSwap) {
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
    // Anything else that should change at the same invisible instant as the
    // data (e.g. Mode Scroll switching its visible slide back to bar) —
    // still off-screen, so it's exactly as unnoticeable as the data swap.
    if (onDataSwap) onDataSwap();

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
      // Banner/retry-backoff already handled inside fetchPlantData() via
      // noteFetchOutcome() — that's the single choke point shared with the
      // background prefetch path, so it stays correct no matter which path
      // actually made the request. Only the unauthorized toast is specific
      // to a *visible* refresh (see noteFetchOutcome()'s comment).
      if (res.error === 'unauthorized') {
        toast('Sesi berakhir, silakan login kembali.', 'error');
      }
      return;
    }

    this.applyData(plant, res.rows, dates, h1);
  },

  // Shows the persistent "Gagal memperbarui data" banner (in the same
  // toolbar row on every Mode Scroll slide, so it's visible no matter which
  // chart is currently on screen) and schedules a faster retry, backing off
  // a little each consecutive failure so a prolonged outage doesn't hammer
  // the API once it's reachable again.
  handleRefreshFailure() {
    this.consecutiveFailures += 1;
    if (this.els.connStatus) {
      this.els.connStatus.hidden = false;
      this.els.connStatusText.textContent = this.consecutiveFailures > 1
        ? `Gagal memperbarui data (${this.consecutiveFailures}x) — cek koneksi`
        : 'Gagal memperbarui data — cek koneksi';
    }
    clearTimeout(this.retryTimer);
    const delaySec = Math.min(60, 10 * this.consecutiveFailures);
    this.retryTimer = setTimeout(() => this.refresh(), delaySec * 1000);
  },

  handleRefreshSuccess() {
    this.consecutiveFailures = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.els.connStatus) this.els.connStatus.hidden = true;
  },

  renderBar(rows, plant, h1) {
    const subdept = this.subDeptModeOn && plantHasSubDept(plant);
    this.els.barSubdeptSuffix.textContent = subdept ? ' (Proses/Packing)' : '';
    if (subdept) {
      this.renderBarSubDept(rows, plant, h1);
      return;
    }
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
      // Shift bars within one Line pressed fully together (no internal gap)
      // and the gap between Lines opened up further, so each Line's 3-bar
      // group reads as one solid cluster that's clearly separated from its
      // neighbors instead of looking like it could blend into them.
      // No maxBarThickness cap: on a plant with only 1-2 Lines the category
      // slot is huge, and a fixed thickness cap left the actual bars far
      // narrower than their allotted slot — which put all that leftover
      // slot space back as visible gaps between S1/S2/S3, undoing the
      // barPercentage/categoryPercentage tightening above. Letting bars
      // fill their slot keeps them touching regardless of how many Lines
      // are on screen (a dense plant's slots are already narrow, so this
      // has no effect there).
      barPercentage: 1,
      categoryPercentage: 0.7
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
                if (TvBoard.scrollModeOn) {
                  // Mode Scroll: the Line name is now the only tick label
                  // (Total moved to the big canvas-drawn text above the
                  // bars), so it can afford to be large and easy to read
                  // from across the room.
                  return { size: Math.round(Math.max(48, Math.min(80, h / 9))), weight: '800' };
                }
                return { size: Math.round(Math.max(12, Math.min(18, h / 45))), weight: '700' };
              },
              color: '#3a0510',
              callback: function (value, index) {
                if (TvBoard.scrollModeOn) return activeLines[index];
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
      plugins: [tvBarDecorationsPlugin(shiftLabels, totals)]
    });
  },

  // Mode Sub Dept's bar chart (Plant 1112/1113 only): instead of 3 bars per
  // Line (one per Shift, each the Shift's combined Total), this draws 6 —
  // Shift 1/2/3 each split into its own Proses and Packing bar, grouped so
  // a Shift's pair sits next to each other (S1-Proses, S1-Packing, S2-...).
  // Same shift color per pair — Proses gets the normal solid shade, Packing
  // a lighter tint of that SAME color — so the Shift grouping still reads
  // the same way at a glance, and the "Ps"/"Pk" tag on each bar (drawn by
  // the same tvBarDecorationsPlugin the normal view uses) says which is
  // which regardless. Total/Line-name tick label and the Mode Scroll big
  // Total text above the bars are unchanged — both still read off the
  // Total column, same as the normal view.
  renderBarSubDept(rows, plant, h1) {
    const lines = PLANT_CONFIG[plant] || [];
    const perLine = new Map();
    rows.forEach((r) => {
      if (r.tanggal !== h1) return;
      if (!perLine.has(r.line)) {
        perLine.set(r.line, {
          1: { proses: 0, packing: 0 }, 2: { proses: 0, packing: 0 }, 3: { proses: 0, packing: 0 }, total: 0
        });
      }
      const e = perLine.get(r.line);
      const shiftKey = String(r.shift);
      if (e[shiftKey]) {
        e[shiftKey].proses += Number(r.rejectProses) || 0;
        e[shiftKey].packing += Number(r.rejectPackaging) || 0;
      }
      e.total += Number(r.reject) || 0;
    });

    const activeLines = lines.filter((l) => perLine.has(l));
    this.els.emptyBar.hidden = activeLines.length > 0;
    if (!activeLines.length) {
      if (this.chart) { this.chart.destroy(); this.chart = null; }
      return;
    }

    const totals = activeLines.map((l) => perLine.get(l).total);
    const shiftColorsSolid = { 1: '#d8b370', 2: '#c81e3a', 3: '#55091a' };
    const shiftColorsLight = { 1: '#ecd9b3', 2: '#e58a97', 3: '#a3707c' };

    const datasets = [];
    const tags = [];
    ['1', '2', '3'].forEach((shiftKey) => {
      datasets.push({
        label: `Shift ${shiftKey} - Proses`,
        data: activeLines.map((l) => Number((perLine.get(l)[shiftKey].proses || 0).toFixed(3))),
        backgroundColor: shiftColorsSolid[shiftKey],
        borderRadius: 4,
        barPercentage: 1,
        categoryPercentage: 0.86
      });
      tags.push('Ps');
      datasets.push({
        label: `Shift ${shiftKey} - Packing`,
        data: activeLines.map((l) => Number((perLine.get(l)[shiftKey].packing || 0).toFixed(3))),
        backgroundColor: shiftColorsLight[shiftKey],
        borderRadius: 4,
        barPercentage: 1,
        categoryPercentage: 0.86
      });
      tags.push('Pk');
    });

    if (this.chart) this.chart.destroy();
    this.chart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels: activeLines, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
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
              maxRotation: 0,
              minRotation: 0,
              autoSkipPadding: 6,
              font: (ctx) => {
                const h = (ctx.chart.chartArea && ctx.chart.chartArea.height) || 300;
                if (TvBoard.scrollModeOn) {
                  return { size: Math.round(Math.max(48, Math.min(80, h / 9))), weight: '800' };
                }
                return { size: Math.round(Math.max(12, Math.min(18, h / 45))), weight: '700' };
              },
              color: '#3a0510',
              callback: function (value, index) {
                if (TvBoard.scrollModeOn) return activeLines[index];
                // 6 bars per Line needs more room per category before the
                // 2-line label still fits than the normal 3-bar view does.
                const perCategoryWidth = this.chart.width / activeLines.length;
                if (perCategoryWidth < 170) return activeLines[index];
                const total = totals[index];
                return [activeLines[index], `Total: ${formatNumberID(total, 1)} Kg`];
              }
            }
          },
          y: { display: false }
        }
      },
      plugins: [tvBarDecorationsPlugin(tags, totals)]
    });
  },

  renderTrendAndRank(rows, plant, dates) {
    const subdept = this.subDeptModeOn && plantHasSubDept(plant);
    this.els.rankSubdeptSuffix.textContent = subdept ? ' — Proses/Packing' : '';
    this.els.trendSubdeptSuffix.textContent = subdept ? ' (Proses/Packing)' : '';
    if (subdept) {
      this.renderTrendAndRankSubDept(rows, plant, dates);
      return;
    }
    const lines = PLANT_CONFIG[plant] || [];
    const byLine = new Map();
    // Tracks Output alongside Reject, per day — Reject alone was already
    // enough for the Kg values plotted on the line, but the trend point
    // labels also show that day's Reject % now, which needs that day's
    // Output too (same reject/output*100 the dashboard/backend use
    // everywhere else — not a separate calculation).
    lines.forEach((l) => byLine.set(l, {
      reject: new Map(dates.map((d) => [d, 0])),
      output: new Map(dates.map((d) => [d, 0]))
    }));

    rows.forEach((r) => {
      const entry = byLine.get(r.line);
      if (!entry || !entry.reject.has(r.tanggal)) return;
      entry.reject.set(r.tanggal, entry.reject.get(r.tanggal) + (Number(r.reject) || 0));
      entry.output.set(r.tanggal, entry.output.get(r.tanggal) + (Number(r.output) || 0));
    });

    const summary = [];
    byLine.forEach(({ reject: rejectByDay, output: outputByDay }, line) => {
      const values = dates.map((d) => Number(rejectByDay.get(d).toFixed(3)));
      const total = Number(values.reduce((a, b) => a + b, 0).toFixed(3));
      if (total <= 0) return;
      // Only meaningful (and only computed) for days that actually have
      // Output — a day with no data at all would otherwise divide 0/0.
      const pctValues = dates.map((d, i) => {
        const out = outputByDay.get(d);
        return out > 0 ? Number(((values[i] / out) * 100).toFixed(2)) : null;
      });
      // Average is total divided by however many days actually have reject
      // data, NOT a fixed /7 — a Line that only reported on 2 of the 7 days
      // gets its average from those 2 days, not diluted by 5 empty ones.
      const activeDays = values.filter((v) => v > 0);
      const daysWithData = activeDays.length || 1;
      summary.push({
        line,
        values,
        pctValues,
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

  // Mode Sub Dept's version of the above — same per-Line/per-day tracking,
  // just Proses and Packing kept as two separate series (plus Output, for
  // completeness/future use) instead of one combined Reject series. Feeds
  // renderTrendSubDept() (2 lines per mini-chart) and renderRankSubDept()
  // (2 independent Top Rank lists) below.
  renderTrendAndRankSubDept(rows, plant, dates) {
    const lines = PLANT_CONFIG[plant] || [];
    const byLine = new Map();
    lines.forEach((l) => byLine.set(l, {
      proses: new Map(dates.map((d) => [d, 0])),
      packing: new Map(dates.map((d) => [d, 0]))
    }));

    rows.forEach((r) => {
      const entry = byLine.get(r.line);
      if (!entry || !entry.proses.has(r.tanggal)) return;
      entry.proses.set(r.tanggal, entry.proses.get(r.tanggal) + (Number(r.rejectProses) || 0));
      entry.packing.set(r.tanggal, entry.packing.get(r.tanggal) + (Number(r.rejectPackaging) || 0));
    });

    const summary = [];
    byLine.forEach(({ proses: prosesByDay, packing: packingByDay }, line) => {
      const prosesValues = dates.map((d) => Number(prosesByDay.get(d).toFixed(3)));
      const packingValues = dates.map((d) => Number(packingByDay.get(d).toFixed(3)));
      const prosesTotal = Number(prosesValues.reduce((a, b) => a + b, 0).toFixed(3));
      const packingTotal = Number(packingValues.reduce((a, b) => a + b, 0).toFixed(3));
      if (prosesTotal <= 0 && packingTotal <= 0) return;

      // Each Sub Dept gets its own "days with data" divisor, same reasoning
      // as the normal view's average — a Line that only had Packing reject
      // on 2 of 7 days gets its Packing average from those 2 days, not
      // diluted by days that had none.
      const prosesActiveDays = prosesValues.filter((v) => v > 0);
      const packingActiveDays = packingValues.filter((v) => v > 0);
      const prosesDaysWithData = prosesActiveDays.length || 1;
      const packingDaysWithData = packingActiveDays.length || 1;

      summary.push({
        line,
        prosesValues,
        packingValues,
        prosesTotal,
        packingTotal,
        prosesAvg: prosesTotal / prosesDaysWithData,
        packingAvg: packingTotal / packingDaysWithData,
        prosesDaysWithData,
        packingDaysWithData
      });
    });

    this.renderTrendSubDept(summary, dates);
    this.renderRankSubDept(summary);
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
        // Max/Min/Avg sit beside the chart (not above it) in the default
        // board/Auto-Ganti view — Bos asked for this so the chart itself
        // gets the vertical room to make its rise/fall obvious, instead of
        // losing a slice of height to a stats row above it. Mode Scroll
        // keeps the old above-the-chart layout on purpose (Bos: "kalau yg
        // mode scroll pertahankan saja") — .tv-trend-item-body/-stats get a
        // scroll-mode-specific override back to that in style.css, since
        // both modes share this same markup.
        card.innerHTML = `
          <div class="tv-trend-item-head">
            <span class="tv-trend-item-line">${escapeHtml(entry.line)}</span>
            <span class="tv-trend-item-total">Total: ${formatNumberID(entry.total, 1)} Kg</span>
          </div>
          <div class="tv-trend-item-body">
            <div class="tv-trend-item-chart"><canvas></canvas></div>
            <div class="tv-trend-item-stats">
              <span>Max <b>${formatNumberID(entry.max, 1)}</b></span>
              <span>Min <b>${formatNumberID(entry.min, 1)}</b></span>
              <span>Avg <b>${formatNumberID(entry.avg, 1)}</b></span>
            </div>
          </div>
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
                    // Cap raised from 16 to 20 for the same reason as
                    // tvTrendValueLabelsPlugin's cap above — this chart can
                    // now render taller on a big TV, so the old ceiling was
                    // the thing making the date labels look stuck-small.
                    return { size: Math.round(Math.max(9.5, Math.min(20, h / 8))) };
                  }
                }
              },
              // Headroom above the highest point so its always-on value
              // label (tvTrendValueLabelsPlugin below) has room to sit
              // above the line instead of getting clipped against the top
              // of the chart or crossed out by the dashed Max reference.
              y: { display: false, suggestedMax: entry.max * 1.3 }
            }
          },
          plugins: [tvTrendValueLabelsPlugin(entry.pctValues)]
        });
        this.trendCharts.push(chart);
      });
  },

  // Mode Sub Dept's version: same card layout, but each mini-chart draws
  // TWO lines (Proses/Packing) instead of one Total line — the dashed
  // Max/Rata-rata reference lines are dropped here since those referred to
  // a single combined metric that no longer exists in this view. The card
  // head's "Total: X Kg" becomes two color-matched totals instead (styled
  // in css/style.css), so it's still obvious which line is which without a
  // separate legend eating into the TV screen.
  renderTrendSubDept(summary, dates) {
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
            <span class="tv-trend-item-total tv-trend-item-total-subdept">
              <b class="tv-subdept-proses-tag">Proses ${formatNumberID(entry.prosesTotal, 1)} Kg</b>
              <b class="tv-subdept-packing-tag">Packing ${formatNumberID(entry.packingTotal, 1)} Kg</b>
            </span>
          </div>
          <div class="tv-trend-item-body">
            <div class="tv-trend-item-chart"><canvas></canvas></div>
            <div class="tv-trend-item-stats">
              <span>Proses Avg <b>${formatNumberID(entry.prosesAvg, 1)}</b></span>
              <span>Packing Avg <b>${formatNumberID(entry.packingAvg, 1)}</b></span>
            </div>
          </div>
        `;
        this.els.trendGrid.appendChild(card);

        const canvas = card.querySelector('canvas');
        const maxVal = Math.max(...entry.prosesValues, ...entry.packingValues, 0.001);

        const chart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Proses',
                data: entry.prosesValues,
                borderColor: '#9c1029',
                backgroundColor: 'rgba(200,30,58,0.10)',
                fill: true,
                tension: 0.35,
                pointRadius: 2.5,
                pointBackgroundColor: '#9c1029',
                borderWidth: 2
              },
              {
                label: 'Packing',
                data: entry.packingValues,
                borderColor: '#1b6fa8',
                backgroundColor: 'rgba(27,111,168,0.10)',
                fill: true,
                tension: 0.35,
                pointRadius: 2.5,
                pointBackgroundColor: '#1b6fa8',
                borderWidth: 2
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#3a0510',
                padding: 8,
                cornerRadius: 8,
                callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatNumberID(ctx.parsed.y, 2)} Kg` }
              }
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: {
                  maxRotation: 0,
                  minRotation: 0,
                  font: (ctx) => {
                    const h = (ctx.chart.chartArea && ctx.chart.chartArea.height) || 60;
                    return { size: Math.round(Math.max(9.5, Math.min(20, h / 8))) };
                  }
                }
              },
              // Extra headroom (1.5x vs the normal view's 1.3x) — this chart
              // stacks a Proses label above AND a Packing label below each
              // pair of points (see tvTrendValueLabelsDualPlugin), so it
              // needs more vertical room than a single-line label does.
              y: { display: false, suggestedMax: maxVal * 1.5 }
            }
          },
          plugins: [tvTrendValueLabelsDualPlugin()]
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
  },

  // Mode Sub Dept's version: instead of one combined Top Rank list, two
  // independent ones side by side — Top Proses on the left, Top Packing on
  // the right — each ranked by that Sub Dept's own average, reusing the
  // exact same row markup/classes as the normal view (medal colors, avg
  // value styling, etc. all still apply).
  renderRankSubDept(summary) {
    this.els.emptyRank.hidden = summary.length > 0;
    this.els.rankList.innerHTML = '';
    if (!summary.length) return;

    const medalClass = ['tv-rank-1', 'tv-rank-2', 'tv-rank-3'];
    const buildCol = (title, ranked, avgKey, totalKey, daysKey) => {
      const col = document.createElement('div');
      col.className = 'tv-rank-col';
      const head = document.createElement('div');
      head.className = 'tv-rank-col-title';
      head.textContent = title;
      col.appendChild(head);
      ranked.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = `tv-rank-row ${medalClass[index] || ''}`;
        row.innerHTML = `
          <div class="tv-rank-pos">${index + 1}</div>
          <div class="tv-rank-info">
            <div class="tv-rank-line">${escapeHtml(entry.line)}</div>
            <div class="tv-rank-total">Total 7 hari: ${formatNumberID(entry[totalKey], 1)} Kg (${entry[daysKey]} hari data)</div>
          </div>
          <div class="tv-rank-avg">
            <div class="tv-rank-avg-value">${formatNumberID(entry[avgKey], 1)}</div>
            <div class="tv-rank-avg-label">Kg/hari</div>
          </div>
        `;
        col.appendChild(row);
      });
      return col;
    };

    const prosesRanked = summary.slice().sort((a, b) => b.prosesAvg - a.prosesAvg).slice(0, TV_TOP_RANK_COUNT);
    const packingRanked = summary.slice().sort((a, b) => b.packingAvg - a.packingAvg).slice(0, TV_TOP_RANK_COUNT);

    const wrap = document.createElement('div');
    wrap.className = 'tv-rank-subdept-split';
    wrap.appendChild(buildCol('Reject Proses', prosesRanked, 'prosesAvg', 'prosesTotal', 'prosesDaysWithData'));
    wrap.appendChild(buildCol('Reject Packing', packingRanked, 'packingAvg', 'packingTotal', 'packingDaysWithData'));
    this.els.rankList.appendChild(wrap);
  }
};
