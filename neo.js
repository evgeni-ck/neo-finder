/* neo-finder — client-side map finder for engine-controller flash dumps.
 * No dependencies, no build step, no network. Works from file:// and from Pages.
 *
 * ScannerLib is written as a self-contained function with no free variables,
 * because it is stringified into the Web Worker. Keep it that way: one source
 * of truth for the scan, running in both places.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * 1. Scanner — the structural predicate. Exact, no ECU knowledge.
 * ------------------------------------------------------------------ */
function ScannerLib() {

  var VARIANTS = [
    { id: 'be2', le: false, w: 2, label: '16-bit BE' },
    { id: 'le2', le: true,  w: 2, label: '16-bit LE' },
    { id: 'be1', le: false, w: 1, label: '8-bit data, BE axes' },
    { id: 'le1', le: true,  w: 1, label: '8-bit data, LE axes' }
  ];

  var MIN_NX = 3, MAX_NX = 64, MIN_NY = 1, MAX_NY = 64;
  var MIN_CHAIN_BYTES = 200;   // a chain must cover this much to be considered

  function scan(bytes, le, w, onProgress) {
    var n = bytes.length;
    var rd16 = le
      ? function (o) { return bytes[o] | (bytes[o + 1] << 8); }
      : function (o) { return (bytes[o] << 8) | bytes[o + 1]; };

    function mono(o, cnt) {
      var prev = rd16(o);
      for (var i = 1; i < cnt; i++) {
        var v = rd16(o + i * 2);
        if (v <= prev) return false;
        prev = v;
      }
      return true;
    }

    // the predicate: two plausible counts, two monotonic axes of exactly those
    // lengths, and a self-consistent total length that fits inside the file
    function at(o) {
      if (o + 4 > n) return null;
      var nx = rd16(o);
      if (nx < MIN_NX || nx > MAX_NX) return null;
      var ny = rd16(o + 2);
      if (ny < MIN_NY || ny > MAX_NY) return null;
      var len = 4 + 2 * nx + 2 * ny + w * nx * ny;
      if (o + len > n) return null;
      var xo = o + 4, yo = xo + 2 * nx;
      if (!mono(xo, nx)) return null;
      if (ny > 1 && !mono(yo, ny)) return null;
      return { off: o, nx: nx, ny: ny, len: len, xo: xo, yo: yo, dt: yo + 2 * ny };
    }

    var hits = [], o, step = 0x10000, nextReport = step;
    for (o = 0; o + 4 <= n; o += 2) {
      var m = at(o);
      if (m) hits.push(m);
      if (onProgress && o >= nextReport) { onProgress(o / n); nextReport += step; }
    }

    // chain forward: a genuine map is followed immediately by the next one
    var chains = [], i;
    for (i = 0; i < hits.length; i++) {
      var ch = [], p = hits[i].off, q;
      while ((q = at(p))) { ch.push(q); p = q.off + q.len; }
      var cov = 0;
      for (var k = 0; k < ch.length; k++) cov += ch[k].len;
      if (cov >= MIN_CHAIN_BYTES) chains.push({ start: hits[i].off, ch: ch, cov: cov });
    }

    // greedy non-overlap, widest coverage first
    chains.sort(function (a, b) { return b.cov - a.cov || a.start - b.start; });
    var taken = [], kept = [], maps = [];
    for (i = 0; i < chains.length; i++) {
      var c = chains[i], s = c.start, e = c.start + c.cov, clash = false;
      for (var t = 0; t < taken.length; t++) {
        if (s < taken[t][1] && e > taken[t][0]) { clash = true; break; }
      }
      if (clash) continue;
      taken.push([s, e]);
      kept.push(c);
      for (var j = 0; j < c.ch.length; j++) maps.push(c.ch[j]);
    }
    maps.sort(function (a, b) { return a.off - b.off; });

    // value stats per map, needed for naming and for the flat/unused test
    var covered = 0;
    for (i = 0; i < maps.length; i++) {
      var mm = maps[i], cnt = mm.nx * mm.ny, lo = Infinity, hi = -Infinity;
      for (j = 0; j < cnt; j++) {
        var v = w === 2 ? rd16(mm.dt + j * 2) : bytes[mm.dt + j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mm.min = lo; mm.max = hi; mm.flat = (lo === hi);
      mm.chainLen = 0;
      covered += mm.len;
    }
    for (i = 0; i < kept.length; i++) {
      for (j = 0; j < kept[i].ch.length; j++) kept[i].ch[j].chainLen = kept[i].ch.length;
    }

    var lengths = {};
    for (i = 0; i < kept.length; i++) {
      lengths[kept[i].ch.length] = (lengths[kept[i].ch.length] || 0) + 1;
    }
    return {
      le: le, w: w, maps: maps, rawHits: hits.length, covered: covered,
      chains: kept.length, chainLengths: lengths, size: n
    };
  }

  /* Try every container variant and keep whichever covers the most bytes in
   * accepted chains. An objective criterion, and the margin is reported so a
   * weak call is visible rather than silent. */
  function autoDetect(bytes, onProgress) {
    var all = [], i;
    for (i = 0; i < VARIANTS.length; i++) {
      var v = VARIANTS[i];
      var r = scan(bytes, v.le, v.w, function (frac) {
        if (onProgress) onProgress((i + frac) / VARIANTS.length);
      });
      r.variant = v.id; r.variantLabel = v.label;
      all.push(r);
    }
    var best = all[0];
    for (i = 1; i < all.length; i++) if (all[i].covered > best.covered) best = all[i];
    return {
      best: best,
      summary: all.map(function (r) {
        return { variant: r.variant, label: r.variantLabel, maps: r.maps.length,
                 covered: r.covered, rawHits: r.rawHits };
      })
    };
  }

  return { VARIANTS: VARIANTS, scan: scan, autoDetect: autoDetect };
}

var Scanner = ScannerLib();

/* ------------------------------------------------------------------ *
 * 2. Naming — a rule pack, deliberately data and not code.
 * ------------------------------------------------------------------ */
var DEFAULT_RULES = {
  /* `role` matters: rpm and iq axes overlap heavily in raw range (an iq axis of
   * 400…5000 is indistinguishable from an rpm axis by value alone), so the
   * position in the container does the disambiguating. In this format the X
   * axis is the speed axis and the Y axis is the load axis. pedal and coolant
   * have fingerprints distinctive enough to match in either position. */
  axisKinds: [
    { kind: 'pedal', role: 'any', unit: '%', factor: 0.01220703125,
      test: { minPoints: 8, lastMin: 8100, lastMax: 8400, nearAll: [819, 1638, 4096] } },
    { kind: 'coolant', role: 'any', unit: '°C', factor: 0.1, offset: -273.1,
      test: { minPoints: 4, firstMin: 2200, firstMax: 2750, lastMin: 2850, lastMax: 3900 } },
    { kind: 'rpm', role: 'x', unit: 'rpm', factor: 1,
      test: { minPoints: 6, firstMax: 1300, lastMin: 2800, lastMax: 8000 } },
    { kind: 'iq', role: 'y', unit: 'mg/stroke', factor: 0.01,
      test: { minPoints: 6, firstMax: 700, lastMin: 2500, lastMax: 12000 } },
    { kind: 'index', role: 'any', unit: '', factor: 1, test: { lastMax: 64 } }
  ],
  /* First match wins, so order is the disambiguation mechanism. trendX/trendY
   * compare the mean of the top third of an axis against the bottom third —
   * that is what separates a boost map from a timing map when their value
   * ranges overlap. */
  maps: [
    { label: 'Driver wish – requested injection quantity', x: 'rpm', y: 'pedal',
      unit: 'mg/stroke', factor: 0.01, confidence: 'high',
      note: 'quantity request; zero rows at the top of the rpm axis are the fuel cut' },

    { label: 'Rail pressure setpoint', x: 'rpm', y: 'iq',
      dataMax: [11000, 17000], trendX: 'up', trendY: 'up',
      unit: 'bar', factor: 0.1, confidence: 'high',
      note: 'a large plateau exactly at the maximum is the pump limit, not a setpoint' },

    { label: 'Injection timing', x: 'rpm', y: 'iq',
      dataMin: [900, 1900], dataMax: [2000, 3200], trendX: 'down',
      unit: '°CA', factor: 0.01, confidence: 'medium',
      note: 'falls with rising speed; pilot or main start-of-injection' },

    { label: 'Boost pressure setpoint', x: 'rpm', y: 'iq',
      dataMin: [600, 1500], dataMax: [1700, 3200], trendY: 'up',
      unit: 'mbar abs', factor: 1, confidence: 'high',
      note: 'the floor near 1000 is ambient pressure, i.e. no boost demand' },

    { label: 'EGR / air-path setpoint', x: 'rpm', y: 'iq',
      dataMin: [50, 600], dataMax: [1500, 3500], trendY: 'down',
      unit: 'raw', factor: 1, confidence: 'low',
      note: 'a hard step rather than a gradient suggests shut-off past a load threshold; could also be a flap actuator' },

    { label: 'Duty / position', x: 'rpm', y: 'iq',
      dataMax: [5000, 8300], unit: '%', factor: 0.01220703125, confidence: 'medium',
      note: '8192 = 100 %, so this is a normalised actuator demand' },

    { label: 'Temperature correction', x: 'rpm', y: 'coolant',
      unit: 'raw', factor: 1, confidence: 'medium',
      note: 'coolant-indexed trim, typically cold-running enrichment or timing' },

    { label: 'Quantity limiter', x: 'rpm', y: 'iq',
      dataMax: [2500, 5000], trendX: 'down', unit: 'mg/stroke', factor: 0.01,
      confidence: 'low', note: 'upper bound on quantity; often the smoke limiter' }
  ]
};

var RuleEngine = (function () {

  function nearAny(axis, want, tol) {
    for (var i = 0; i < axis.length; i++) if (Math.abs(axis[i] - want) <= tol) return true;
    return false;
  }

  function kindOf(axis, rules, role) {
    if (!axis.length) return null;
    var first = axis[0], last = axis[axis.length - 1];
    for (var i = 0; i < rules.axisKinds.length; i++) {
      var k = rules.axisKinds[i], t = k.test || {};
      if (role && k.role && k.role !== 'any' && k.role !== role) continue;
      if (t.minPoints != null && axis.length < t.minPoints) continue;
      if (t.firstMin != null && first < t.firstMin) continue;
      if (t.firstMax != null && first > t.firstMax) continue;
      if (t.lastMin != null && last < t.lastMin) continue;
      if (t.lastMax != null && last > t.lastMax) continue;
      if (t.nearAll) {
        var all = true;
        for (var j = 0; j < t.nearAll.length; j++) {
          if (!nearAny(axis, t.nearAll[j], Math.max(4, t.nearAll[j] * 0.03))) { all = false; break; }
        }
        if (!all) continue;
      }
      return k;
    }
    return null;
  }

  // mean of the top third of an axis minus mean of the bottom third
  function trend(get, nOuter, nInner) {
    if (nOuter < 3) return 0;
    var third = Math.max(1, Math.floor(nOuter / 3));
    var lo = 0, hi = 0, cl = 0, ch = 0, i, j;
    for (i = 0; i < third; i++) for (j = 0; j < nInner; j++) { lo += get(i, j); cl++; }
    for (i = nOuter - third; i < nOuter; i++) for (j = 0; j < nInner; j++) { hi += get(i, j); ch++; }
    var d = (hi / ch) - (lo / cl);
    var scale = Math.max(1, Math.abs(lo / cl));
    if (d > scale * 0.05) return 1;
    if (d < -scale * 0.05) return -1;
    return 0;
  }

  function want(dir) { return dir === 'up' ? 1 : dir === 'down' ? -1 : 0; }

  function classify(view, rules) {
    var xk = kindOf(view.X, rules, 'x');
    var yk = view.ny > 1 ? kindOf(view.Y, rules, 'y') : null;
    var res = { xKind: xk, yKind: yk, rule: null };
    var tx = null, ty = null;
    for (var i = 0; i < rules.maps.length; i++) {
      var r = rules.maps[i];
      if (r.x && (!xk || xk.kind !== r.x)) continue;
      if (r.y && (!yk || yk.kind !== r.y)) continue;
      if (r.dataMin && (view.min < r.dataMin[0] || view.min > r.dataMin[1])) continue;
      if (r.dataMax && (view.max < r.dataMax[0] || view.max > r.dataMax[1])) continue;
      if (r.trendX) {
        if (tx === null) tx = trend(function (a, b) { return view.at(a, b); }, view.nx, view.ny);
        if (tx !== want(r.trendX)) continue;
      }
      if (r.trendY) {
        if (ty === null) ty = trend(function (a, b) { return view.at(b, a); }, view.ny, view.nx);
        if (ty !== want(r.trendY)) continue;
      }
      res.rule = r;
      break;
    }
    return res;
  }

  return { classify: classify, kindOf: kindOf };
})();

/* ------------------------------------------------------------------ *
 * 3. App state and small helpers
 * ------------------------------------------------------------------ */
var $ = function (id) { return document.getElementById(id); };
var RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
            '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
var RGB = RAMP.map(function (h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
});
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  var p = t * (RGB.length - 1), i = Math.min(RGB.length - 2, Math.floor(p)), f = p - i;
  var c = [0, 1, 2].map(function (k) { return Math.round(RGB[i][k] + (RGB[i + 1][k] - RGB[i][k]) * f); });
  return 'rgb(' + c.join(',') + ')';
}
function hx(v, pad) { return v.toString(16).toUpperCase().padStart(pad || 6, '0'); }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function fmtBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 2 : 0) + ' MiB'
       : n >= 1024 ? (n / 1024).toFixed(0) + ' KiB' : n + ' B';
}
function scaleVal(v, r) {
  if (!r) return String(v);
  var x = v * (r.factor == null ? 1 : r.factor) + (r.offset || 0);
  var a = Math.abs(x);
  return a >= 1000 ? x.toFixed(0) : a >= 100 ? x.toFixed(1) : x.toFixed(2);
}

