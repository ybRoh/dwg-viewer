// SPDX-License-Identifier: GPL-3.0-or-later
// 도면 뷰어 - Copyright (C) 2026 아라곤
// This program is free software under the GNU GPL v3 or later. See LICENSE.
// Scene builder: converts a parsed drawing (LibreDWG-style DB) into flat, render-ready primitives.
// Pure module (no DOM) so it can be tested in Node. Text measuring is injected.

export const ACI = (() => {
  const t = new Array(256).fill('#ffffff');
  const base = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#808080', '#c0c0c0'];
  for (let i = 0; i < 10; i++) t[i] = base[i];
  const vals = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15, v = (i - 10) % 10;
    let [r, g, b] = hsv(hue);
    if (v % 2 === 1) { r = r * 0.5 + 0.5; g = g * 0.5 + 0.5; b = b * 0.5 + 0.5; }
    const k = vals[v];
    t[i] = hex(r * k, g * k, b * k);
  }
  const grays = [0x33, 0x5b, 0x84, 0xad, 0xd6, 0xff];
  for (let i = 0; i < 6; i++) t[250 + i] = hex(grays[i] / 255, grays[i] / 255, grays[i] / 255);
  return t;
  function hsv(h) {
    const x = (1 - Math.abs(((h / 60) % 2) - 1));
    if (h < 60) return [1, x, 0]; if (h < 120) return [x, 1, 0]; if (h < 180) return [0, 1, x];
    if (h < 240) return [0, x, 1]; if (h < 300) return [x, 0, 1]; return [1, 0, x];
  }
  function hex(r, g, b) { return '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join(''); }
})();

export function aciColor(i) { return i === 7 ? '@fg' : ACI[i] || '@fg'; }
const rgbHex = n => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

export const TYPE_KO = {
  LINE: '선', LWPOLYLINE: '폴리선', POLYLINE2D: '폴리선(2D)', POLYLINE3D: '3D 폴리선', CIRCLE: '원', ARC: '호',
  ELLIPSE: '타원', SPLINE: '스플라인', TEXT: '문자', MTEXT: '여러 줄 문자', INSERT: '블록 참조', DIMENSION: '치수',
  LEADER: '지시선', TOLERANCE: '기하공차', HATCH: '해치', SOLID: '솔리드', TRACE: '트레이스', POINT: '점',
  ATTRIB: '속성', ATTDEF: '속성 정의', '3DFACE': '3D 면', RAY: '광선', XLINE: '구성선', VIEWPORT: '뷰포트',
  MULTILEADER: '다중 지시선', MLEADER: '다중 지시선', IMAGE: '이미지', WIPEOUT: '가리기', '3DSOLID': '3D 솔리드', REGION: '영역',
};

// ---------- text code decoding ----------
const GDT = { a: '∠', b: '⊥', c: '⏥', d: '⌓', e: '○', f: '∥', g: '⌭', h: '↗', i: '⌯', j: '⌖', k: '⌒', l: 'Ⓛ', m: 'Ⓜ', n: '⌀', p: 'Ⓟ', r: '◎', s: 'Ⓢ', t: '⌰', u: '⏤' };
export function decodePercent(s) {
  return s.replace(/%%(\d{3})/g, (_, d) => String.fromCharCode(+d))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
export function mtextPlain(s) {
  if (!s) return '';
  s = s.replace(/\\\\/g, '\u0001').replace(/\\\{/g, '\u0002').replace(/\\\}/g, '\u0003');
  s = s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\[Ff]gdt;(.)/g, (_, c) => GDT[c] || c);
  s = s.replace(/\\P/g, '\n').replace(/\\~/g, ' ');
  s = s.replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, (_, a, b) => a.trim() && b.trim() ? `${a.trim()}/${b.trim()}` : (a + b).trim());
  s = s.replace(/\\[fFcCHhTtQqWwAap][^;]*;/g, '');
  s = s.replace(/\\[LlOoKkNnXx]/g, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}');
  return decodePercent(s);
}

// ---------- affine helpers [a,b,c,d,e,f]: x' = a x + c y + e ; y' = b x + d y + f ----------
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const S = (x, y) => [x, 0, 0, y, 0, 0];
const MIRX = [-1, 0, 0, 1, 0, 0];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mscale = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const P = (p) => p ? [num(p.x), num(p.y)] : [0, 0];

