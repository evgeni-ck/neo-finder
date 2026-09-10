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

  /* ---- file identification: hashes and printable strings ----
   * The worker extracts; the main thread interprets. Same split as
   * recognition vs naming — the patterns stay editable data, not scanner code. */

  function crc32(bytes) {
    var tbl = new Int32Array(256), c, i, k;
    for (i = 0; i < 256; i++) {
      c = i;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      tbl[i] = c;
    }
    c = 0xFFFFFFFF;
    for (i = 0; i < bytes.length; i++) c = (c >>> 8) ^ tbl[(c ^ bytes[i]) & 0xFF];
    return ((c ^ 0xFFFFFFFF) >>> 0);
  }

  function md5(bytes) {
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = new Int32Array(64), i;
    for (i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

    var n = bytes.length;
    var blocks = Math.floor((n + 8) / 64) + 1;
    var last = blocks * 64;
    var bitLo = (n * 8) >>> 0, bitHi = Math.floor(n / 536870912) >>> 0;

    function byteAt(idx) {
      if (idx < n) return bytes[idx];
      if (idx === n) return 0x80;
      if (idx >= last - 8) {
        var k = idx - (last - 8);
        return k < 4 ? (bitLo >>> (8 * k)) & 0xFF : (bitHi >>> (8 * (k - 4))) & 0xFF;
      }
      return 0;
    }

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Int32Array(16);
    for (var blk = 0; blk < blocks; blk++) {
      var base = blk * 64, j;
      for (j = 0; j < 16; j++) {
        var p = base + j * 4;
        M[j] = byteAt(p) | (byteAt(p + 1) << 8) | (byteAt(p + 2) << 16) | (byteAt(p + 3) << 24);
      }
      var A = a0, B = b0, C = c0, D = d0, F, g;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    function le(v) {
      var s = '';
      for (var b = 0; b < 4; b++) s += ('0' + (((v >>> (8 * b)) & 0xFF).toString(16))).slice(-2);
      return s;
    }
    return le(a0) + le(b0) + le(c0) + le(d0);
  }

  function extractStrings(bytes, minLen, cap) {
    var out = [], start = -1, n = bytes.length;
    for (var i = 0; i <= n; i++) {
      var c = i < n ? bytes[i] : 0;
      if (c >= 0x20 && c <= 0x7E) { if (start < 0) start = i; continue; }
      if (start >= 0 && i - start >= minLen) {
        var s = '';
        for (var j = start; j < i; j++) s += String.fromCharCode(bytes[j]);
        out.push({ o: start, s: s });
        if (out.length >= cap) return out;
      }
      start = -1;
    }
    return out;
  }

  function identify(bytes) {
    return {
      size: bytes.length,
      crc32: crc32(bytes),
      md5: md5(bytes),
      strings: extractStrings(bytes, 6, 8000)
    };
  }

  return { VARIANTS: VARIANTS, scan: scan, autoDetect: autoDetect, identify: identify };
}

var Scanner = ScannerLib();

/* ------------------------------------------------------------------ *
 * 1b. Language — English and Bulgarian. {0}-style placeholders.
 * ------------------------------------------------------------------ */
var STRINGS = {
  en: {
    'home': '← Home',
    'home.title': 'Back to the open-file screen',
    'lang.title': 'Switch language',
    'theme.title': 'Toggle theme',
    'openfile': 'Open file…',
    'ordrag': 'or drag a file anywhere on this page',
    'zoom': 'zoom',
    'zoom.out': 'Fit more of the file into each row',
    'zoom.in': 'Spread each row over less of the file, in more detail',
    'onlymaps': 'only rows with maps',
    'maplist': 'Map list',
    'downloadpng': 'Download PNG',
    'close': 'Close',
    'legend.map': 'map with real data',
    'legend.flat': 'map present but constant — unused option',
    'legend.none': 'not a map: scalars, curves, flags',
    'table.one': 'table', 'table.many': 'tables',
    'chip.tables': '<b>{0}</b> {1} · named: {2} · constant: {3}',
    'chip.cov': '<b>{0} %</b> of {1}–{2} in tables',
    'chip.cov.title': '{0} of {1}; the rest of that span is scalars, bare curves and flag tables.',
    'chip.none': '<b>no tables found</b>',
    'norows': 'No rows to show. Untick <b>{0}</b> to see the whole file.',
    'tip.word': 'word {0}  (0x{1})',
    'tip.unnamed': 'unnamed table',
    'tip.at': '{0}×{1} at {2} · {3}',
    'tip.click': 'click to open',
    'tip.outside': 'not inside a recognised table',
    'part.header': 'header',
    'part.x': 'X axis',
    'part.y': 'Y axis',
    'part.data': 'data',
    'constant': 'constant',
    'raw': 'raw',
    'unnamedtable': 'Unnamed table',
    'd.axes': 'axes at {0} / {1}',
    'd.data': 'data at {0}',
    'd.bytes': '{0} bytes',
    'd.chain': 'in a chain of {0}',
    'd.isolated': 'isolated hit',
    'd.xaxis': 'X axis',
    'd.yaxis': 'Y axis',
    'd.values': 'Values',
    'd.rule': 'Matched rule',
    'd.note': 'Note',
    'd.norule': 'none — no rule fits these axes and value range. Values below are raw.',
    'd.unrecognised': 'unrecognised',
    'd.confidence': '{0} confidence',
    'd.valueshdr': 'Values ({0})',
    'd.storage': 'Columns are X points; rows are Y points, ascending upward from the '
      + 'bottom row. The bytes themselves are stored X-major as '
      + '<span class="mono">value(ix,iy) = data[ix·ny + iy]</span>. Solid outline marks cells '
      + 'at the table maximum, dashed at the minimum.',
    'list.address': 'address', 'list.size': 'size', 'list.name': 'name',
    'list.x': 'X axis', 'list.y': 'Y axis', 'list.values': 'values', 'list.chain': 'chain',
    'list.curve': 'curve', 'list.unnamed': 'unnamed',
    'list.sub': '{0} {1} · named: {2} · click a row to open',
    'list.export': 'Export CSV',
    'png.sub': '{0} · {1} · {2} {3} · named: {4}',
    'png.foot': 'Addresses, dimensions, axes and values are exact. Names are inferred — '
      + 'no DAMOS or A2L is present in the file.',
    'err.small': 'That file is too small to be a flash dump.',
    'err.big': 'That file is larger than 32 MiB; refusing to scan it.',
    'err.read': 'Could not read that file.',
    'conf.high': 'high', 'conf.medium': 'medium', 'conf.low': 'low',
    'id.chip.title': 'Click for file identification',
    'id.title': 'File identification',
    'id.sub': 'hashes, and identifiers read out of the binary',
    'id.file': 'File', 'id.size': 'Size',
    'id.computing': 'computing…', 'id.sha.na': 'unavailable in this context',
    'id.identified': 'Identified',
    'id.ecu': 'ECU type', 'id.cpu': 'Controller', 'id.sw': 'Software number',
    'id.hw': 'Hardware number', 'id.banner': 'Build banner', 'id.date': 'Build date',
    'id.os': 'Operating system', 'id.project': 'Project tag', 'id.vin': 'Possible VIN',
    'id.nonefound': 'No known identifier patterns matched. The patterns cover the Bosch EDC and ME families; other makers use different formats, so try the strings below.',
    'id.other': 'Other identifier-like strings',
    'id.foot': 'Read from {0} printable strings in the file. Everything here was computed in your browser — nothing was uploaded.',
    'kind.rpm': 'rpm', 'kind.pedal': 'pedal', 'kind.iq': 'injection quantity',
    'kind.coolant': 'coolant', 'kind.index': 'index'
  },
  bg: {
    'home': '← Начало',
    'home.title': 'Обратно към екрана за отваряне на файл',
    'lang.title': 'Смяна на езика',
    'theme.title': 'Смяна на темата',
    'openfile': 'Отвори файл…',
    'ordrag': 'или пуснете файл някъде на тази страница',
    'zoom': 'мащаб',
    'zoom.out': 'Повече от файла на всеки ред',
    'zoom.in': 'По-малко от файла на всеки ред, с повече детайл',
    'onlymaps': 'само редове с карти',
    'maplist': 'Списък с карти',
    'downloadpng': 'Изтегли PNG',
    'close': 'Затвори',
    'legend.map': 'карта с реални данни',
    'legend.flat': 'карта, но постоянна — неизползвана опция',
    'legend.none': 'не е карта: скалари, криви, флагове',
    'table.one': 'таблица', 'table.many': 'таблици',
    'chip.tables': '<b>{0}</b> {1} · наименувани: {2} · постоянни: {3}',
    'chip.cov': '<b>{0} %</b> от {1}–{2} в таблици',
    'chip.cov.title': '{0} от {1}; останалото в този обхват са скалари, отделни криви и таблици с флагове.',
    'chip.none': '<b>няма намерени таблици</b>',
    'norows': 'Няма редове за показване. Махнете <b>{0}</b>, за да видите целия файл.',
    'tip.word': 'дума {0}  (0x{1})',
    'tip.unnamed': 'неназована таблица',
    'tip.at': '{0}×{1} на {2} · {3}',
    'tip.click': 'щракнете, за да отворите',
    'tip.outside': 'извън разпозната таблица',
    'part.header': 'заглавие',
    'part.x': 'ос X',
    'part.y': 'ос Y',
    'part.data': 'данни',
    'constant': 'постоянна',
    'raw': 'сурови',
    'unnamedtable': 'Неназована таблица',
    'd.axes': 'оси на {0} / {1}',
    'd.data': 'данни на {0}',
    'd.bytes': '{0} байта',
    'd.chain': 'във верига от {0}',
    'd.isolated': 'изолирано попадение',
    'd.xaxis': 'Ос X',
    'd.yaxis': 'Ос Y',
    'd.values': 'Стойности',
    'd.rule': 'Съответстващо правило',
    'd.note': 'Бележка',
    'd.norule': 'няма — никое правило не пасва на тези оси и обхват. Стойностите по-долу са сурови.',
    'd.unrecognised': 'неразпозната',
    'd.confidence': '{0} увереност',
    'd.valueshdr': 'Стойности ({0})',
    'd.storage': 'Колоните са точки по X; редовете са точки по Y и растат отдолу нагоре. '
      + 'Самите байтове се пазят X-мажорно: '
      + '<span class="mono">value(ix,iy) = data[ix·ny + iy]</span>. Плътният контур маркира '
      + 'клетките с максимума на таблицата, прекъснатият — с минимума.',
    'list.address': 'адрес', 'list.size': 'размер', 'list.name': 'име',
    'list.x': 'ос X', 'list.y': 'ос Y', 'list.values': 'стойности', 'list.chain': 'верига',
    'list.curve': 'крива', 'list.unnamed': 'неназована',
    'list.sub': '{0} {1} · наименувани: {2} · щракнете на ред, за да го отворите',
    'list.export': 'Експорт CSV',
    'png.sub': '{0} · {1} · {2} {3} · наименувани: {4}',
    'png.foot': 'Адресите, размерите, осите и стойностите са точни. Имената са изведени — '
      + 'във файла няма DAMOS или A2L.',
    'err.small': 'Файлът е твърде малък, за да е дъмп на флаш памет.',
    'err.big': 'Файлът е по-голям от 32 MiB; сканирането е отказано.',
    'err.read': 'Файлът не може да бъде прочетен.',
    'conf.high': 'висока', 'conf.medium': 'средна', 'conf.low': 'ниска',
    'id.chip.title': 'Щракнете за идентификация на файла',
    'id.title': 'Идентификация на файла',
    'id.sub': 'контролни суми и идентификатори, прочетени от двоичния файл',
    'id.file': 'Файл', 'id.size': 'Размер',
    'id.computing': 'изчислява се…', 'id.sha.na': 'недостъпно в този контекст',
    'id.identified': 'Разпознато',
    'id.ecu': 'Тип ЕБУ', 'id.cpu': 'Контролер', 'id.sw': 'Софтуерен номер',
    'id.hw': 'Хардуерен номер', 'id.banner': 'Идентификационен ред', 'id.date': 'Дата на компилация',
    'id.os': 'Операционна система', 'id.project': 'Проектен етикет', 'id.vin': 'Възможен VIN',
    'id.nonefound': 'Никой познат шаблон не съвпадна. Шаблоните покриват фамилиите Bosch EDC и ME; другите производители използват различни формати, така че вижте низовете по-долу.',
    'id.other': 'Други низове, подобни на идентификатори',
    'id.foot': 'Прочетено от {0} печатаеми низа във файла. Всичко тук е изчислено в браузъра ви — нищо не е качено.',
    'kind.rpm': 'обороти', 'kind.pedal': 'педал', 'kind.iq': 'количество впръскване',
    'kind.coolant': 'охл. течност', 'kind.index': 'индекс'
  }
};

/* Units: symbols that are already international stay put; the rest translate. */
var UNITS = {
  bg: { 'mg/stroke': 'mg/ход', 'bar': 'бар', 'mbar abs': 'mbar абс.', '°CA': '° ъгъл',
        'rpm': 'об/мин', 'raw': 'сурови' }
};

var LANG = 'en';

function t(key) {
  var tbl = STRINGS[LANG] || STRINGS.en;
  var s = tbl[key];
  if (s == null) s = STRINGS.en[key];
  if (s == null) return key;
  for (var i = 1; i < arguments.length; i++) {
    s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
  }
  return s;
}

function unitOf(u) {
  if (!u) return '';
  var m = UNITS[LANG];
  return (m && m[u]) || u;
}

function tableWord(n) { return t(n === 1 ? 'table.one' : 'table.many'); }

function kindName(k) { return k ? t('kind.' + k.kind) : t('d.unrecognised'); }

function ruleLabel(r) { return r ? ((LANG !== 'en' && r[LANG] && r[LANG].label) || r.label) : null; }
function ruleNote(r) { return r ? ((LANG !== 'en' && r[LANG] && r[LANG].note) || r.note) : null; }

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
      note: 'quantity request; zero rows at the top of the rpm axis are the fuel cut',
      bg: { label: 'Желание на водача – заявено количество впръскване',
            note: 'заявка за количество; нулевите редове в горния край на оста на оборотите са отсечката на горивото' } },

    { label: 'Rail pressure setpoint', x: 'rpm', y: 'iq',
      dataMax: [11000, 17000], trendX: 'up', trendY: 'up',
      unit: 'bar', factor: 0.1, confidence: 'high',
      note: 'a large plateau exactly at the maximum is the pump limit, not a setpoint',
      bg: { label: 'Задание за налягане в рейката',
            note: 'голямо плато точно на максимума е ограничението на помпата, а не задание' } },

    { label: 'Injection timing', x: 'rpm', y: 'iq',
      dataMin: [900, 1900], dataMax: [2000, 3200], trendX: 'down',
      unit: '°CA', factor: 0.01, confidence: 'medium',
      note: 'falls with rising speed; pilot or main start-of-injection',
      bg: { label: 'Момент на впръскване',
            note: 'намалява с оборотите; начало на пилотното или основното впръскване' } },

    { label: 'Boost pressure setpoint', x: 'rpm', y: 'iq',
      dataMin: [600, 1500], dataMax: [1700, 3200], trendY: 'up',
      unit: 'mbar abs', factor: 1, confidence: 'high',
      note: 'the floor near 1000 is ambient pressure, i.e. no boost demand',
      bg: { label: 'Задание за налягане на наддаване',
            note: 'подът около 1000 е атмосферното налягане, т.е. без заявка за наддаване' } },

    { label: 'EGR / air-path setpoint', x: 'rpm', y: 'iq',
      dataMin: [50, 600], dataMax: [1500, 3500], trendY: 'down',
      unit: 'raw', factor: 1, confidence: 'low',
      note: 'a hard step rather than a gradient suggests shut-off past a load threshold; could also be a flap actuator',
      bg: { label: 'Задание за EGR / въздушен път',
            note: 'резкият праг вместо плавен преход подсказва изключване след определено натоварване; може да е и клапа' } },

    { label: 'Duty / position', x: 'rpm', y: 'iq',
      dataMax: [5000, 8300], unit: '%', factor: 0.01220703125, confidence: 'medium',
      note: '8192 = 100 %, so this is a normalised actuator demand',
      bg: { label: 'Запълване / позиция',
            note: '8192 = 100 %, т.е. нормализирана заявка към изпълнителен механизъм' } },

    { label: 'Temperature correction', x: 'rpm', y: 'coolant',
      unit: 'raw', factor: 1, confidence: 'medium',
      note: 'coolant-indexed trim, typically cold-running enrichment or timing',
      bg: { label: 'Температурна корекция',
            note: 'корекция по температура на охладителната течност, обикновено обогатяване или момент при студен двигател' } },

    { label: 'Quantity limiter', x: 'rpm', y: 'iq',
      dataMax: [2500, 5000], trendX: 'down', unit: 'mg/stroke', factor: 0.01,
      confidence: 'low', note: 'upper bound on quantity; often the smoke limiter',
      bg: { label: 'Ограничител на количеството',
            note: 'горна граница на количеството; често ограничителят на дима' } }
  ]
};