var S = {
  name: '', bytes: null,
  result: null, summary: null, rules: DEFAULT_RULES, maps: [], groups: [],
  strips: [], zoom: 4
};

/* a compact accessor over one map, X-major storage */
function viewOf(m) {
  var b = S.bytes, le = S.result.le, w = S.result.w;
  var rd16 = le ? function (o) { return b[o] | (b[o + 1] << 8); }
                : function (o) { return (b[o] << 8) | b[o + 1]; };
  function ax(o, n) { var a = []; for (var i = 0; i < n; i++) a.push(rd16(o + i * 2)); return a; }
  function at(ix, iy) {
    var i = ix * m.ny + iy;
    return w === 2 ? rd16(m.dt + i * 2) : b[m.dt + i];
  }
  return { m: m, nx: m.nx, ny: m.ny, min: m.min, max: m.max,
           X: ax(m.xo, m.nx), Y: ax(m.yo, m.ny), at: at };
}

/* ------------------------------------------------------------------ *
 * 4. Classify + group into named regions
 * ------------------------------------------------------------------ */
function classifyAll() {
  S.maps = S.result.maps;
  for (var i = 0; i < S.maps.length; i++) {
    var m = S.maps[i], v = viewOf(m);
    var c = RuleEngine.classify(v, S.rules);
    m.rule = c.rule; m.xKind = c.xKind; m.yKind = c.yKind;
    m.label = c.rule ? c.rule.label : null;
  }
  // group consecutive maps sharing a label (or both unnamed with equal shape)
  S.groups = [];
  var g = null;
  for (i = 0; i < S.maps.length; i++) {
    m = S.maps[i];
    var key = m.label || ('?' + m.nx + 'x' + m.ny + '/' + (m.xKind ? m.xKind.kind : '-'));
    var contiguous = g && (m.off - g.end) <= 64;
    if (g && g.key === key && contiguous) {
      g.end = m.off + m.len; g.count++; g.members.push(m);
      g.min = Math.min(g.min, m.min); g.max = Math.max(g.max, m.max);
    } else {
      if (g) S.groups.push(g);
      g = { key: key, label: m.label, rule: m.rule, start: m.off, end: m.off + m.len,
            count: 1, nx: m.nx, ny: m.ny, members: [m],
            min: m.min, max: m.max, flat: m.flat };
    }
  }
  if (g) S.groups.push(g);
}