const VERSIONS = { AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018' };
export const versionName = v => VERSIONS[v] || v || '알 수 없음';
const UNITS = { 0: '단위 없음', 1: 'inch', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm', 14: 'dm' };
export const unitName = u => UNITS[u] || '단위 없음';

// ---------- DXF (dxf-json) → LibreDWG-like normalization ----------
const D2R = Math.PI / 180;
export function normalizeDxf(r) {
  const header = {};
  for (const k in (r.header || {})) header[k.replace(/^\$/, '')] = r.header[k];
  const fixEnt = (e) => {
    const t = e.type;
    if (t === 'ARC') { e.startAngle = num(e.startAngle) * D2R; e.endAngle = num(e.endAngle) * D2R; }
    if (t === 'TEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
      e.rotation = num(e.rotation) * D2R; e.obliqueAngle = num(e.obliqueAngle) * D2R;
      if (e.halign == null) e.halign = num(e.horizontalJustification); if (e.valign == null) e.valign = num(e.verticalJustification);
      if (!e.endPoint) e.endPoint = e.alignmentPoint || e.startPoint;
    }
    if (t === 'MTEXT') {
      if (e.textHeight == null) e.textHeight = e.height; if (e.rectWidth == null) e.rectWidth = e.width;
      if (e.rotation != null && !e.direction) e.rotation = num(e.rotation) * D2R;
    }
    if (t === 'INSERT') e.rotation = num(e.rotation) * D2R;
    if (t === 'VIEWPORT' && e.viewTwistAngle) e.viewTwistAngle *= D2R;
    if (t === 'POLYLINE') {
      const f = num(e.flag);
      e.type = f & 8 ? 'POLYLINE3D' : (f & 16 || f & 64) ? 'POLYLINE_MESH' : 'POLYLINE2D';
      e.vertices = (e.vertices || []).map(v => ({ ...v, x: num(v.x ?? v.startPoint?.x), y: num(v.y ?? v.startPoint?.y), bulge: num(v.bulge), flag: num(v.flag) }));
    }
    if (t === 'HATCH') {
      for (const p of e.boundaryPaths || []) for (const ed of p.edges || []) {
        if (ed.type === 2 || ed.type === 3) { ed.startAngle = num(ed.startAngle) * D2R; ed.endAngle = num(ed.endAngle) * D2R; }
        if (ed.type === 3 && ed.lengthOfMinorAxis == null) ed.lengthOfMinorAxis = ed.ratio;
      }
      for (const d of e.definitionLines || []) d.angle = num(d.angle) * D2R;
    }
    return e;
  };
  const attachAttribs = (list) => {
    const out = []; let last = null;
    for (const e of list || []) {
      fixEnt(e);
      if (e.type === 'ATTRIB' && last) { (last.attribs = last.attribs || []).push(e); continue; }
      if (e.type === 'SEQEND') continue;
      if (e.type === 'INSERT') { e.attribs = e.attribs || []; last = e; } else last = null;
      out.push(e);
    }
    return out;
  };
  const blocks = [];
  for (const name in (r.blocks || {})) {
    const b = r.blocks[name];
    blocks.push({ name: b.name || name, handle: b.handle, basePoint: b.position || b.basePoint || { x: 0, y: 0 }, entities: attachAttribs(b.entities) });
  }
  const all = attachAttribs(r.entities);
  const isPaper = e => e.inPaperSpace || e.isInPaperSpace || e.paperSpace;
  const model = all.filter(e => !isPaper(e));
  const paperTop = all.filter(isPaper);
  const tbl = n => (r.tables?.[n]?.entries) || [];
  const layers = tbl('LAYER').map(l => ({ ...l, off: l.off ?? (num(l.colorIndex) < 0), frozen: l.frozen ?? !!(num(l.standardFlag) & 1), colorIndex: Math.abs(num(l.colorIndex, 7)), color: l.trueColor ?? l.color }));
  // Layouts
  const layoutObjs = (r.objects?.byName?.LAYOUT || []).filter(l => (l.layoutName || l.name) !== 'Model').sort((a, b) => num(a.tabOrder) - num(b.tabOrder));
  const paperBlocks = blocks.filter(b => /^\*paper_space/i.test(b.name)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  const layouts = paperBlocks.map((b, i) => ({ name: layoutObjs[i]?.layoutName || (i === 0 ? '배치1' : '배치' + (i + 1)), entities: i === 0 ? [...paperTop, ...b.entities] : b.entities }));
  return {
    header, layers, blocks, model, layouts,
    ltypes: tbl('LTYPE'), styles: tbl('STYLE'), dimstyles: tbl('DIMSTYLE'),
  };
}

export function normalizeDwg(db) {
  const tbl = n => db.tables?.[n]?.entries || [];
  const brs = tbl('BLOCK_RECORD');
  const blocks = brs.map(b => ({ name: b.name, handle: b.handle, basePoint: b.basePoint || { x: 0, y: 0 }, entities: b.entities || [] }));
  const byHandle = new Map(brs.map(b => [b.handle, b]));
  const layouts = (db.objects?.LAYOUT || []).filter(l => l.layoutName !== 'Model').sort((a, b) => num(a.tabOrder) - num(b.tabOrder))
    .map(l => ({ name: l.layoutName, entities: byHandle.get(l.paperSpaceTableId)?.entities || [] }));
  return {
    header: db.header || {}, layers: tbl('LAYER'), blocks, model: db.entities || [], layouts,
    ltypes: tbl('LTYPE'), styles: tbl('STYLE'), dimstyles: tbl('DIMSTYLE'),
  };
}

// ---------- geometry tessellation ----------
function arcPts(cx, cy, rx, ry, rot, a0, sweep, tol, out) {
  const r = Math.max(rx, ry);
  let step = Math.PI / 18;
  if (r > tol) step = Math.min(step, 2 * Math.acos(Math.max(-1, 1 - tol / r)));
  step = Math.max(step, Math.PI / 360);
  const n = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * i / n, x = rx * Math.cos(a), y = ry * Math.sin(a);
    out.push(cx + x * cr - y * sr, cy + x * sr + y * cr);
  }
  return out;
}
function bulgeTo(x1, y1, x2, y2, b, tol, out) {
  if (Math.abs(b) < 1e-9) { out.push(x2, y2); return; }
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  if (d < 1e-12) return;
  const th = 4 * Math.atan(b), r = d / (2 * Math.sin(th / 2)), k = r * Math.cos(th / 2) / d;
  const cx = (x1 + x2) / 2 - dy * k, cy = (y1 + y2) / 2 + dx * k;
  const a0 = Math.atan2(y1 - cy, x1 - cx), tmp = [];
  arcPts(cx, cy, Math.abs(r), Math.abs(r), 0, a0, th, tol, tmp);
  for (let i = 2; i < tmp.length; i++) out.push(tmp[i]);
}
function vertsWithBulge(vs, closed, tol) {
  const out = [];
  const n = vs.length; if (!n) return out;
  out.push(num(vs[0].x), num(vs[0].y));
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vs[i], b = vs[(i + 1) % n];
    bulgeTo(num(a.x), num(a.y), num(b.x), num(b.y), num(a.bulge), tol, out);
  }
  return out;
}
function bspline(deg, ctrl, knots, weights) {
  const n = ctrl.length; if (n < 2) return [];
  deg = Math.min(deg || 3, n - 1);
  if (!knots || knots.length !== n + deg + 1) {
    knots = []; for (let i = 0; i <= n + deg; i++) knots.push(i <= deg ? 0 : i >= n ? n - deg : i - deg);
  }
  const t0 = knots[deg], t1 = knots[n], out = [];
  const samples = Math.min(800, Math.max(16, n * 12));
  for (let s = 0; s <= samples; s++) {
    let t = t0 + (t1 - t0) * s / samples; if (s === samples) t = t1 - 1e-10 * (t1 - t0);
    let k = deg; while (k < n - 1 && knots[k + 1] <= t) k++;
    const d = []; for (let j = 0; j <= deg; j++) { const p = ctrl[k - deg + j], w = weights ? (weights[k - deg + j] || 1) : 1; d.push([p[0] * w, p[1] * w, w]); }
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], a = den ? (t - knots[i]) / den : 0;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    out.push(d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]);
  }
  return out;
}
function catmull(pts) {
  if (pts.length < 3) return pts.flat();
  const out = [], seg = 12;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    for (let s = (i ? 1 : 0); s <= seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  return out;
}
function splinePts(e) {
  const ctrl = (e.controlPoints || []).map(p => [num(p.x), num(p.y)]);
  if (ctrl.length >= 2) {
    const w = (e.weights && e.weights.length === ctrl.length) ? e.weights : (e.controlPoints.some(p => p.w > 0) ? e.controlPoints.map(p => p.w > 0 ? p.w : 1) : null);
    return bspline(num(e.degree, 3), ctrl, e.knots, w);
  }
  const fit = (e.fitPoints || []).map(p => [num(p.x), num(p.y)]);
  return catmull(fit);
}
function ellipsePts(c, maj, ratio, s, e, tol) {
  const rx = Math.hypot(maj[0], maj[1]), ry = rx * ratio, rot = Math.atan2(maj[1], maj[0]);
  let sw = e - s; while (sw <= 0) sw += 2 * Math.PI; if (sw > 2 * Math.PI + 1e-9) sw = 2 * Math.PI;
  return arcPts(c[0], c[1], rx, ry, rot, s, sw, tol, []);
}

// ---------- the builder ----------
export function buildDrawing(src, opts) {
  const { measure, fileType } = opts; // measure(str) -> width at height 1
  const H = src.header;
  const LTSCALE = num(H.LTSCALE, 1) || 1;
  const layers = new Map();
  for (const l of src.layers) {
    const ci = num(l.colorIndex, 7);
    const color = (ci >= 1 && ci <= 255) ? aciColor(ci) : (l.color != null && l.color !== 16777215 ? rgbHex(l.color) : aciColor(7));
    layers.set(l.name, { name: l.name, color, aci: ci, on: !l.off && !l.frozen, lineType: l.lineType || 'Continuous', count: 0 });
  }
  const getLayer = (n) => {
    n = n || '0';
    if (!layers.has(n)) layers.set(n, { name: n, color: '@fg', aci: 7, on: true, lineType: 'Continuous', count: 0 });
    return layers.get(n);
  };
  const ltypes = new Map();
  for (const lt of src.ltypes) ltypes.set((lt.name || '').toUpperCase(), lt);
  const blocks = new Map(src.blocks.map(b => [b.name, b]));
  const dimstyles = new Map(src.dimstyles.map(d => [d.name, d]));
  const dimScale = num(H.DIMSCALE, 1) || 1;
  const arrowSize = num(H.DIMASZ, 2.5) * dimScale || 2.5;

  let ext = [num(H.EXTMIN?.x), num(H.EXTMIN?.y), num(H.EXTMAX?.x), num(H.EXTMAX?.y)];
  if (!(ext[2] > ext[0]) || Math.abs(ext[0]) > 1e15) ext = null;
  const diag0 = ext ? Math.hypot(ext[2] - ext[0], ext[3] - ext[1]) : 1000;
  const TOL = Math.max(diag0 * 2e-6, 1e-6);

  // dash pattern cache
  const dashCache = new Map();
  function dashFor(name, scale) {
    const key = name.toUpperCase() + '@' + scale.toPrecision(5);
    if (dashCache.has(key)) return key;
    const lt = ltypes.get(name.toUpperCase());
    const pat = lt?.pattern || [];
    if (!pat.length || /^(continuous|bylayer|byblock)$/i.test(name)) { dashCache.set(key, null); return key; }
    let arr = []; // alternate dash,gap
    for (const el of pat) {
      const L = num(el.elementLength);
      const isDash = L >= 0, len = Math.max(Math.abs(L), 0) * scale;
      const v = isDash && len === 0 ? scale * 0.02 : len;
      if (arr.length && arr[arr.length - 1].d === isDash) arr[arr.length - 1].v += v; else arr.push({ d: isDash, v });
    }
    if (arr.length && !arr[0].d) arr.push(arr.shift());
    if (arr.length > 1 && arr[0].d === arr[arr.length - 1].d) { arr[0].v += arr.pop().v; }
    const out = arr.map(a => Math.max(a.v, 1e-9));
    if (out.length < 2) { dashCache.set(key, null); return key; }
    dashCache.set(key, { arr: out, period: out.reduce((s, v) => s + v, 0) });
    return key;
  }

  const lpIds = new Map(), lpList = [];
  const lpOf = (a, b) => { const k = a + '\u0000' + b; let id = lpIds.get(k); if (id == null) { id = lpList.length; lpIds.set(k, id); lpList.push([a, b]); } return id; };

  const unsupported = {};
  const typeCount = {};
  const allTexts = []; // for calibration
  const styleRatios = new Map();

  function newSpace(name, isPaper) {
    return { name, isPaper, batches: new Map(), fills: [], texts: [], points: [], ents: [], segs: [], segEnt: [], segLp: [], snaps: [], viewports: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], origin: [0, 0] };
  }

  function build(space, entities, origin) {
    space.origin = origin;
    const M0 = T(-origin[0], -origin[1]);
    for (const e of entities) {
      if (!e || e.isVisible === false) continue;
      const id = space.ents.length;
      const rec = { id, type: e.type, layer: e.layer || '0', handle: e.handle, raw: e, bbox: [Infinity, Infinity, -Infinity, -Infinity] };
      space.ents.push(rec);
      typeCount[e.type] = (typeCount[e.type] || 0) + 1;
      getLayer(e.layer).count++;
      emit(space, e, { M: M0, layer: e.layer || '0', top: e.layer || '0', color: null, ltype: null, lts: 1, ent: id, depth: 0, rec });
    }
  }

  function props(e, ctx) {
    const effLayer = (ctx.depth > 0 && (!e.layer || e.layer === '0')) ? ctx.layer : (e.layer || '0');
    const L = getLayer(effLayer);
    let color;
    if (typeof e.color === 'number' && isFinite(e.color)) color = rgbHex(e.color);
    else if (typeof e.trueColor === 'number') color = rgbHex(e.trueColor);
    if (!color) {
      const ci = e.colorIndex == null ? 256 : e.colorIndex;
      if (ci === 256) color = L.color; else if (ci === 0) color = ctx.color || '@fg'; else color = aciColor(ci);
    }
    let lt = e.lineType;
    if (!lt || /^bylayer$/i.test(lt)) lt = L.lineType || 'Continuous';
    else if (/^byblock$/i.test(lt)) lt = ctx.ltype || 'Continuous';
    const scale = num(e.lineTypeScale, 1) * LTSCALE * ctx.lts;
    return { layer: effLayer, color, lt, dash: dashFor(lt, scale), lp: lpOf(effLayer, ctx.top) };
  }

  function grow(space, ctx, x, y) {
    const b = space.bbox; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    const r = ctx.rec.bbox; if (x < r[0]) r[0] = x; if (y < r[1]) r[1] = y; if (x > r[2]) r[2] = x; if (y > r[3]) r[3] = y;
  }

  function line(space, ctx, pr, local, closed, M) {
    if (local.length < 4) return;
    const n = local.length / 2, w = new Float64Array(local.length + (closed ? 2 : 0));
    for (let i = 0; i < n; i++) { const x = local[i * 2], y = local[i * 2 + 1]; w[i * 2] = M[0] * x + M[2] * y + M[4]; w[i * 2 + 1] = M[1] * x + M[3] * y + M[5]; }
    if (closed) { w[n * 2] = w[0]; w[n * 2 + 1] = w[1]; }
    let bad = false;
    for (let i = 0; i < w.length; i++) if (!isFinite(w[i])) { bad = true; break; }
    if (bad) return;
    const key = pr.color + '|' + pr.dash + '|' + pr.lp;
    let bt = space.batches.get(key);
    if (!bt) { bt = { color: pr.color, dash: pr.dash, lp: pr.lp, polys: [] }; space.batches.set(key, bt); }
    bt.polys.push(w);
    for (let i = 0; i + 3 < w.length; i += 2) {
      space.segs.push(w[i], w[i + 1], w[i + 2], w[i + 3]); space.segEnt.push(ctx.ent); space.segLp.push(pr.lp);
      grow(space, ctx, w[i], w[i + 1]);
    }
    grow(space, ctx, w[w.length - 2], w[w.length - 1]);
  }
  function fill(space, ctx, pr, ringsLocal, M) {
    const rings = [];
    for (const r of ringsLocal) {
      if (r.length < 6) continue;
      const w = new Float64Array(r.length);
      for (let i = 0; i < r.length; i += 2) { w[i] = M[0] * r[i] + M[2] * r[i + 1] + M[4]; w[i + 1] = M[1] * r[i] + M[3] * r[i + 1] + M[5]; grow(space, ctx, w[i], w[i + 1]); }
      rings.push(w);
    }
    if (rings.length) space.fills.push({ rings, color: pr.color, lp: pr.lp, ent: ctx.ent });
  }
  function snap(space, ctx, pr, M, x, y, kind) {
    const [wx, wy] = ap(M, x, y); if (isFinite(wx) && isFinite(wy)) space.snaps.push(wx, wy, kind, pr.lp);
  }
  function point(space, ctx, pr, M, x, y) {
    const [wx, wy] = ap(M, x, y); if (!isFinite(wx)) return;
    space.points.push({ x: wx, y: wy, color: pr.color, lp: pr.lp, ent: ctx.ent }); grow(space, ctx, wx, wy);
    space.snaps.push(wx, wy, 3, pr.lp);
  }
  // text: lines[], anchor local (x,y), h, rot, opts
  function text(space, ctx, pr, M, t) {
    const [ax, ay] = ap(M, t.x, t.y);
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    const dx = M[0] * c + M[2] * s, dy = M[1] * c + M[3] * s;
    const ux = M[0] * -s + M[2] * c, uy = M[1] * -s + M[3] * c;
    const sx = Math.hypot(dx, dy) || 1, sy = Math.hypot(ux, uy) || 1;
    const rec = {
      x: ax, y: ay, rot: Math.atan2(dy, dx), h: t.h * sy, xs: (t.xs || 1) * sx / sy, ob: t.ob || 0, style: t.style || '',
      paras: t.paras, wrapW: t.wrapW ? t.wrapW * sx : 0, halign: t.halign, valign: t.valign, lineGap: t.lineGap || 5 / 3,
      knownW: t.knownW ? t.knownW * sx : 0, color: pr.color, lp: pr.lp, ent: ctx.ent, layer: pr.layer, kind: t.kind, mtextAttach: t.mtextAttach,
      space, ctx,
    };
    if (!(rec.h > 0) || !isFinite(ax) || !isFinite(ay)) return;
    space.texts.push(rec); allTexts.push(rec);
    space.snaps.push(ax, ay, 4, pr.lp);
  }

  function emit(space, e, ctx) {
    if (ctx.depth > 12) return;
    const M = ctx.M;
    const ocs = e.extrusionDirection && num(e.extrusionDirection.z) < -0.5;
    const Mo = ocs ? mul(M, MIRX) : M;
    const t = e.type;
    switch (t) {
      case 'LINE': {
        const pr = props(e, ctx), a = P(e.startPoint), b = P(e.endPoint);
        line(space, ctx, pr, [a[0], a[1], b[0], b[1]], false, M);
        snap(space, ctx, pr, M, a[0], a[1], 0); snap(space, ctx, pr, M, b[0], b[1], 0); snap(space, ctx, pr, M, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1);
        break;
      }
      case 'LWPOLYLINE': case 'POLYLINE2D': case 'POLYLINE3D': {
        const pr = props(e, ctx);
        let vs = (e.vertices || []).filter(v => !(num(v.flag) & 16));
        const closed = !!(num(e.flag) & 1);
        const pts = t === 'POLYLINE3D' ? vs.flatMap(v => [num(v.x), num(v.y)]) : vertsWithBulge(vs, closed, TOL);
        if (t === 'POLYLINE3D' && closed && pts.length) pts.push(pts[0], pts[1]);
        const w = num(e.constantWidth);
        if (w > 0 && vs.length === 2 && !num(vs[0].bulge)) {
          // wide segment → filled quad
          const [x1, y1] = [num(vs[0].x), num(vs[0].y)], [x2, y2] = [num(vs[1].x), num(vs[1].y)];
          const L = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / L * w / 2, ny = (x2 - x1) / L * w / 2;
          fill(space, ctx, pr, [[x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny]], Mo);
        }
        line(space, ctx, pr, pts, false, Mo);
        for (let i = 0; i < vs.length; i++) {
          snap(space, ctx, pr, Mo, num(vs[i].x), num(vs[i].y), 0);
          const nb = vs[i + 1] || (closed ? vs[0] : null);
          if (nb && !num(vs[i].bulge)) snap(space, ctx, pr, Mo, (num(vs[i].x) + num(nb.x)) / 2, (num(vs[i].y) + num(nb.y)) / 2, 1);
        }
        break;
      }
      case 'CIRCLE': {
        const pr = props(e, ctx), c = P(e.center), r = num(e.radius);
        if (!(r > 0)) break;
        line(space, ctx, pr, arcPts(c[0], c[1], r, r, 0, 0, 2 * Math.PI, TOL / mscale(Mo), []), false, Mo);
        snap(space, ctx, pr, Mo, c[0], c[1], 2);
        for (let k = 0; k < 4; k++) snap(space, ctx, pr, Mo, c[0] + r * Math.cos(k * Math.PI / 2), c[1] + r * Math.sin(k * Math.PI / 2), 3);
        break;
      }
      case 'ARC': {
        const pr = props(e, ctx), c = P(e.center), r = num(e.radius);
        if (!(r > 0)) break;
        const s = num(e.startAngle); let sw = num(e.endAngle) - s; while (sw <= 0) sw += 2 * Math.PI;
        line(space, ctx, pr, arcPts(c[0], c[1], r, r, 0, s, sw, TOL / mscale(Mo), []), false, Mo);
        snap(space, ctx, pr, Mo, c[0], c[1], 2);
        snap(space, ctx, pr, Mo, c[0] + r * Math.cos(s), c[1] + r * Math.sin(s), 0);
        snap(space, ctx, pr, Mo, c[0] + r * Math.cos(s + sw), c[1] + r * Math.sin(s + sw), 0);
        snap(space, ctx, pr, Mo, c[0] + r * Math.cos(s + sw / 2), c[1] + r * Math.sin(s + sw / 2), 1);
        break;
      }
      case 'ELLIPSE': {
        const pr = props(e, ctx), c = P(e.center), m = P(e.majorAxisEndPoint);
        let maj = m; if (ocs) maj = [m[0], m[1]];
        line(space, ctx, pr, ellipsePts(c, maj, num(e.axisRatio, 1), num(e.startAngle), num(e.endAngle, 2 * Math.PI), TOL / mscale(M)), false, M);
        snap(space, ctx, pr, M, c[0], c[1], 2);
        break;
      }
      case 'SPLINE': {
        const pr = props(e, ctx), pts = splinePts(e);
        line(space, ctx, pr, pts, !!(num(e.flag) & 1) && false, M);
        if (pts.length >= 2) { snap(space, ctx, pr, M, pts[0], pts[1], 0); snap(space, ctx, pr, M, pts[pts.length - 2], pts[pts.length - 1], 0); }
        break;
      }
      case 'SOLID': case 'TRACE': {
        const pr = props(e, ctx), a = P(e.corner1), b = P(e.corner2), c = P(e.corner3), d = e.corner4 ? P(e.corner4) : c;
        fill(space, ctx, pr, [[a[0], a[1], b[0], b[1], d[0], d[1], c[0], c[1]]], Mo);
        break;
      }
      case '3DFACE': {
        const pr = props(e, ctx), corners = faceCorners3d(e);
        const pts = [corners[0], corners[1], corners[2], corners[3] || corners[2]].map(P);
        line(space, ctx, pr, pts.flat(), true, M);
        break;
      }
      case 'POINT': {
        const pr = props(e, ctx), p = P(e.position);
        point(space, ctx, pr, M, p[0], p[1]);
        break;
      }
      case 'RAY': case 'XLINE': {
        const pr = props(e, ctx), p = P(e.firstPoint || e.basePoint || e.position), d = P(e.unitDirection || e.direction);
        const L = diag0 * 3;
        line(space, ctx, pr, [t === 'XLINE' ? p[0] - d[0] * L : p[0], t === 'XLINE' ? p[1] - d[1] * L : p[1], p[0] + d[0] * L, p[1] + d[1] * L], false, M);
        break;
      }
      case 'TEXT': case 'ATTRIB': case 'ATTDEF': {
        if (t === 'ATTDEF' && ctx.depth > 0) break;
        const te = (e.text && typeof e.text === 'object') ? { ...e, ...e.text } : e;
        if (t === 'ATTRIB' && (num(te.flags) & 1 || num(te.attributeFlag) & 1)) break;
        let str = t === 'ATTDEF' ? (te.tag || te.text || '') : (te.text ?? te.value ?? '');
        str = decodePercent(String(str));
        if (!str.trim()) break;
        const pr = props(e, ctx);
        const h = num(te.textHeight, num(te.height, 2.5));
        const ha = num(te.halign), va = num(te.valign);
        const sp = P(te.startPoint), ep = te.endPoint ? P(te.endPoint) : sp;
        let x = sp[0], y = sp[1], rot = num(te.rotation), knownW = 0, align = 'left', valign = va;
        const d = Math.hypot(ep[0] - sp[0], ep[1] - sp[1]);
        if (ha === 3 || ha === 5) {
          if (d > 1e-9) { rot = Math.atan2(ep[1] - sp[1], ep[0] - sp[0]); knownW = d; }
          valign = 0;
        } else if (ha || va) {
          x = ep[0]; y = ep[1];
          align = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
          if (ha === 4) valign = 2;
          if (fileType === 'dwg' && d > 1e-9 && va <= 1) {
            const proj = (ep[0] - sp[0]) * Math.cos(rot) + (ep[1] - sp[1]) * Math.sin(rot);
            if (align === 'center' && proj > 0) knownW = 2 * proj; else if (align === 'right' && proj > 0) knownW = proj;
          }
        }
        text(space, ctx, pr, Mo, { x, y, h, rot, xs: num(te.xScale, 1) || 1, ob: num(te.obliqueAngle), style: te.styleName, paras: [str], halign: align, valign, knownW, kind: t });
        break;
      }
      case 'MTEXT': {
        const raw = e.text || '';
        const str = mtextPlain(raw);
        if (!str.trim()) break;
        const pr = props(e, ctx);
        let h = num(e.textHeight, 2.5);
        const hm = /\\H([\d.]+);/.exec(raw); if (hm && !/x/.test(hm[0])) h = +hm[1] || h;
        const ip = P(e.insertionPoint);
        let rot = num(e.rotation);
        if (e.direction && (num(e.direction.x) || num(e.direction.y))) rot = Math.atan2(num(e.direction.y), num(e.direction.x));
        const at = num(e.attachmentPoint, 1) || 1;
        const col = (at - 1) % 3, row = Math.floor((at - 1) / 3);
        const paras = str.split('\n');
        const W = num(e.rectWidth);
        const knownW = (paras.length === 1 && num(e.extentsWidth) > 0) ? num(e.extentsWidth) : 0;
        text(space, ctx, pr, Mo, { x: ip[0], y: ip[1], h, rot, xs: 1, style: e.styleName, paras, wrapW: W > 0 ? W : 0, halign: ['left', 'center', 'right'][col], valign: 3 - row, lineGap: 5 / 3 * (num(e.lineSpacing, 1) || 1), knownW, kind: 'MTEXT', mtextAttach: true });
        break;
      }
      case 'INSERT': {
        const blk = blocks.get(e.name);
        const prI = props(e, ctx);
        const ip = P(e.insertionPoint);
        snap(space, ctx, prI, Mo, ip[0], ip[1], 4);
        if (blk) {
          const bp = P(blk.basePoint);
          const xs = num(e.xScale, 1) || 1, ys = num(e.yScale, xs) || xs;
          const cols = Math.max(1, num(e.columnCount, 1)), rows = Math.max(1, num(e.rowCount, 1));
          const ltsAbs = Math.sqrt(Math.abs(xs * ys)) || 1;
          for (let ci = 0; ci < cols && ci < 100; ci++) for (let ri = 0; ri < rows && ri < 100; ri++) {
            const Mi = mul(Mo, mul(T(ip[0], ip[1]), mul(R(num(e.rotation)), mul(T(ci * num(e.columnSpacing), ri * num(e.rowSpacing)), mul(S(xs, ys), T(-bp[0], -bp[1]))))));
            const sub = { M: Mi, layer: prI.layer, top: ctx.top, color: prI.color, ltype: prI.lt, lts: ctx.lts * ltsAbs, ent: ctx.ent, depth: ctx.depth + 1, rec: ctx.rec };
            for (const be of blk.entities) if (be && be.isVisible !== false) emit(space, be, sub);
          }
        } else (unsupported['블록 없음: ' + e.name] = (unsupported['블록 없음: ' + e.name] || 0) + 1);
        for (const a of e.attribs || []) emit(space, a, { ...ctx, layer: prI.layer, color: prI.color, depth: ctx.depth + 1 });
        break;
      }
      case 'DIMENSION': {
        const blk = blocks.get(e.name);
        if (blk && blk.entities.length) {
          const prD = props(e, ctx);
          const ip = P(e.insertionPoint);
          const sub = { M: mul(M, T(ip[0], ip[1])), layer: prD.layer, top: ctx.top, color: prD.color, ltype: prD.lt, lts: ctx.lts, ent: ctx.ent, depth: ctx.depth + 1, rec: ctx.rec };
          for (const be of blk.entities) if (be && be.isVisible !== false) emit(space, be, sub);
        } else {
          const pr = props(e, ctx), tp = P(e.textPoint);
          let s = e.text && e.text !== '<>' ? mtextPlain(e.text) : (+num(e.measurement)).toFixed(2).replace(/\.?0+$/, '');
          const ds = dimstyles.get(e.styleName);
          text(space, ctx, pr, M, { x: tp[0], y: tp[1], h: num(ds?.DIMTXT, 2.5) * (num(ds?.DIMSCALE, 1) || 1), rot: num(e.textRotation), paras: [s], halign: 'center', valign: 2, kind: 'DIMENSION' });
        }
        break;
      }
      case 'LEADER': {
        const pr = props(e, ctx), vs = (e.vertices || []).map(P);
        if (vs.length < 2) break;
        line(space, ctx, pr, vs.flat(), false, M);
        if (e.isArrowheadEnabled !== false) {
          const [a, b] = vs, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
          const s = Math.min(arrowSize, L * 0.6), w = s / 6;
          fill(space, ctx, pr, [[a[0], a[1], a[0] + ux * s - uy * w, a[1] + uy * s + ux * w, a[0] + ux * s + uy * w, a[1] + uy * s - ux * w]], M);
        }
        snap(space, ctx, pr, M, vs[0][0], vs[0][1], 0);
        break;
      }
      case 'TOLERANCE': {
        const pr = props(e, ctx);
        const ds = dimstyles.get(e.styleName);
        const h = num(ds?.DIMTXT, 2.5) * (num(ds?.DIMSCALE, 1) || dimScale);
        const ip = P(e.insertionPoint), xd = P(e.xAxisDirection);
        const rot = (xd[0] || xd[1]) ? Math.atan2(xd[1], xd[0]) : 0;
        const rowsTxt = String(e.text || '').split(/\^J|\\P/);
        const Mr = mul(M, mul(T(ip[0], ip[1]), R(rot)));
        const boxH = h * 2;
        rowsTxt.forEach((rowTxt, ri) => {
          const cells = rowTxt.split('%%v').map(c => mtextPlain(c)).filter((c, i, a) => c.trim() || (i > 0 && i < a.length - 1));
          let x = 0; const y0 = -ri * boxH;
          for (const c of cells) {
            if (!c.trim()) continue;
            const w = Math.max(measure(c) * h * 1.0 + h, boxH);
            line(space, ctx, pr, [x, y0 + boxH / 2, x + w, y0 + boxH / 2, x + w, y0 - boxH / 2, x, y0 - boxH / 2], true, Mr);
            text(space, ctx, pr, Mr, { x: x + w / 2, y: y0, h, rot: 0, paras: [c], halign: 'center', valign: 2, kind: 'TOLERANCE' });
            x += w;
          }
        });
        break;
      }
      case 'HATCH': {
        const pr = props(e, ctx);
        const rings = hatchRings(e);
        if (!rings.length) break;
        const solid = num(e.solidFill) === 1 || /^solid$/i.test(e.patternName || '') || e.gradientFlag;
        if (solid) fill(space, ctx, pr, rings, Mo);
        else {
          const segs = hatchLines(rings, e.definitionLines || [], diag0);
          if (segs === null) fill(space, ctx, { ...pr, color: pr.color }, rings, Mo);
          else for (let i = 0; i < segs.length; i += 4) line(space, ctx, { ...pr, dash: dashFor('Continuous', 1) }, [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]], false, Mo);
          // hatch boundaries are not drawn in AutoCAD unless they are separate objects
        }
        break;
      }
      case 'VIEWPORT': {
        if (!space.isPaper) break;
        const c = P(e.viewportCenter || e.center), w = num(e.width), h = num(e.height);
        if (!(w > 0 && h > 0)) break;
        space.viewports.push({ c: ap(M, c[0], c[1]), w, h, vc: P(e.displayCenter || e.viewCenter), vh: num(e.viewHeight), twist: num(e.viewTwistAngle), ent: ctx.ent });
        const pr = props(e, ctx);
        line(space, ctx, pr, [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2, c[0] - w / 2, c[1] + h / 2], true, M);
        break;
      }
      case 'MULTILEADER': case 'MLEADER': {
        const pr = props(e, ctx);
        const cd = e.contextData || {};
        const txt = cd.mtext?.text || cd.textContent || e.text;
        for (const ld of cd.leaders || []) for (const ll of ld.leaderLines || ld.lines || []) {
          const vs = (ll.vertices || []).map(P); if (ld.lastLeaderLinePoint) vs.push(P(ld.lastLeaderLinePoint));
          if (vs.length >= 2) line(space, ctx, pr, vs.flat(), false, M);
        }
        if (txt) {
          const loc = P(cd.mtext?.anchorPoint || cd.textLocation || cd.contentBasePosition);
          text(space, ctx, pr, M, { x: loc[0], y: loc[1], h: num(cd.textHeight || cd.mtext?.textHeight, 2.5), rot: 0, paras: mtextPlain(txt).split('\n'), halign: 'left', valign: 3, kind: 'MTEXT' });
        } else unsupported[t] = (unsupported[t] || 0) + 1;
        break;
      }
      default:
        if (ctx.depth === 0 || !/^(SEQEND|VERTEX|ATTDEF)$/.test(t)) unsupported[t] = (unsupported[t] || 0) + 1;
    }
  }

  function hatchRings(e) {
    const rings = [];
    for (const p of e.boundaryPaths || []) {
      if (p.vertices && p.vertices.length) {
        const vs = p.vertices; const pts = vertsWithBulge(vs, true, TOL);
        rings.push(pts);
      } else if (p.edges && p.edges.length) {
        const pts = [];
        for (const ed of p.edges) {
          let seg = [];
          if (ed.type === 1) { const a = P(ed.start), b = P(ed.end); seg = [a[0], a[1], b[0], b[1]]; }
          else if (ed.type === 2) {
            const c = P(ed.center), r = num(ed.radius); let s = num(ed.startAngle), en = num(ed.endAngle);
            const ccw = ed.isCCW === undefined ? true : !!ed.isCCW;
            if (!ccw) { s = -s; en = -en; }
            let sw = en - s;
            if (ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
            if (Math.abs(sw) > 2 * Math.PI) sw = Math.sign(sw) * 2 * Math.PI;
            seg = arcPts(c[0], c[1], r, r, 0, s, sw, TOL, []);
          } else if (ed.type === 3) {
            const c = P(ed.center), m = P(ed.end); const ratio = num(ed.lengthOfMinorAxis, 1);
            let s = num(ed.startAngle), en = num(ed.endAngle); const ccw = ed.isCCW === undefined ? true : !!ed.isCCW;
            if (!ccw) { s = -s; en = -en; }
            const rx = Math.hypot(m[0], m[1]); let sw = en - s;
            if (ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
            seg = arcPts(c[0], c[1], rx, rx * ratio, Math.atan2(m[1], m[0]), s, sw, TOL, []);
          } else if (ed.type === 4) seg = splinePts({ controlPoints: ed.controlPoints, knots: ed.knots, degree: ed.degree, fitPoints: ed.fitDatum || ed.fitPoints });
          if (!seg.length) continue;
          // orient segment to connect with previous end
          if (pts.length >= 2) {
            const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
            const dS = Math.hypot(seg[0] - lx, seg[1] - ly), dE = Math.hypot(seg[seg.length - 2] - lx, seg[seg.length - 1] - ly);
            if (dE < dS) { const rev = []; for (let i = seg.length - 2; i >= 0; i -= 2) rev.push(seg[i], seg[i + 1]); seg = rev; }
          }
          for (const v of seg) pts.push(v);
        }
        if (pts.length >= 6) rings.push(pts);
      }
    }
    return rings;
  }

  function hatchLines(rings, defs, diag) {
    if (!defs.length) return null;
    const out = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const r of rings) for (let i = 0; i < r.length; i += 2) { bx0 = Math.min(bx0, r[i]); bx1 = Math.max(bx1, r[i]); by0 = Math.min(by0, r[i + 1]); by1 = Math.max(by1, r[i + 1]); }
    let budget = 60000;
    for (const d of defs) {
      const a = num(d.angle), ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
      const base = P(d.base), off = P(d.offset);
      const sp = off[0] * nx + off[1] * ny; // spacing along normal
      if (Math.abs(sp) < 1e-9) continue;
      const shift = off[0] * ux + off[1] * uy;
      const corners = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([x, y]) => (x - base[0]) * nx + (y - base[1]) * ny);
      const k0 = Math.ceil(Math.min(...corners) / sp - 1e-9), k1 = Math.floor(Math.max(...corners) / sp + 1e-9);
      const kmin = Math.min(k0, k1), kmax = Math.max(k0, k1);
      if (kmax - kmin > 4000) return null;
      const dashes = (d.dashLengths || []).map(Number).filter(isFinite);
      for (let k = kmin; k <= kmax; k++) {
        const ox = base[0] + off[0] * k, oy = base[1] + off[1] * k; // a point on the line; dash phase origin
        const ts = [];
        for (const r of rings) for (let i = 0; i + 3 < r.length; i += 2) {
          const x1 = r[i], y1 = r[i + 1], x2 = r[i + 2], y2 = r[i + 3];
          const d1 = (x1 - ox) * nx + (y1 - oy) * ny, d2 = (x2 - ox) * nx + (y2 - oy) * ny;
          if ((d1 > 0) === (d2 > 0)) continue;
          const f = d1 / (d1 - d2), ix = x1 + (x2 - x1) * f, iy = y1 + (y2 - y1) * f;
          ts.push((ix - ox) * ux + (iy - oy) * uy);
        }
        ts.sort((p, q) => p - q);
        for (let i = 0; i + 1 < ts.length; i += 2) {
          const t0 = ts[i], t1 = ts[i + 1];
          if (!dashes.length) { out.push(ox + ux * t0, oy + uy * t0, ox + ux * t1, oy + uy * t1); if (--budget < 0) return null; continue; }
          const per = dashes.reduce((s, v) => s + Math.abs(v), 0); if (per <= 0) continue;
          let t = Math.floor(t0 / per) * per;
          while (t < t1) {
            for (const dl of dashes) {
              const len = Math.abs(dl), a0 = t, a1 = t + (len || per * 0.01);
              if (dl >= 0) { const s0 = Math.max(a0, t0), s1 = Math.min(a1, t1); if (s1 > s0) { out.push(ox + ux * s0, oy + uy * s0, ox + ux * s1, oy + uy * s1); if (--budget < 0) return null; } }
              t += len; if (t >= t1) break;
            }
          }
        }
      }
    }
    return out;
  }

  // ----- build spaces -----
  const tStart = Date.now();
  let origin = ext ? [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2] : [0, 0];
  const model = newSpace('모델', false);
  build(model, src.model, origin);
  if (!(model.bbox[0] <= model.bbox[2])) model.bbox = [-100, -100, 100, 100];
  const layouts = src.layouts.map(l => { const sp = newSpace(l.name, true); build(sp, l.entities, [0, 0]); return sp; });

  // ----- text finalize: calibrate widths per style, wrap, bbox -----
  const samples = new Map();
  for (const t of allTexts) {
    t.mw = t.paras.map(p => measure(p));
    if (t.knownW > 0 && t.paras.length === 1 && t.mw[0] > 0) {
      const r = t.knownW / (t.mw[0] * t.h * t.xs);
      if (r > 0.3 && r < 3) { if (!samples.has(t.style)) samples.set(t.style, []); samples.get(t.style).push(r); }
    }
  }
  const all = [];
  for (const [k, arr] of samples) { arr.sort((a, b) => a - b); styleRatios.set(k, arr[arr.length >> 1]); all.push(...arr); }
  all.sort((a, b) => a - b);
  const globalRatio = all.length ? all[all.length >> 1] : 1;
  for (const t of allTexts) {
    let ratio = styleRatios.get(t.style) ?? globalRatio;
    if (t.knownW > 0 && t.paras.length === 1 && t.mw[0] > 0) {
      const r = t.knownW / (t.mw[0] * t.h * t.xs); if (r > 0.3 && r < 3) ratio = r;
    }
    t.wf = t.xs * ratio; // horizontal scale applied to measured glyphs
    // wrap
    let lines = [];
    if (t.wrapW > 0) {
      const maxW = t.wrapW * 1.04 / (t.h * t.wf);
      for (const p of t.paras) lines.push(...wrapPara(p, maxW, measure));
    } else lines = t.paras;
    t.lines = lines;
    t.lw = lines.map(l => measure(l) * t.h * t.wf);
    const W = Math.max(0, ...t.lw);
    const n = lines.length, gap = t.lineGap * t.h;
    // first baseline offset (local y, up positive)
    let base0;
    if (t.mtextAttach) {
      const totalH = t.h + (n - 1) * gap;
      base0 = t.valign === 3 ? -t.h : t.valign === 2 ? -t.h + totalH / 2 - t.h / 2 + t.h / 2 : (n - 1) * gap;
      if (t.valign === 2) base0 = totalH / 2 - t.h;
    } else {
      base0 = t.valign === 0 ? 0 : t.valign === 1 ? t.h * 0.25 : t.valign === 2 ? -t.h / 2 : -t.h;
    }
    t.base0 = base0; t.gap = gap; t.W = W;
    const x0 = t.halign === 'center' ? -W / 2 : t.halign === 'right' ? -W : 0;
    t.local = [x0, base0 - (n - 1) * gap - t.h * 0.3, x0 + W, base0 + t.h * 1.05];
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    for (const [lx, ly] of [[t.local[0], t.local[1]], [t.local[2], t.local[1]], [t.local[2], t.local[3]], [t.local[0], t.local[3]]]) {
      const x = t.x + lx * c - ly * s, y = t.y + lx * s + ly * c;
      grow(t.space, t.ctx, x, y);
    }
    t.space = null; t.ctx = null;
  }
  for (const sp of [model, ...layouts]) for (const r of sp.ents) if (r.bbox && !(r.bbox[0] <= r.bbox[2])) r.bbox = null;

  // Robust extents for the model: ignore far outliers (<0.5% of geometry)
  model.fullBBox = model.bbox.slice();
  model.viewBBox = robustBBox(model);

  return {
    header: H, layers, lpList, model, layouts, typeCount, unsupported, blocks,
    buildMs: Date.now() - tStart, ltypes: dashCache, globalRatio,
  };
}