/* Identification patterns — data, like the naming rules. Each is applied to
 * every extracted string; `capture` picks a group, `also` adds constraints the
 * match must satisfy. Ordered as they should appear in the panel.
 *
 * These are Bosch conventions and degrade the same way naming does: precise on
 * the EDC/ME families, and elsewhere the unmatched-strings fallback still gives
 * you something to read. */
var ID_PATTERNS = [
  { id: 'ecu',     re: /\b(EDC\d{2}[A-Z]*\d*(?:[.-]\d+(?:\.\d+)?[a-z]*)?|MED\d+[.\d]*|ME\d+\.\d+[.\d]*|DCM\d+\.\d+|MJD\s?\d+[A-Z\d]*|SID\d{3}|EMS\d{4})\b/, cap: 1, max: 3 },
  { id: 'cpu',     re: /\b(MPC\d{3}|TC\d{3,4}|ST10[A-Z0-9]*|C16[67]|SH7\d{4})\b/, cap: 1, max: 3 },
  { id: 'sw',      re: /\b(10\d{8}[A-Z0-9]{0,12})\b/, cap: 1, max: 4 },
  { id: 'hw',      re: /\b(02[0-9]{8})\b/, cap: 1, max: 4 },
  { id: 'banner',  re: /^((?:BOSCH|SIEMENS|CONTINENTAL|DELPHI|MAGNETI|MARELLI|VDO)\b.{12,})$/, cap: 1, max: 2 },
  { id: 'date',    re: /\b(\d{2}\.\d{2}\.(?:19|20)\d{2})\b/, cap: 1, max: 3 },
  { id: 'os',      re: /\b(ERCOSEK\s*V?[\d.]*[^,]{0,30}|OSEK\s*V?[\d.]+)/, cap: 1, max: 2 },
  { id: 'project', re: /\b((?:Bosch|Siemens)\.[A-Za-z_0-9]+\.[A-Za-z]+\.[A-Z0-9]+)\b/, cap: 1, max: 6 },
  /* A VIN is 17 chars without I, O or Q. That alone matches plenty of ordinary
   * tokens, so require both a letter and a digit and report it as "possible". */
  { id: 'vin',     re: /\b([A-HJ-NPR-Z0-9]{17})\b/, cap: 1, max: 2,
                   also: [/[A-HJ-NPR-Z]/, /[0-9]/] }
];