/* ------------------------------------------------------------------ *
 * 5. Canvas rendering — everything is drawn, so PNG export is exact
 * ------------------------------------------------------------------ */
/* Geometry is derived from the available width rather than fixed, so the same
 * drawing code serves a phone and a wide monitor. Below MIN_CSS the strip
 * container scrolls horizontally instead of squashing the plot into
 * unreadability. */
var MIN_CSS = 680;

function layoutWidth() {
  var host = $('stripwrap');
  var avail = (host && host.clientWidth) || document.documentElement.clientWidth || 1200;
  return Math.max(MIN_CSS, avail);
}

function geomFor(cssW) {
  var narrow = cssW < 820;
  return {
    left: narrow ? 46 : 92,
    right: narrow ? 12 : 46,
    plotH: narrow ? 104 : 132,
    axisH: narrow ? 30 : 34,
    lineH: narrow ? 22 : 24,
    labPad: narrow ? 26 : 34,
    narrow: narrow,
    // one tick per ~130px, so hex addresses never collide
    ticks: Math.max(2, Math.min(8, Math.floor((cssW - (narrow ? 58 : 138)) / 130)))
  };
}

function groupText(g) {
  var t = hx(g.start) + '  ' + (g.label || (g.count + ' × ' + g.nx + '×' + g.ny));
  var bits = [];
  if (g.count > 1) bits.push(g.count + ' × ' + g.nx + '×' + g.ny);
  else bits.push(g.nx + '×' + g.ny);
  if (g.rule) bits.push(scaleVal(g.min, g.rule) + '–' + scaleVal(g.max, g.rule) + ' ' + g.rule.unit);
  else bits.push('raw ' + g.min + '–' + g.max);
  if (g.rule && g.rule.confidence) bits.push(g.rule.confidence + ' confidence');
  return { t: t, s: bits.join(' · ') };
}