// ---------- native 3D mesh extraction (3DFACE / legacy POLYFACE mesh / 3D polygon mesh / 3D polyline) ----------
// Scans top-level model-space entities (entities nested inside INSERT/block references are not
// expanded) for real 3D geometry the DWG/DXF format carries outside the proprietary ACIS solid
// format, and returns it as plain {kind, vertices:[[x,y,z],...], faces:[[i,i,i,...],...]} records
// ready for direct 3D display — no reconstruction or guessing involved, just reading what is
// actually stored in the file.
export function faceCorners3d(e) {
  // libredwg-web (DWG) exposes corner1..corner4; dxf-json (DXF) exposes a vertices[] array instead.
  if (e.corner1) return [e.corner1, e.corner2, e.corner3, e.corner4];
  return e.vertices || [];
}
export function extractNativeMesh3D(entities) {
  const P3 = p => p ? [num(p.x), num(p.y), num(p.z)] : [0, 0, 0];
  const out = [];
  for (const e of entities || []) {
    if (!e || e.isVisible === false) continue;
    const t = e.type;
    if (t === '3DFACE') {
      const raw = faceCorners3d(e).filter(Boolean).map(P3);
      const pts = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1] || p[2] !== raw[i - 1][2]);
      if (pts.length >= 3) out.push({ kind: 'face', handle: e.handle, layer: e.layer || '0', vertices: pts, faces: [pts.map((_, i) => i)] });
    } else if (t === 'POLYLINE2D' || t === 'POLYLINE3D' || t === 'POLYLINE_MESH' || t === 'POLYLINE') {
      const flag = num(e.flag);
      const vs = e.vertices || [];
      if (flag & 64) { // legacy POLYFACE mesh: vertex-definition records + face-definition records (flag 128)
        // DXF vertex-flag convention: a polyface coordinate vertex carries bit 64 (often combined
        // with bit 128); a pure face-definition record carries bit 128 WITHOUT bit 64.
        const coordVerts = [], faceRecs = [];
        for (const v of vs) {
          const vf = num(v.flag);
          ((vf & 128) && !(vf & 64) ? faceRecs : coordVerts).push(v);
        }
        const vertices = coordVerts.map(P3);
        const faces = [];
        // Face-index fields differ by source library: libredwg-web (DWG) uses polyfaceIndex0..3,
        // dxf-json (DXF) uses a faces:[] array. Support both.
        for (const fr of (faceRecs.length ? faceRecs : coordVerts)) {
          const raw = Array.isArray(fr.faces) ? fr.faces : [fr.polyfaceIndex0, fr.polyfaceIndex1, fr.polyfaceIndex2, fr.polyfaceIndex3];
          const idx = raw.map(n => num(n)).filter(n => n !== 0).map(n => Math.abs(n) - 1);
          if (idx.length >= 3 && idx.every(i => i >= 0 && i < vertices.length)) faces.push(idx);
        }
        if (vertices.length >= 3 && faces.length) out.push({ kind: 'polyface', handle: e.handle, layer: e.layer || '0', vertices, faces });
      } else if (flag & 16) { // 3D polygon mesh grid (M x N vertices, row-major)
        const m = num(e.meshMVertexCount), n = num(e.meshNVertexCount);
        if (m >= 2 && n >= 2 && vs.length >= m * n) {
          const vertices = vs.slice(0, m * n).map(P3);
          const closedM = !!(flag & 1), closedN = !!(flag & 32);
          const iMax = closedM ? m : m - 1, jMax = closedN ? n : n - 1;
          const faces = [];
          for (let i = 0; i < iMax; i++) for (let j = 0; j < jMax; j++) {
            const i1 = (i + 1) % m, j1 = (j + 1) % n;
            faces.push([i * n + j, i1 * n + j, i1 * n + j1, i * n + j1]);
          }
          if (faces.length) out.push({ kind: 'grid', handle: e.handle, layer: e.layer || '0', vertices, faces });
        }
      } else if (flag & 8) { // pure 3D polyline: a real 3D wire, not a mesh
        const pts = vs.filter(v => !(num(v.flag) & 16)).map(P3);
        if (pts.length >= 2) out.push({ kind: 'wire', handle: e.handle, layer: e.layer || '0', vertices: pts, closed: !!(flag & 1) });
      }
    }
  }
  return out;
}