function interpretIdent(ident) {
  if (!ident) return null;
  var found = [], seenAll = {};
  ID_PATTERNS.forEach(function (p) {
    var hits = [], seen = {};
    for (var i = 0; i < ident.strings.length && hits.length < p.max; i++) {
      var rec = ident.strings[i], m = p.re.exec(rec.s);
      if (!m) continue;
      var val = (p.cap ? m[p.cap] : m[0]).trim();
      if (!val || seen[val]) continue;
      if (p.also && !p.also.every(function (rx) { return rx.test(val); })) continue;
      seen[val] = 1; seenAll[val] = 1;
      hits.push({ value: val, at: rec.o });
    }
    if (hits.length) found.push({ id: p.id, hits: hits });
  });

  /* Anything identifier-shaped that no pattern claimed — the fallback that
   * keeps the panel useful on families we have no patterns for.
   *
   * Most printable runs in a flash dump are not text at all, just data that
   * happens to land in 0x20-0x7E: "u0u0u0u0…", "UUUU3333". Length does not
   * separate those from real identifiers but character variety does, so require
   * a minimum number of distinct characters and reject short repeating motifs. */
  function looksLikeText(str) {
    var seen = {}, distinct = 0, i;
    for (i = 0; i < str.length; i++) {
      if (!seen[str[i]]) { seen[str[i]] = 1; distinct++; }
    }
    if (distinct < 6) return false;
    for (var w = 1; w <= 4; w++) {
      if (str.length < w * 3) break;
      var unit = str.slice(0, w), reps = 1;
      while (str.slice(reps * w, reps * w + w) === unit) reps++;
      if (reps >= 3 && reps * w >= str.length * 0.75) return false;
    }
    return true;
  }

  var other = [], oseen = {};
  ident.strings.forEach(function (rec) {
    var s = rec.s.trim();
    if (s.length < 10 || s.length > 90) return;
    if (!looksLikeText(s)) return;
    if (!/^[A-Za-z0-9._/\\ :+-]+$/.test(s)) return;
    if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return;
    if (seenAll[s] || oseen[s]) return;
    var claimed = Object.keys(seenAll).some(function (v) { return s.indexOf(v) >= 0; });
    if (claimed) return;
    oseen[s] = 1;
    other.push({ value: s, at: rec.o });
  });
  other.sort(function (a, b) { return b.value.length - a.value.length; });

  return { found: found, other: other.slice(0, 10), total: ident.strings.length };
}

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
  strips: [], zoom: 4, ident: null, sha: null
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
    m.label = ruleLabel(c.rule);          // display label in the current language
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
  var title = hx(g.start) + '  ' + (g.label || (g.count + ' × ' + g.nx + '×' + g.ny));
  var bits = [];
  if (g.count > 1) bits.push(g.count + ' × ' + g.nx + '×' + g.ny);
  else bits.push(g.nx + '×' + g.ny);
  if (g.rule) bits.push(scaleVal(g.min, g.rule) + '–' + scaleVal(g.max, g.rule) + ' ' + unitOf(g.rule.unit));
  else bits.push(t('raw') + ' ' + g.min + '–' + g.max);
  if (g.rule && g.rule.confidence) bits.push(t('d.confidence', t('conf.' + g.rule.confidence)));
  return { t: title, s: bits.join(' · ') };
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
  for (var ti = 0; ti <= G.ticks; ti++) {
    var ad = a0 + (a1 - a0) * ti / G.ticks, xx = Math.round(px(ad)) + 0.5;
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
    host.innerHTML = '<p style="color:var(--ink-2)">' + t('norows', t('onlymaps')) + '</p>';
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
        + '<div class="r">' + t('tip.word', word, hx(word, 4)) + '</div>';
  if (m) {
    var part = ad < m.xo ? t('part.header') : ad < m.yo ? t('part.x')
             : ad < m.dt ? t('part.y') : t('part.data');
    h += '<div style="margin-top:5px;font-weight:650">'
       + (m.label || t('tip.unnamed')) + '</div>'
       + '<div class="r">' + t('tip.at', m.nx, m.ny, hx(m.off), part)
       + (m.flat ? ' · ' + t('constant') : '') + '</div>'
       + '<div class="r">' + (m.rule
            ? scaleVal(m.min, m.rule) + '–' + scaleVal(m.max, m.rule) + ' ' + unitOf(m.rule.unit)
            : t('raw') + ' ' + m.min + '–' + m.max) + '</div>'
       + '<div class="r" style="margin-top:4px">' + t('tip.click') + '</div>';
  } else {
    h += '<div class="r" style="margin-top:5px">' + t('tip.outside') + '</div>';
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

/* An axis summary must never print raw counts next to a scaled unit — "coolant
 * (°C) — 2531 … 3231" is nonsense. Where the scaling is the identity, show the
 * values with their unit; otherwise show raw and the converted range, matching
 * how the Values row already reads. */
function axisLine(kind, arr, n) {
  var lo = arr[0], hi = arr[n - 1];
  if (!kind) return t('d.unrecognised') + ' — ' + t('raw') + ' ' + lo + ' … ' + hi;
  var identity = (kind.factor == null || kind.factor === 1) && !kind.offset;
  var name = kindName(kind), u = kind.unit ? unitOf(kind.unit) : '';
  /* For speed the kind name and the unit are the same word; do not say it twice. */
  var unit = (u && u.toLowerCase() !== name.toLowerCase()) ? ' ' + u : '';
  if (identity) return name + ' — ' + lo + ' … ' + hi + unit;
  return name + ' — ' + t('raw') + ' ' + lo + ' … ' + hi
       + ' → ' + scaleVal(lo, kind) + ' … ' + scaleVal(hi, kind) + unit;
}

/* Same rule as axisLine: no identity conversion, and never the word 'raw'
 * twice. A rule whose unit is literally 'raw' has nothing to convert to. */
function valueLine(m, r) {
  var range = m.min + '–' + m.max;
  if (!r) return t('raw') + ' ' + range;
  var identity = (r.factor == null || r.factor === 1) && !r.offset;
  if (identity) {
    return r.unit === 'raw' ? t('raw') + ' ' + range : range + ' ' + unitOf(r.unit);
  }
  return t('raw') + ' ' + range + ' → '
       + scaleVal(m.min, r) + '–' + scaleVal(m.max, r) + ' ' + unitOf(r.unit);
}

function openMap(m) {
  currentMap = m;
  var v = viewOf(m), r = m.rule;
  $('d-title').textContent = (m.label || t('unnamedtable')) + '  ·  ' + hx(m.off);
  $('d-sub').innerHTML = m.nx + '×' + m.ny
    + ' · ' + t('d.axes', hx(m.xo), hx(m.yo))
    + ' · ' + t('d.data', hx(m.dt))
    + ' · ' + t('d.bytes', m.len)
    + (m.chainLen > 1 ? ' · ' + t('d.chain', m.chainLen)
                      : ' · <span class="warn">' + t('d.isolated') + '</span>')
    + (m.flat ? ' · ' + t('constant') : '');

  var body = $('d-body'), h = '';

  h += '<dl class="kv">';
  h += '<dt>' + t('d.xaxis') + '</dt><dd>' + axisLine(m.xKind, v.X, v.nx) + '</dd>';
  if (m.ny > 1) {
    h += '<dt>' + t('d.yaxis') + '</dt><dd>' + axisLine(m.yKind, v.Y, v.ny) + '</dd>';
  }
  h += '<dt>' + t('d.values') + '</dt><dd>' + valueLine(m, r) + '</dd>';
  if (r) {
    h += '<dt>' + t('d.rule') + '</dt><dd>' + ruleLabel(r) + ' · <b>'
       + t('d.confidence', t('conf.' + r.confidence)) + '</b></dd>';
    var note = ruleNote(r);
    if (note) h += '<dt>' + t('d.note') + '</dt><dd style="color:var(--ink-2)">' + note + '</dd>';
  } else {
    h += '<dt>' + t('d.rule') + '</dt><dd style="color:var(--ink-3)">' + t('d.norule') + '</dd>';
  }
  h += '</dl>';

  h += '<h3>' + t('d.valueshdr', r ? unitOf(r.unit) : t('raw')) + '</h3>';
  /* Presentation follows the convention every ECU editor uses, not the storage
   * order: X across the columns, Y down the rows, and Y ascending *upward* so
   * the origin sits bottom-left and the surface rises like a plot. The X-major
   * storage layout stays an implementation detail inside v.at(). */
  h += '<div class="scroll"><table class="grid"><tr><th class="c r"></th>';
  for (var ix = 0; ix < v.nx; ix++) {
    h += '<th class="c">' + (m.xKind ? scaleVal(v.X[ix], m.xKind) : v.X[ix]) + '</th>';
  }
  h += '</tr>';
  for (var iy = v.ny - 1; iy >= 0; iy--) {
    h += '<tr><th class="r">' + (m.yKind ? scaleVal(v.Y[iy], m.yKind) : v.Y[iy]) + '</th>';
    for (var cx = 0; cx < v.nx; cx++) {
      var val = v.at(cx, iy);
      var shade = m.max === m.min ? 0.5 : (val - m.min) / (m.max - m.min);
      var cls = val === m.max && !m.flat ? ' hi' : val === m.min && !m.flat ? ' lo' : '';
      var fg = shade > 0.55 ? '#fff' : '#0b0b0b';
      h += '<td class="' + cls + '" style="background:' + ramp(shade) + ';color:' + fg + '">'
         + (r ? scaleVal(val, r) : val) + '</td>';
    }
    h += '</tr>';
  }
  h += '</table></div>';
  h += '<p class="note">' + t('d.storage') + '</p>';

  body.innerHTML = h;
  $('drawer').classList.add('open');
}

/* ------------------------------------------------------------------ *
 * 7. Modals: rules, checksums, map list
 * ------------------------------------------------------------------ */
var openModalKind = null;

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
function closeModal() { $('modal').classList.remove('open'); openModalKind = null; }

function showIdent() {
  openModalKind = showIdent;
  var id = S.ident, info = interpretIdent(id);
  var rows = '';
  function row(k, v) {
    return '<tr><td style="color:var(--ink-3);white-space:nowrap">' + k + '</td><td>' + v + '</td></tr>';
  }

  rows += row(t('id.file'), '<b>' + S.name + '</b>');
  rows += row(t('id.size'), fmtBytes(id.size) + ' <span style="color:var(--ink-3)">('
    + id.size.toLocaleString() + ' B)</span>');
  rows += row('MD5', '<span class="mono">' + id.md5 + '</span>');
  rows += row('CRC32', '<span class="mono">0x'
    + id.crc32.toString(16).toUpperCase().padStart(8, '0') + '</span>');
  rows += row('SHA-256', '<span class="mono" id="sha">' + t('id.computing') + '</span>');

  var html = '<table class="rep" style="width:auto">' + rows + '</table>';

  if (info.found.length) {
    html += '<h3>' + t('id.identified') + '</h3><table class="rep" style="width:auto">';
    info.found.forEach(function (f) {
      var vals = f.hits.map(function (h) {
        return '<span class="mono">' + h.value.replace(/</g, '&lt;') + '</span>'
          + ' <span style="color:var(--ink-3)">@' + hx(h.at) + '</span>';
      }).join('<br>');
      html += row(t('id.' + f.id), vals);
    });
    html += '</table>';
  } else {
    html += '<p style="color:var(--ink-3)">' + t('id.nonefound') + '</p>';
  }

  if (info.other.length) {
    html += '<h3>' + t('id.other') + '</h3>'
      + '<div class="scroll" style="max-height:26vh"><table class="rep" style="width:auto">';
    info.other.forEach(function (o) {
      html += row('<span class="mono" style="color:var(--ink-3)">' + hx(o.at) + '</span>',
        '<span class="mono">' + o.value.replace(/</g, '&lt;') + '</span>');
    });
    html += '</table></div>';
  }

  html += '<p class="note">' + t('id.foot', info.total) + '</p>';

  openModal(t('id.title'), t('id.sub'), html, []);

  /* SHA-256 comes from WebCrypto, which is async and needs a secure context —
   * https and file:// qualify, plain http does not. */
  (function () {
    var el = $('sha');
    if (!el) return;
    if (S.sha) { el.textContent = S.sha; return; }
    try {
      crypto.subtle.digest('SHA-256', S.bytes).then(function (buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
        S.sha = s;
        var cur = $('sha');
        if (cur) cur.textContent = s;
      }, function () { el.textContent = t('id.sha.na'); });
    } catch (e) { el.textContent = t('id.sha.na'); }
  })();
}

function showList() {
  openModalKind = showList;
  var named = S.maps.filter(function (m) { return m.label; }).length;
  var html = '<div class="tablewrap"><table class="rep"><tr><th>' + t('list.address')
    + '</th><th>' + t('list.size') + '</th><th>' + t('list.name') + '</th><th>' + t('list.x')
    + '</th><th>' + t('list.y') + '</th><th>' + t('list.values') + '</th><th>'
    + t('list.chain') + '</th></tr>';
  S.maps.forEach(function (m, i) {
    var r = m.rule;
    html += '<tr style="cursor:pointer" data-i="' + i + '">'
      + '<td class="n">' + hx(m.off) + '</td>'
      + '<td class="n">' + m.nx + '×' + m.ny + '</td>'
      + '<td>' + (m.label || '<span style="color:var(--ink-3)">' + t('list.unnamed') + '</span>')
      + (m.flat ? ' <span style="color:var(--ink-3)">' + t('constant') + '</span>' : '') + '</td>'
      + '<td>' + (m.xKind ? kindName(m.xKind) : '—') + '</td>'
      + '<td>' + (m.ny > 1 ? (m.yKind ? kindName(m.yKind) : '—') : t('list.curve')) + '</td>'
      + '<td class="n">' + (r ? scaleVal(m.min, r) + '–' + scaleVal(m.max, r) + ' ' + unitOf(r.unit)
                              : m.min + '–' + m.max) + '</td>'
      + '<td class="n">' + (m.chainLen > 1 ? m.chainLen : '<span class="warn">1</span>') + '</td></tr>';
  });
  html += '</table></div>';
  openModal(t('maplist'), t('list.sub', S.maps.length, tableWord(S.maps.length), named),
    html, [{ label: t('list.export'), fn: function () {
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
  g.fillText(t('png.sub', fmtBytes(S.bytes.length), S.result.variantLabel, S.maps.length,
    tableWord(S.maps.length), S.maps.filter(function (m) { return m.label; }).length), indent, 48);
  g.fillStyle = css('--ink-3'); g.font = '11.5px ui-sans-serif,sans-serif';
  g.fillText(t('png.foot'), indent, 66);
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
      + '  var r=S.autoDetect(b,rep);\n'
      + '  self.postMessage({type:"done",result:r,ident:S.identify(b)});\n'
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

  function finish(res, ident) {
    S.result = res.best;
    S.summary = res.summary;
    S.ident = ident; S.sha = null;
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
      finish(e.data.result, e.data.ident);
    };
    worker.onerror = function () { worker = false; runScan(); };
    var copy = S.bytes.slice().buffer;
    worker.postMessage({ buf: copy }, [copy]);
  } else {
    setTimeout(function () {
      finish(Scanner.autoDetect(S.bytes), Scanner.identify(S.bytes));
    }, 30);
  }
}

function updateChips() {
  $('bar').style.display = '';
  $('c-file').innerHTML = '<b>' + (S.name || 'buffer') + '</b> · ' + fmtBytes(S.bytes.length);
  $('c-file').title = t('id.chip.title');
  var named = S.maps.filter(function (m) { return m.label; }).length;
  var flat = S.maps.filter(function (m) { return m.flat; }).length;
  $('c-maps').innerHTML = t('chip.tables', S.maps.length, tableWord(S.maps.length), named, flat);
  /* Coverage against the whole file is misleading — most of a dump is program
   * code. Report it against the span the tables actually occupy, which is the
   * calibration area, and name that span. */
  if (S.maps.length) {
    var lo = S.maps[0].off, hiM = S.maps[S.maps.length - 1];
    var span = (hiM.off + hiM.len) - lo;
    $('c-cov').innerHTML = t('chip.cov', (100 * S.result.covered / span).toFixed(1),
      hx(lo), hx(lo + span - 1));
    $('c-cov').title = t('chip.cov.title', fmtBytes(S.result.covered), fmtBytes(span));
  } else {
    $('c-cov').innerHTML = t('chip.none');
  }
}

/* ------------------------------------------------------------------ *
 * 10. Wiring
 * ------------------------------------------------------------------ */
function loadBuffer(name, u8) {
  if (u8.length < 0x800) { alert(t('err.small')); return; }
  if (u8.length > 32 * 1048576) { alert(t('err.big')); return; }
  S.name = name; S.bytes = u8;
  runScan();
}

function readFile(file, cb) {
  var fr = new FileReader();
  fr.onload = function () { cb(new Uint8Array(fr.result)); };
  fr.onerror = function () { alert(t('err.read')); };
  fr.readAsArrayBuffer(file);
}

/* Back to the open-file screen. Drops the loaded file so nothing stale can be
 * drawn or hit-tested, and clears the file input so re-picking the same file
 * still fires a change event. */
function goHome() {
  S.name = ''; S.bytes = null; S.result = null; S.summary = null;
  S.maps = []; S.groups = []; S.strips = [];
  S.ident = null; S.sha = null;
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
/* Static DOM text comes from data-i18n / data-i18n-title attributes; anything
 * generated at runtime goes through t(). Rule labels live in the rule pack, so a
 * language switch has to re-classify before re-rendering. */
function applyLang(lang) {
  LANG = STRINGS[lang] ? lang : 'en';
  document.documentElement.lang = LANG;
  try { localStorage.setItem('neo-finder.lang', LANG); } catch (e) { /* private mode */ }

  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  $('lang').textContent = LANG === 'bg' ? 'EN' : 'BG';   // shows what you switch to

  if (S.bytes) {
    classifyAll();
    updateChips();
    renderStrips();
    if (currentMap) openMap(currentMap);
    if ($('modal').classList.contains('open') && openModalKind) openModalKind();
  }
}

$('lang').addEventListener('click', function () { applyLang(LANG === 'bg' ? 'en' : 'bg'); });
$('home').addEventListener('click', goHome);
$('zoom-in').addEventListener('click', function () { setZoom(1); });
$('zoom-out').addEventListener('click', function () { setZoom(-1); });
$('onlymaps').addEventListener('change', renderStrips);
$('c-file').addEventListener('click', function () { if (S.ident) showIdent(); });
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

/* Saved choice wins; otherwise follow the browser, so a Bulgarian browser
 * lands on Bulgarian without touching anything. */
(function initLang() {
  var saved = null;
  try { saved = localStorage.getItem('neo-finder.lang'); } catch (e) { /* private mode */ }
  var nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  applyLang(saved || (nav.indexOf('bg') === 0 ? 'bg' : 'en'));
})();