/* Zoom is expressed as bytes of address space per row: zooming in spreads a row
 * over less of the file, so each table gets more pixels. */
var ZOOM_LEVELS = [0x800, 0x1000, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000];

function zoomLabel() {
  $('zoom-in').disabled = S.zoom === 0;
  $('zoom-out').disabled = S.zoom === ZOOM_LEVELS.length - 1;
}

function setZoom(delta) {
  var next = S.zoom - delta;                 // +1 = zoom in = smaller row span
  if (next < 0 || next >= ZOOM_LEVELS.length) return;
  S.zoom = next;
  zoomLabel();
  renderStrips();
}

function planStrips(cssW, G) {
  var rowSize = ZOOM_LEVELS[S.zoom];
  var onlyMaps = $('onlymaps').checked;
  var n = S.bytes.length, strips = [];
  var meas = document.createElement('canvas').getContext('2d');
  var maxLvl = 0;
  var plotW = cssW - G.left - G.right;
  var titleFont = (G.narrow ? '650 11px ' : '650 12px ') + 'ui-sans-serif,sans-serif';
  var subFont = (G.narrow ? '10px ' : '11px ') + 'ui-sans-serif,sans-serif';

  for (var a0 = 0; a0 < n; a0 += rowSize) {
    var a1 = Math.min(n, a0 + rowSize);
    var here = S.groups.filter(function (g) { return g.end > a0 && g.start < a1; });
    var hasMap = S.maps.some(function (m) { return m.off + m.len > a0 && m.off < a1; });
    if (onlyMaps && !hasMap) continue;

    /* Plan against the width we will actually draw at — planning on a nominal
     * width and drawing on another is what makes labels overlap. */
    var px = function (ad) { return G.left + (ad - a0) / (a1 - a0) * plotW; };
    var levels = [], labels = [];
    here.forEach(function (g) {
      if (!g.label && g.count < 3) return;             // keep unnamed clutter out
      var txt = groupText(g);
      meas.font = titleFont;
      var w1 = meas.measureText(txt.t).width;
      meas.font = subFont;
      var w2 = meas.measureText(txt.s).width;
      var wid = Math.max(w1, w2);
      var xm = (px(Math.max(a0, g.start)) + px(Math.min(a1, g.end))) / 2;
      var edge = Math.min(240, plotW * 0.28);
      var anchor = xm > G.left + plotW - edge ? 'right'
                 : (xm < G.left + edge * 0.75 ? 'left' : 'center');
      var x0 = anchor === 'right' ? xm - wid : anchor === 'left' ? xm : xm - wid / 2;
      var span = [x0 - 8, x0 + wid + 8], lvl = 0;
      for (;;) {
        if (!levels[lvl]) levels[lvl] = [];
        var clash = levels[lvl].some(function (s) { return span[0] < s[1] && span[1] > s[0]; });
        if (!clash) break;
        lvl++;
      }
      levels[lvl].push(span);
      if (lvl > maxLvl) maxLvl = lvl;
      labels.push({ g: g, lvl: lvl, anchor: anchor, txt: txt });
    });
    strips.push({ a0: a0, a1: a1, groups: here, labels: labels, G: G, cssW: cssW });
  }
  var lane = (maxLvl + 1) * G.lineH + G.labPad;
  strips.forEach(function (s) { s.lane = lane; });
  return strips;
}