function robustBBox(sp) {
  const n = sp.ents.length; if (n < 50) return sp.bbox.slice();
  const xs = [], ys = [];
  for (const r of sp.ents) if (r.bbox) { xs.push((r.bbox[0] + r.bbox[2]) / 2); ys.push((r.bbox[1] + r.bbox[3]) / 2); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * f)))];
  const x0 = q(xs, 0.005), x1 = q(xs, 0.995), y0 = q(ys, 0.005), y1 = q(ys, 0.995);
  const w = Math.max(x1 - x0, y1 - y0, 1e-6);
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of sp.ents) {
    if (!r.bbox) continue;
    const cx = (r.bbox[0] + r.bbox[2]) / 2, cy = (r.bbox[1] + r.bbox[3]) / 2;
    if (cx < x0 - w * 0.5 || cx > x1 + w * 0.5 || cy < y0 - w * 0.5 || cy > y1 + w * 0.5) continue;
    bb[0] = Math.min(bb[0], r.bbox[0]); bb[1] = Math.min(bb[1], r.bbox[1]); bb[2] = Math.max(bb[2], r.bbox[2]); bb[3] = Math.max(bb[3], r.bbox[3]);
  }
  return bb[0] <= bb[2] ? bb : sp.bbox.slice();
}

function wrapPara(p, maxW, measure) {
  if (!p) return [''];
  if (measure(p) <= maxW) return [p];
  const tokens = p.match(/[ᄀ-ᇿ　-鿿가-힯＀-￯]|[^\sᄀ-ᇿ　-鿿가-힯＀-￯]+\s*|\s+/g) || [p];
  const lines = []; let cur = '';
  for (const tk of tokens) {
    if (cur && measure(cur + tk.trimEnd()) > maxW) { lines.push(cur.trimEnd()); cur = tk.trimStart(); }
    else cur += tk;
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}

// ---------- entity property extraction (for the side panel) ----------
export function entityProps(rec, drawing) {
  const e = rec.raw, f = v => (typeof v === 'number' ? fmt(v) : v);
  const pt = p => p ? `${fmt(num(p.x))}, ${fmt(num(p.y))}` : '-';
  const deg = r => fmt(num(r) * 180 / Math.PI) + '°';
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  switch (e.type) {
    case 'LINE': {
      const a = e.startPoint, b = e.endPoint, dx = num(b.x) - num(a.x), dy = num(b.y) - num(a.y);
      add('시작점', pt(a)); add('끝점', pt(b)); add('길이', f(Math.hypot(dx, dy))); add('각도', fmt(Math.atan2(dy, dx) * 180 / Math.PI) + '°'); add('ΔX / ΔY', `${fmt(dx)} / ${fmt(dy)}`); break;
    }
    case 'CIRCLE': { const r = num(e.radius); add('중심', pt(e.center)); add('반지름', f(r)); add('지름', f(r * 2)); add('둘레', f(2 * Math.PI * r)); add('면적', f(Math.PI * r * r)); break; }
    case 'ARC': { const r = num(e.radius); let sw = num(e.endAngle) - num(e.startAngle); while (sw <= 0) sw += 2 * Math.PI; add('중심', pt(e.center)); add('반지름', f(r)); add('시작 각도', deg(e.startAngle)); add('끝 각도', deg(e.endAngle)); add('호 길이', f(r * sw)); break; }
    case 'ELLIPSE': { const m = e.majorAxisEndPoint, R = Math.hypot(num(m.x), num(m.y)); add('중심', pt(e.center)); add('장반경', f(R)); add('단반경', f(R * num(e.axisRatio, 1))); break; }
    case 'LWPOLYLINE': case 'POLYLINE2D': case 'POLYLINE3D': {
      const closed = !!(num(e.flag) & 1); const pts = vertsWithBulge((e.vertices || []).filter(v => !(num(v.flag) & 16)), closed, 1e-4);
      let L = 0, A = 0; for (let i = 0; i + 3 < pts.length; i += 2) { L += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]); A += pts[i] * pts[i + 3] - pts[i + 2] * pts[i + 1]; }
      add('정점 수', (e.vertices || []).length); add('닫힘', closed ? '예' : '아니요'); add('길이', f(L)); if (closed) add('면적', f(Math.abs(A) / 2));
      if (num(e.constantWidth)) add('전역 폭', f(e.constantWidth)); break;
    }
    case 'TEXT': case 'ATTRIB': case 'ATTDEF': add('내용', decodePercent(String(e.text ?? ''))); add('높이', f(num(e.textHeight))); add('회전', deg(e.rotation)); add('삽입점', pt(e.startPoint)); add('문자 스타일', e.styleName || '-'); break;
    case 'MTEXT': add('내용', mtextPlain(e.text)); add('높이', f(num(e.textHeight))); add('삽입점', pt(e.insertionPoint)); add('문자 스타일', e.styleName || '-'); break;
    case 'INSERT': {
      add('블록 이름', e.name); add('삽입점', pt(e.insertionPoint)); add('축척 X / Y', `${fmt(num(e.xScale, 1))} / ${fmt(num(e.yScale, num(e.xScale, 1)))}`); add('회전', deg(e.rotation));
      const b = drawing.blocks.get(e.name); if (b) add('블록 내 객체', b.entities.length + '개');
      for (const a of e.attribs || []) { const te = a.text && typeof a.text === 'object' ? { ...a, ...a.text } : a; add('속성 ' + (te.tag || ''), decodePercent(String(te.text ?? ''))); }
      break;
    }
    case 'DIMENSION': add('치수 값', f(num(e.measurement))); if (e.text && e.text !== '<>') add('문자 재지정', mtextPlain(e.text)); add('치수 스타일', e.styleName || '-'); add('문자 위치', pt(e.textPoint)); break;
    case 'HATCH': add('패턴', e.patternName || '-'); add('축척', f(num(e.patternScale, 1))); add('경계 수', (e.boundaryPaths || []).length); break;
    case 'SPLINE': add('차수', num(e.degree)); add('조정점', (e.controlPoints || []).length); add('맞춤점', (e.fitPoints || []).length); break;
    case 'LEADER': add('정점 수', (e.vertices || []).length); break;
    case 'TOLERANCE': add('내용', mtextPlain(String(e.text || '').replace(/%%v/g, ' | '))); break;
    case 'POINT': add('위치', pt(e.position)); break;
  }
  return rows;
}
export function fmt(v) {
  if (!isFinite(v)) return '-';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 3 : 4;
  return (+v.toFixed(d)).toLocaleString('ko-KR', { maximumFractionDigits: d });
}