function drawStrip(canvas, st) {
  var dpr = window.devicePixelRatio || 1;
  var G = st.G, cssW = st.cssW;
  var plotW = cssW - G.left - G.right;
  var H = st.lane + G.plotH + G.axisH;
  canvas.style.width = cssW + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(H * dpr);
  var g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  var C = {
    panel: css('--panel'), surface: css('--surface'), ink: css('--ink'),
    ink2: css('--ink-2'), ink3: css('--ink-3'), line: css('--line'),
    trace: css('--trace'), accent: css('--accent'),
    bandMap: css('--band-map'), bandFlat: css('--band-flat')
  };
  var a0 = st.a0, a1 = st.a1, y0 = st.lane;
  var px = function (ad) { return G.left + (ad - a0) / (a1 - a0) * plotW; };
  var W = 65536;
  var yv = function (v) { return y0 + G.plotH - Math.min(1, v / W) * G.plotH; };

  g.fillStyle = C.surface; g.fillRect(0, 0, cssW, H);
  g.fillStyle = C.panel; g.fillRect(G.left, y0, plotW, G.plotH);

  st.groups.forEach(function (grp) {
    grp.members.forEach(function (m) {
      var s0 = Math.max(a0, m.off), s1 = Math.min(a1, m.off + m.len);
      if (s1 <= s0) return;
      g.fillStyle = m.flat ? C.bandFlat : C.bandMap;
      g.fillRect(px(s0), y0, Math.max(0.5, px(s1) - px(s0)), G.plotH);
    });
  });

  g.strokeStyle = C.line; g.lineWidth = 1;
  for (var q = 1; q < 4; q++) {
    var yy = Math.round(y0 + G.plotH * q / 4) + 0.5;
    g.beginPath(); g.moveTo(G.left, yy); g.lineTo(G.left + plotW, yy); g.stroke();
  }

  // min/max envelope: one vertical stroke per pixel column
  var perPx = (a1 - a0) / plotW, b = S.bytes, le = S.result.le;
  var rd16 = le ? function (o) { return b[o] | (b[o + 1] << 8); }
                : function (o) { return (b[o] << 8) | b[o + 1]; };
  g.strokeStyle = C.trace; g.lineWidth = 1; g.beginPath();
  for (var c = 0; c < plotW; c++) {
    var s0 = a0 + Math.floor(c * perPx), s1 = a0 + Math.floor((c + 1) * perPx);
    if (s1 <= s0) s1 = s0 + 2;
    var lo = Infinity, hi = -Infinity;
    for (var o = s0 - (s0 & 1); o + 1 < s1 + 2 && o + 1 < b.length; o += 2) {
      var v = rd16(o);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) continue;
    var x = G.left + c + 0.5;
    g.moveTo(x, yv(lo)); g.lineTo(x, yv(hi));
  }
  g.stroke();

  g.strokeStyle = C.ink3;
  g.strokeRect(G.left + 0.5, y0 + 0.5, plotW - 1, G.plotH - 1);

  g.fillStyle = C.ink3; g.font = '10px ui-sans-serif,sans-serif'; g.textAlign = 'right';
  g.fillText('65536', G.left - 8, y0 + 4);
  g.fillText('32768', G.left - 8, y0 + G.plotH / 2 + 3);
  g.fillText('0', G.left - 8, y0 + G.plotH);

  g.textAlign = 'center'; g.fillStyle = C.ink2;
  g.font = (G.narrow ? '9.5px ' : '10.5px ') + 'ui-sans-serif,sans-serif';
  for (var t = 0; t <= G.ticks; t++) {
    var ad = a0 + (a1 - a0) * t / G.ticks, xx = Math.round(px(ad)) + 0.5;
    g.strokeStyle = C.ink3;
    g.beginPath(); g.moveTo(xx, y0 + G.plotH); g.lineTo(xx, y0 + G.plotH + 4); g.stroke();
    g.fillText(hx(Math.round(ad)), xx, y0 + G.plotH + 15);
  }
  if (!G.narrow) {
    g.textAlign = 'left'; g.fillStyle = C.ink3; g.font = '650 11px ui-sans-serif,sans-serif';
    g.fillText(hx(a0) + '–' + hx(a1 - 1), G.left + plotW + 8, y0 + G.plotH / 2 + 4);
  }

  st.labels.forEach(function (L) {
    var s0 = Math.max(a0, L.g.start), s1 = Math.min(a1, L.g.end);
    var xm = (px(s0) + px(s1)) / 2, ly = y0 - 26 - L.lvl * G.lineH;
    g.strokeStyle = C.accent;
    g.lineWidth = 1.6;
    g.strokeRect(px(s0), y0, Math.max(1, px(s1) - px(s0)), G.plotH);
    g.lineWidth = 1; g.globalAlpha = 0.8;
    g.beginPath(); g.moveTo(xm, y0); g.lineTo(xm, ly + 16); g.stroke();
    g.globalAlpha = 1;
    g.textAlign = L.anchor === 'right' ? 'right' : L.anchor === 'left' ? 'left' : 'center';
    g.fillStyle = C.ink;
    g.font = (G.narrow ? '650 11px ' : '650 12px ') + 'ui-sans-serif,sans-serif';
    g.fillText(L.txt.t, xm, ly);
    g.fillStyle = C.ink2; g.font = (G.narrow ? '10px ' : '11px ') + 'ui-sans-serif,sans-serif';
    g.fillText(L.txt.s, xm, ly + 13);
  });

  st.geom = { plotW: plotW, y0: y0, H: H, cssW: cssW };
}

function renderStrips() {
  var host = $('strips');
  host.innerHTML = '';
  var cssW = layoutWidth();
  S.strips = planStrips(cssW, geomFor(cssW));
  if (!S.strips.length) {
    host.innerHTML = '<p style="color:var(--ink-2)">No rows to show. Untick '
      + '<b>only rows with maps</b> to see the whole file.</p>';
    return;
  }
  S.strips.forEach(function (st) {
    var cv = document.createElement('canvas');
    host.appendChild(cv);
    drawStrip(cv, st);
    st.canvas = cv;
    cv.addEventListener('mousemove', function (e) { onHover(e, st); });
    cv.addEventListener('mouseleave', function () { $('tip').style.display = 'none'; });
    cv.addEventListener('click', function (e) { onClick(e, st); });
  });
}

function addrAt(e, st) {
  var r = st.canvas.getBoundingClientRect();
  var x = e.clientX - r.left, y = e.clientY - r.top;
  var g = st.geom, G = st.G;
  if (x < G.left || x > G.left + g.plotW) return null;
  if (y < g.y0 || y > g.y0 + G.plotH) return null;
  var frac = (x - G.left) / g.plotW;
  return Math.min(st.a1 - 1, st.a0 + Math.floor(frac * (st.a1 - st.a0)));
}

function mapAt(ad) {
  var lo = 0, hi = S.maps.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, m = S.maps[mid];
    if (ad < m.off) hi = mid - 1;
    else if (ad >= m.off + m.len) lo = mid + 1;
    else return m;
  }
  return null;
}

function onHover(e, st) {
  var ad = addrAt(e, st), tip = $('tip');
  if (ad === null) { tip.style.display = 'none'; return; }
  var m = mapAt(ad);
  var le = S.result.le, b = S.bytes, o = ad & ~1;
  var word = le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  var h = '<div class="t mono">' + hx(ad) + '</div>'
        + '<div class="r">word ' + word + '  (0x' + hx(word, 4) + ')</div>';
  if (m) {
    var part = ad < m.xo ? 'header' : ad < m.yo ? 'X axis' : ad < m.dt ? 'Y axis' : 'data';
    h += '<div style="margin-top:5px;font-weight:650">'
       + (m.label || 'unnamed table') + '</div>'
       + '<div class="r">' + m.nx + '×' + m.ny + ' at ' + hx(m.off)
       + ' · ' + part + (m.flat ? ' · constant' : '') + '</div>'
       + '<div class="r">' + (m.rule
            ? scaleVal(m.min, m.rule) + '–' + scaleVal(m.max, m.rule) + ' ' + m.rule.unit
            : 'raw ' + m.min + '–' + m.max) + '</div>'
       + '<div class="r" style="margin-top:4px">click to open</div>';
  } else {
    h += '<div class="r" style="margin-top:5px">not inside a recognised table</div>';
  }
  tip.innerHTML = h;
  tip.style.display = 'block';
  var tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - tw - 12, e.clientX + 14) + 'px';
  tip.style.top = Math.max(8, Math.min(window.innerHeight - th - 12, e.clientY + 14)) + 'px';
}

function onClick(e, st) {
  var ad = addrAt(e, st);
  if (ad === null) return;
  var m = mapAt(ad);
  if (m) openMap(m);
}

/* ------------------------------------------------------------------ *
 * 6. Map detail drawer
 * ------------------------------------------------------------------ */
var currentMap = null;

function openMap(m) {
  currentMap = m;
  var v = viewOf(m), r = m.rule;
  $('d-title').textContent = (m.label || 'Unnamed table') + '  ·  ' + hx(m.off);
  $('d-sub').innerHTML = m.nx + '×' + m.ny + ' · axes at ' + hx(m.xo) + ' / ' + hx(m.yo)
    + ' · data at ' + hx(m.dt) + ' · ' + m.len + ' bytes'
    + (m.chainLen > 1 ? ' · in a chain of ' + m.chainLen : ' · <span class="warn">isolated hit</span>')
    + (m.flat ? ' · constant' : '');

  var body = $('d-body'), h = '';

  h += '<dl class="kv">';
  h += '<dt>X axis</dt><dd>' + (m.xKind ? m.xKind.kind + ' (' + m.xKind.unit + ')' : 'unrecognised')
     + ' — ' + v.X[0] + ' … ' + v.X[v.nx - 1] + '</dd>';
  if (m.ny > 1) {
    h += '<dt>Y axis</dt><dd>' + (m.yKind ? m.yKind.kind + ' (' + m.yKind.unit + ')' : 'unrecognised')
       + ' — ' + v.Y[0] + ' … ' + v.Y[v.ny - 1] + '</dd>';
  }
  h += '<dt>Values</dt><dd>raw ' + m.min + '–' + m.max
     + (r ? ' → ' + scaleVal(m.min, r) + '–' + scaleVal(m.max, r) + ' ' + r.unit : '') + '</dd>';
  if (r) {
    h += '<dt>Matched rule</dt><dd>' + r.label + ' · <b>' + r.confidence
       + '</b> confidence</dd>';
    if (r.note) h += '<dt>Note</dt><dd style="color:var(--ink-2)">' + r.note + '</dd>';
  } else {
    h += '<dt>Matched rule</dt><dd style="color:var(--ink-3)">none — no rule fits these '
       + 'axes and value range. Values below are raw.</dd>';
  }
  h += '</dl>';

  h += '<h3>Values' + (r ? ' (' + r.unit + ')' : ' (raw)') + '</h3>';
  h += '<div class="scroll"><table class="grid"><tr><th class="c r"></th>';
  for (var iy = 0; iy < v.ny; iy++) {
    h += '<th class="c">' + (m.yKind ? scaleVal(v.Y[iy], m.yKind) : v.Y[iy]) + '</th>';
  }
  h += '</tr>';
  for (var ix = 0; ix < v.nx; ix++) {
    h += '<tr><th class="r">' + (m.xKind ? scaleVal(v.X[ix], m.xKind) : v.X[ix]) + '</th>';
    for (iy = 0; iy < v.ny; iy++) {
      var val = v.at(ix, iy);
      var t = m.max === m.min ? 0.5 : (val - m.min) / (m.max - m.min);
      var cls = val === m.max && !m.flat ? ' hi' : val === m.min && !m.flat ? ' lo' : '';
      var fg = t > 0.55 ? '#fff' : '#0b0b0b';
      h += '<td class="' + cls + '" style="background:' + ramp(t) + ';color:' + fg + '">'
         + (r ? scaleVal(val, r) : val) + '</td>';
    }
    h += '</tr>';
  }
  h += '</table></div>';
  h += '<p class="note">Rows are X points, columns are Y points — the data is stored '
     + 'X-major, <span class="mono">value(ix,iy) = data[ix·ny + iy]</span>. '
     + 'Solid outline marks cells at the table maximum, dashed at the minimum.</p>';

  body.innerHTML = h;
  $('drawer').classList.add('open');
}

/* ------------------------------------------------------------------ *
 * 7. Modals: rules, checksums, map list
 * ------------------------------------------------------------------ */
function openModal(title, sub, html, actions) {
  $('m-title').textContent = title;
  $('m-sub').innerHTML = sub || '';
  $('m-body').innerHTML = html;
  var box = $('m-actions');
  box.innerHTML = '';
  (actions || []).forEach(function (a) {
    var b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.onclick = a.fn;
    box.appendChild(b);
  });
  $('modal').classList.add('open');
}
function closeModal() { $('modal').classList.remove('open'); }

function showList() {
  var named = S.maps.filter(function (m) { return m.label; }).length;
  var html = '<div class="tablewrap"><table class="rep"><tr><th>address</th><th>size</th>'
    + '<th>name</th><th>X axis</th><th>Y axis</th><th>values</th><th>chain</th></tr>';
  S.maps.forEach(function (m, i) {
    var r = m.rule;
    html += '<tr style="cursor:pointer" data-i="' + i + '">'
      + '<td class="n">' + hx(m.off) + '</td>'
      + '<td class="n">' + m.nx + '×' + m.ny + '</td>'
      + '<td>' + (m.label || '<span style="color:var(--ink-3)">unnamed</span>')
      + (m.flat ? ' <span style="color:var(--ink-3)">constant</span>' : '') + '</td>'
      + '<td>' + (m.xKind ? m.xKind.kind : '—') + '</td>'
      + '<td>' + (m.ny > 1 ? (m.yKind ? m.yKind.kind : '—') : 'curve') + '</td>'
      + '<td class="n">' + (r ? scaleVal(m.min, r) + '–' + scaleVal(m.max, r) + ' ' + r.unit
                              : m.min + '–' + m.max) + '</td>'
      + '<td class="n">' + (m.chainLen > 1 ? m.chainLen : '<span class="warn">1</span>') + '</td></tr>';
  });
  html += '</table></div>';
  openModal('Map list', S.maps.length + ' tables · ' + named + ' named · click a row to open',
    html, [{ label: 'Export CSV', fn: function () {
      var rows = ['address,nx,ny,name,x_kind,y_kind,raw_min,raw_max,constant,chain_len,'
        + 'x_axis_addr,y_axis_addr,data_addr,bytes'];
      S.maps.forEach(function (m) {
        rows.push([hx(m.off), m.nx, m.ny, '"' + (m.label || '') + '"',
          m.xKind ? m.xKind.kind : '', m.yKind ? m.yKind.kind : '',
          m.min, m.max, m.flat ? 'yes' : 'no', m.chainLen,
          hx(m.xo), hx(m.yo), hx(m.dt), m.len].join(','));
      });
      download('neo-finder-maps.csv', rows.join('\n'), 'text/csv');
    } }]);
  $('m-body').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    closeModal();
    openMap(S.maps[parseInt(tr.dataset.i, 10)]);
  });
}

function download(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

function exportPNG() {
  if (!S.strips.length) return;
  var pad = 20, headH = 74;
  var indent = Math.max(12, S.strips[0].G.left - 46);
  var w = S.strips[0].canvas.width, dpr = window.devicePixelRatio || 1;
  var totalH = headH * dpr + S.strips.reduce(function (a, s) { return a + s.canvas.height + 6 * dpr; }, 0);
  var out = document.createElement('canvas');
  out.width = w; out.height = Math.round(totalH + pad * dpr);
  var g = out.getContext('2d');
  g.fillStyle = css('--surface'); g.fillRect(0, 0, out.width, out.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = css('--ink'); g.font = '700 20px ui-sans-serif,sans-serif';
  g.fillText('neo-finder — ' + S.name, indent, 28);
  g.fillStyle = css('--ink-2'); g.font = '12.5px ui-sans-serif,sans-serif';
  g.fillText(fmtBytes(S.bytes.length) + ' · ' + S.result.variantLabel + ' · '
    + S.maps.length + ' tables, ' + S.maps.filter(function (m) { return m.label; }).length
    + ' named · ' + (100 * S.result.covered / S.bytes.length).toFixed(1) + ' % covered',
    indent, 48);
  g.fillStyle = css('--ink-3'); g.font = '11.5px ui-sans-serif,sans-serif';
  g.fillText('Addresses, dimensions, axes and values are exact. Names are inferred — no DAMOS or A2L is present in the file.',
    indent, 66);
  g.setTransform(1, 0, 0, 1, 0, 0);
  var y = headH * dpr;
  S.strips.forEach(function (s) {
    g.drawImage(s.canvas, 0, y);
    y += s.canvas.height + 6 * dpr;
  });
  out.toBlob(function (blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.name || 'dump').replace(/\.[^.]*$/, '') + '-neo-finder.png';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
}

/* ------------------------------------------------------------------ *
 * 8. Scanning: Web Worker with a synchronous fallback
 * ------------------------------------------------------------------ */
var worker = null;
function makeWorker() {
  try {
    var src = 'var ScannerLib=' + ScannerLib.toString() + ';\n'
      + 'var S=ScannerLib();\n'
      + 'self.onmessage=function(e){\n'
      + '  var b=new Uint8Array(e.data.buf);\n'
      + '  var rep=function(p){self.postMessage({type:"progress",p:p});};\n'
      + '  self.postMessage({type:"done",result:S.autoDetect(b,rep)});\n'
      + '};';
    var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    var w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  } catch (e) {
    return null;                       // fall back to running on the main thread
  }
}

function runScan() {
  if (!S.bytes) return;
  $('prog').style.display = '';
  $('pbar').value = 0;

  function finish(res) {
    S.result = res.best;
    S.summary = res.summary;
    classifyAll();
    zoomLabel();
    updateChips();
    $('legend').style.display = '';
    $('empty').style.display = 'none';
    $('home').style.display = '';
    renderStrips();
    $('prog').style.display = 'none';
  }

  if (worker === null) worker = makeWorker();
  if (worker) {
    worker.onmessage = function (e) {
      if (e.data.type === 'progress') { $('pbar').value = Math.round(e.data.p * 100); return; }
      finish(e.data.result);
    };
    worker.onerror = function () { worker = false; runScan(); };
    var copy = S.bytes.slice().buffer;
    worker.postMessage({ buf: copy }, [copy]);
  } else {
    setTimeout(function () { finish(Scanner.autoDetect(S.bytes)); }, 30);
  }
}

function updateChips() {
  $('bar').style.display = '';
  $('c-file').innerHTML = '<b>' + (S.name || 'buffer') + '</b> · ' + fmtBytes(S.bytes.length);
  var named = S.maps.filter(function (m) { return m.label; }).length;
  var flat = S.maps.filter(function (m) { return m.flat; }).length;
  $('c-maps').innerHTML = '<b>' + S.maps.length + '</b> tables · ' + named + ' named · '
    + flat + ' constant';
  /* Coverage against the whole file is misleading — most of a dump is program
   * code. Report it against the span the tables actually occupy, which is the
   * calibration area, and name that span. */
  if (S.maps.length) {
    var lo = S.maps[0].off, hiM = S.maps[S.maps.length - 1];
    var span = (hiM.off + hiM.len) - lo;
    $('c-cov').innerHTML = '<b>' + (100 * S.result.covered / span).toFixed(1)
      + ' %</b> of ' + hx(lo) + '&ndash;' + hx(lo + span - 1) + ' in tables';
    $('c-cov').title = fmtBytes(S.result.covered) + ' of ' + fmtBytes(span)
      + '; the rest of that span is scalars, bare curves and flag tables.';
  } else {
    $('c-cov').innerHTML = '<b>no tables found</b>';
  }
}

/* ------------------------------------------------------------------ *
 * 10. Wiring
 * ------------------------------------------------------------------ */
function loadBuffer(name, u8) {
  if (u8.length < 0x800) { alert('That file is too small to be a flash dump.'); return; }
  if (u8.length > 32 * 1048576) { alert('That file is larger than 32 MiB; refusing to scan it.'); return; }
  S.name = name; S.bytes = u8;
  runScan();
}

function readFile(file, cb) {
  var fr = new FileReader();
  fr.onload = function () { cb(new Uint8Array(fr.result)); };
  fr.onerror = function () { alert('Could not read that file.'); };
  fr.readAsArrayBuffer(file);
}

/* Back to the open-file screen. Drops the loaded file so nothing stale can be
 * drawn or hit-tested, and clears the file input so re-picking the same file
 * still fires a change event. */
function goHome() {
  S.name = ''; S.bytes = null; S.result = null; S.summary = null;
  S.maps = []; S.groups = []; S.strips = [];
  currentMap = null;
  $('strips').innerHTML = '';
  $('bar').style.display = 'none';
  $('legend').style.display = 'none';
  $('empty').style.display = '';
  $('home').style.display = 'none';
  $('tip').style.display = 'none';
  $('prog').style.display = 'none';
  $('drawer').classList.remove('open');
  closeModal();
  $('f1').value = '';
}

$('f1').addEventListener('change', function (e) {
  var f = e.target.files[0];
  if (f) readFile(f, function (u8) { loadBuffer(f.name, u8); });
});
$('home').addEventListener('click', goHome);
$('zoom-in').addEventListener('click', function () { setZoom(1); });
$('zoom-out').addEventListener('click', function () { setZoom(-1); });
$('onlymaps').addEventListener('change', renderStrips);
$('btn-list').addEventListener('click', showList);
$('btn-png').addEventListener('click', exportPNG);
$('d-close').addEventListener('click', function () { $('drawer').classList.remove('open'); });
$('m-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  closeModal();
  $('drawer').classList.remove('open');
});
$('theme').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var dark = cur === 'dark' || (!cur && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  if (S.bytes) renderStrips();
});
/* A width change alters the label collision plan, not just the pixels, so the
 * strips are re-planned rather than merely redrawn. */
var resizeTimer = null, lastW = 0;
window.addEventListener('resize', function () {
  if (!S.bytes) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    var w = layoutWidth();
    if (w === lastW) return;
    lastW = w;
    renderStrips();
  }, 150);
});

/* drag and drop anywhere */
document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('drop', function (e) {
  e.preventDefault();
  var f = e.dataTransfer.files[0];
  if (f) readFile(f, function (u8) { loadBuffer(f.name, u8); });
});
