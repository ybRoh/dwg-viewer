// SPDX-License-Identifier: GPL-3.0-or-later
// 도면 뷰어 - Copyright (C) 2026 아라곤
// This program is free software under the GNU GPL v3 or later. See LICENSE.
import { LibreDwg, Dwg_File_Type } from '../node_modules/@mlightcad/libredwg-web/dist/libredwg-web.js';
import createModule from '../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.js';
import { DxfParser } from '@mlightcad/dxf-json';
import { normalizeDwg, normalizeDxf, buildDrawing, entityProps, versionName, unitName, fmt, TYPE_KO } from './scene.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, INTERSECTION } from 'three-bvh-csg';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem('dwgv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('dwgv.' + k, JSON.stringify(v)); } catch { } } };
const IS_LOCAL = location.protocol === 'file:';
// ---- release info (edit these two lines before distributing) ----
const APP_VERSION = '1.0.0';
const AUTHOR = '아라곤';
const SOURCE_NOTE = '소스 코드는 이 파일과 함께 배포되는 "도면뷰어_소스" 압축 파일에 들어 있습니다. 받지 못했다면 배포한 곳에 요청하세요.';

const DRAW_FONT = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Noto Sans KR","IBM Plex Sans KR",sans-serif';
const EM = 1.32; // canvas em per AutoCAD text height

// ---------- state ----------
const S = {
  drawing: null, file: null, space: null, spaceIdx: 0, spaces: [],
  view: { s: 1, cx: 0, cy: 0 }, mode: 'select', snapOn: store.get('snap', true),
  bgDark: store.get('bgDark', true), mono: store.get('mono', false),
  showDash: store.get('dash', true), showText: store.get('text', true), snapKinds: store.get('snapKinds', [1, 1, 1, 1, 1]), extS: 1,
  sel: new Set(), measures: [], pending: [], hover: null, snapPt: null, cursor: null, flash: null,
  visLp: null, ptrs: new Map(), drag: null, zoomRect: null,
};

const canvas = $('#cv'), ctx = canvas.getContext('2d');
const mctx = document.createElement('canvas').getContext('2d');
mctx.font = `100px ${DRAW_FONT}`;
const mcache = new Map();
const measure = (s) => { let v = mcache.get(s); if (v == null) { v = mctx.measureText(s).width / 100 * EM; if (mcache.size > 50000) mcache.clear(); mcache.set(s, v); } return v; };

// ---------- WASM loading ----------
// LibreDWG keeps global state that breaks a second read in the same instance,
// so the module is compiled once and every file gets a fresh instance.
let wasmModPromise = null, spare = null;
function getWasmModule() {
  if (!wasmModPromise) wasmModPromise = (async () => {
    const b64 = $('#wasm-gz').textContent.trim();
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  })().catch(e => { wasmModPromise = null; throw e; });
  return wasmModPromise;
}
async function createLib() {
  const wasmBinary = await getWasmModule();
  const inst = await createModule({ wasmBinary, print: () => { }, printErr: () => { } });
  return LibreDwg.createByWasmInstance(inst);
}
function getLib() {
  const p = spare || createLib();
  spare = null;
  return p;
}
function prepareSpare() { if (!spare) { spare = createLib(); spare.catch(() => { spare = null; }); } return spare; }

// ---------- open ----------
async function openFile(file) {
  const buf = await file.arrayBuffer();
  await openBuffer(buf, file.name, file.size);
}
async function openBuffer(buf, name, size) {
  const ext = name.toLowerCase().split('.').pop();
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(6, buf.byteLength)));
  const isDwg = /^AC\d{4}$/.test(head) || ext === 'dwg';
  showLoading(isDwg ? 'DWG 해석 엔진을 준비하는 중' : 'DXF 파일을 읽는 중');
  await tick();
  const t0 = performance.now();
  try {
    let src, version = head;
    if (isDwg) {
      if (!/^AC\d{4}$/.test(head)) throw new Error('DWG 파일 형식이 아닙니다. 파일이 손상되었거나 다른 형식입니다.');
      if (head < 'AC1012') throw new Error(`${versionName(head)} 형식의 아주 오래된 DWG는 지원하지 않습니다.`);
      const lib = await getLib();
      setLoading('도면 데이터를 해석하는 중');
      await tick();
      let db;
      try {
        const dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
        if (!dwg) throw new Error('empty');
        db = lib.convert(dwg);
      } catch (err) {
        throw new Error('이 DWG 파일을 해석하지 못했습니다. 최신 버전이거나 특수 객체가 포함된 경우 발생할 수 있습니다.', { cause: err });
      }
      src = normalizeDwg(db);
      S.engine = 'ok';
      setTimeout(prepareSpare, 300);
    } else {
      const u8 = new Uint8Array(buf);
      let txt;
      try { txt = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { txt = new TextDecoder('euc-kr').decode(u8); }
      if (!/^\s*0\s*\r?\n\s*SECTION/i.test(txt.slice(0, 200))) throw new Error('DXF(텍스트) 파일이 아닙니다. 바이너리 DXF는 지원하지 않습니다.');
      const r = new DxfParser().parseSync(txt);
      src = normalizeDxf(r);
      version = src.header.ACADVER || '';
    }
    const t1 = performance.now();
    setLoading('화면에 그리는 중');
    await tick();
    const d = buildDrawing(src, { measure, fileType: isDwg ? 'dwg' : 'dxf' });
    d.meta = { name, size, version, isDwg, parseMs: Math.round(t1 - t0), buildMs: d.buildMs };
    if (!d.model.ents.length && !d.layouts.some(l => l.ents.length)) throw new Error('도면에 표시할 객체가 없습니다.');
    setDrawing(d);
    hideLoading();
    toast(`${name} · 객체 ${d.model.ents.length.toLocaleString()}개를 열었습니다`);
  } catch (err) {
    console.error(err);
    hideLoading();
    showError(err.message || String(err), isDwg);
  }
}
const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

function setDrawing(d) {
  S.drawing = d;
  S.spaces = [d.model, ...d.layouts];
  S.sel.clear(); S.measures = []; S.pending = []; S.flash = null;
  computeVis();
  for (const sp of S.spaces) sp._paths = null;
  buildTabs();
  setSpace(0);
  renderLayers(); renderBlocks(); renderTexts(); renderInfo(); renderProps();
  $('#welcome').hidden = true;
  $('#filename').textContent = d.meta.name;
  $('#filename').title = d.meta.name;
  document.title = d.meta.name + ' · 도면 뷰어';
}

function closeDrawing() {
  if (!S.drawing) return;
  S.drawing = null; S.space = null; S.spaces = []; S.sel.clear(); S.measures = []; S.pending = [];
  $('#welcome').hidden = false; $('#spaceEmpty').hidden = true;
  $('#filename').textContent = '도면 뷰어'; document.title = '도면 뷰어'; $('#tabs').innerHTML = '';
  $('#layerList').innerHTML = '<li class="none">도면을 열면 레이어 목록이 여기에 표시됩니다.</li>'; $('#layerCount').textContent = '';
  $('#blkList').innerHTML = '<li class="none">도면을 열면 블록 이름별 개수가 여기에 표시됩니다.</li>'; $('#blkSummary').textContent = '';
  $('#txtList').innerHTML = '<li class="none">도면을 열면 문자를 검색할 수 있습니다.</li>'; $('#txtSummary').textContent = '';
  $('#cx').textContent = '0'; $('#cy').textContent = '0'; $('#zoomPct').textContent = '100%';
  updateMeasureList(); renderInfo(); renderProps(); redraw();
}
function setSpace(i) {
  S.spaceIdx = i; S.space = S.spaces[i];
  S.sel.clear(); S.pending = []; renderProps();
  $$('#tabs button').forEach((b, k) => b.setAttribute('aria-selected', k === i));
  zoomExtents();
  renderBlocks(); renderTexts();
  const empty = !S.space.ents.length;
  $('#spaceEmpty').hidden = !empty;
}

function computeVis() {
  const d = S.drawing; if (!d) return;
  S.visLp = new Uint8Array(d.lpList.length);
  d.lpList.forEach(([a, b], i) => { S.visLp[i] = (d.layers.get(a)?.on !== false && d.layers.get(b)?.on !== false) ? 1 : 0; });
}

// ---------- view ----------
let W = 0, H = 0, dpr = 1;
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  redraw();
}
const toWorld = (sx, sy) => [(sx - W / 2) / S.view.s + S.view.cx, (H / 2 - sy) / S.view.s + S.view.cy];
const toScreen = (x, y) => [(x - S.view.cx) * S.view.s + W / 2, H / 2 - (y - S.view.cy) * S.view.s];
function zoomBox(b, margin = 0.06) {
  if (!b || !(b[2] >= b[0])) return;
  const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
  S.view.s = Math.min(W / (w * (1 + margin * 2)), H / (h * (1 + margin * 2))) || 1;
  S.view.cx = (b[0] + b[2]) / 2; S.view.cy = (b[1] + b[3]) / 2;
  redraw();
}
function zoomExtents() {
  const sp = S.space; if (!sp) return;
  let b = sp.viewBBox || sp.bbox;
  if (!(b[2] >= b[0])) b = [-100, -100, 100, 100];
  zoomBox(b); S.extS = S.view.s;
}
function zoomAt(sx, sy, f) {
  const [wx, wy] = toWorld(sx, sy);
  S.view.s = Math.min(Math.max(S.view.s * f, 1e-9), 1e9);
  S.view.cx = wx - (sx - W / 2) / S.view.s; S.view.cy = wy - (H / 2 - sy) / S.view.s;
  redraw();
}

// ---------- rendering ----------
let raf = 0;
function redraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
const colors = () => {
  const cs = getComputedStyle(document.documentElement);
  return { sel: cs.getPropertyValue('--sel').trim() || '#3d9bff', meas: cs.getPropertyValue('--meas').trim() || '#ffb020' };
};
let C = null;
function col(c) {
  const fg = S.bgDark ? '#ffffff' : '#000000';
  if (c === '@fg' || S.mono) return fg;
  if (!S.bgDark && /^#(ffff00|ffffff)$/i.test(c)) return c.toLowerCase() === '#ffffff' ? fg : '#b8a000';
  return c;
}

function ensurePaths(sp) {
  if (sp._paths) return sp._paths;
  const batches = [];
  for (const bt of sp.batches.values()) {
    const p = new Path2D(); const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const w of bt.polys) {
      p.moveTo(w[0], w[1]);
      for (let i = 2; i < w.length; i += 2) p.lineTo(w[i], w[i + 1]);
      for (let i = 0; i < w.length; i += 2) { if (w[i] < bb[0]) bb[0] = w[i]; if (w[i] > bb[2]) bb[2] = w[i]; if (w[i + 1] < bb[1]) bb[1] = w[i + 1]; if (w[i + 1] > bb[3]) bb[3] = w[i + 1]; }
    }
    batches.push({ path: p, bb, color: bt.color, dash: S.drawing.ltypes.get(bt.dash), lp: bt.lp });
  }
  const fills = sp.fills.map(f => {
    const p = new Path2D();
    for (const r of f.rings) { p.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]); p.closePath(); }
    return { path: p, color: f.color, lp: f.lp };
  });
  for (const t of sp.texts) t.rad = Math.max(Math.abs(t.local[0]), Math.abs(t.local[2])) + Math.max(Math.abs(t.local[1]), Math.abs(t.local[3]));
  sp._paths = { batches, fills };
  return sp._paths;
}

function render() {
  if (!C) C = colors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = S.bgDark ? '#1d232b' : '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const sp = S.space; if (!sp) return;
  const xf = { s: S.view.s, e: W / 2 - S.view.cx * S.view.s, f: H / 2 + S.view.cy * S.view.s };
  const vw = [S.view.cx - W / 2 / S.view.s, S.view.cy - H / 2 / S.view.s, S.view.cx + W / 2 / S.view.s, S.view.cy + H / 2 / S.view.s];
  if (sp.isPaper) {
    for (const vp of sp.viewports) {
      if (!(vp.vh > 0)) continue;
      const k = vp.h / vp.vh, m = S.drawing.model;
      const px = vp.c[0], py = vp.c[1];
      const xf2 = { s: xf.s * k, e: xf.e + xf.s * (px + k * (m.origin[0] - vp.vc[0])), f: xf.f - xf.s * (py + k * (m.origin[1] - vp.vc[1])) };
      const [sx0, sy0] = [xf.s * (px - vp.w / 2) + xf.e, -xf.s * (py + vp.h / 2) + xf.f];
      ctx.save(); ctx.beginPath(); ctx.rect(sx0, sy0, vp.w * xf.s, vp.h * xf.s); ctx.clip();
      const iv = [(-xf2.e) / xf2.s, (xf2.f - H) / xf2.s, (W - xf2.e) / xf2.s, xf2.f / xf2.s];
      drawSpace(m, xf2, iv);
      ctx.restore();
    }
  }
  drawSpace(sp, xf, vw);
  drawOverlay(sp);
  const zp = S.view.s / (S.extS || 1) * 100; $('#zoomPct').textContent = (zp >= 10 ? Math.round(zp).toLocaleString() : zp.toFixed(1)) + '%';
}

function drawSpace(sp, xf, vw) {
  const P = ensurePaths(sp), vis = S.visLp, s = xf.s;
  const inView = b => !(b[2] < vw[0] || b[0] > vw[2] || b[3] < vw[1] || b[1] > vw[3]);
  ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * xf.e, dpr * xf.f);
  for (const f of P.fills) { if (!vis[f.lp]) continue; ctx.fillStyle = col(f.color); ctx.fill(f.path, 'evenodd'); }
  ctx.lineWidth = 1 / s; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const b of P.batches) {
    if (!vis[b.lp] || !inView(b.bb)) continue;
    ctx.strokeStyle = col(b.color);
    if (S.showDash && b.dash && b.dash.period * s >= 5) ctx.setLineDash(b.dash.arr); else ctx.setLineDash([]);
    ctx.stroke(b.path);
  }
  ctx.setLineDash([]);
  // points
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const p of sp.points) {
    if (!vis[p.lp]) continue;
    const x = p.x * s + xf.e, y = -p.y * s + xf.f; if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
    ctx.fillStyle = col(p.color); ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }
  // texts
  ctx.textBaseline = 'alphabetic';
  let curFont = '';
  for (const t of (S.showText ? sp.texts : [])) {
    if (!vis[t.lp]) continue;
    if (t.x + t.rad < vw[0] || t.x - t.rad > vw[2] || t.y + t.rad < vw[1] || t.y - t.rad > vw[3]) continue;
    const px = t.h * s;
    if (px < 1.2) continue;
    const sx = t.x * s + xf.e, sy = -t.y * s + xf.f;
    ctx.setTransform(dpr, 0, 0, dpr, dpr * sx, dpr * sy);
    if (t.rot) ctx.rotate(-t.rot);
    if (t.ob) ctx.transform(1, 0, -Math.tan(t.ob), 1, 0, 0);
    ctx.fillStyle = col(t.color);
    if (px < 3.2) {
      ctx.globalAlpha = 0.45;
      for (let i = 0; i < t.lines.length; i++) {
        const w = t.lw[i] * s, x0 = t.halign === 'center' ? -w / 2 : t.halign === 'right' ? -w : 0, y = -(t.base0 - i * t.gap) * s;
        ctx.fillRect(x0, y - px, w, px);
      }
      ctx.globalAlpha = 1; continue;
    }
    ctx.scale(t.wf, 1);
    const f = `${(px * EM).toFixed(2)}px ${DRAW_FONT}`;
    if (f !== curFont) { ctx.font = f; curFont = f; }
    ctx.textAlign = t.halign;
    for (let i = 0; i < t.lines.length; i++) ctx.fillText(t.lines[i], 0, -(t.base0 - i * t.gap) * s);
  }
  ctx.textAlign = 'left';
}

function drawOverlay(sp) {
  const s = S.view.s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // selection highlight
  if (S.sel.size) {
    if (!S.selPath || S.selPathFor !== S.selKey) buildSelPath(sp);
    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (W / 2 - S.view.cx * s), dpr * (H / 2 + S.view.cy * s));
    ctx.lineWidth = 5 / s; ctx.strokeStyle = C.sel; ctx.globalAlpha = 0.28; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke(S.selPath);
    ctx.globalAlpha = 1; ctx.lineWidth = 1.6 / s; ctx.stroke(S.selPath);
    ctx.restore();
  }
  // hover
  if (S.hover != null && !S.sel.has(S.hover) && S.mode === 'select' && !S.drag) {
    const p = entPath(sp, S.hover);
    ctx.save(); ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (W / 2 - S.view.cx * s), dpr * (H / 2 + S.view.cy * s));
    ctx.lineWidth = 3 / s; ctx.strokeStyle = C.sel; ctx.globalAlpha = 0.5; ctx.stroke(p); ctx.restore();
  }
  // flash box (search result)
  if (S.flash) {
    const [x0, y0] = toScreen(S.flash[0], S.flash[3]), [x1, y1] = toScreen(S.flash[2], S.flash[1]);
    ctx.strokeStyle = C.meas; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12); ctx.setLineDash([]);
  }
  // measurements
  ctx.font = '600 12px "IBM Plex Mono",ui-monospace,monospace';
  const all = [...S.measures];
  const live = S.cursor && (S.mode === 'dist' || S.mode === 'area') && S.pending.length ? [...S.pending, S.cursor] : null;
  if (live) all.push({ type: S.mode, pts: live, live: true });
  for (const m of all) drawMeasure(m);
  // snap marker
  if (S.snapPt && isMeasure()) {
    const [x, y] = toScreen(S.snapPt.x, S.snapPt.y);
    ctx.strokeStyle = C.meas; ctx.lineWidth = 2; ctx.beginPath();
    const k = S.snapPt.kind, r = 6;
    if (k === 0) ctx.rect(x - r, y - r, r * 2, r * 2);
    else if (k === 1) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); }
    else if (k === 2) ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (k === 3) { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
    else { ctx.rect(x - r, y - r, r * 2, r * 2); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
    ctx.stroke();
    ctx.fillStyle = C.meas; ctx.font = '600 11px "IBM Plex Sans KR",sans-serif';
    ctx.fillText(['끝점', '중간점', '중심', '사분점·노드', '삽입점'][k], x + 10, y - 8);
  }
  // zoom window
  if (S.zoomRect) {
    const [a, b] = S.zoomRect;
    ctx.fillStyle = C.sel; ctx.globalAlpha = 0.12; ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.globalAlpha = 1; ctx.strokeStyle = C.sel; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); ctx.setLineDash([]);
  }
  // selection box (window/crossing)
  if (S.boxRect) {
    const [a, b] = S.boxRect, crossing = b[0] < a[0], c = crossing ? '#2ecc71' : '#3b82f6';
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    ctx.fillStyle = c; ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1; ctx.strokeStyle = c; ctx.lineWidth = 1; if (crossing) ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  }
}

function label(text, x, y) {
  ctx.font = '600 12px "IBM Plex Mono",ui-monospace,monospace';
  const lines = text.split('\n');
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 14, h = lines.length * 16 + 8;
  const bx = Math.min(Math.max(x + 10, 4), W - w - 4), by = Math.min(Math.max(y - h - 10, 4), H - h - 4);
  ctx.fillStyle = S.bgDark ? 'rgba(20,24,30,.92)' : 'rgba(255,255,255,.94)';
  ctx.strokeStyle = C.meas; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = S.bgDark ? '#ffe2a8' : '#7a4a00';
  lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 18 + i * 16));
}
function drawMeasure(m) {
  const pts = m.pts.map(p => toScreen(p.x, p.y));
  if (!pts.length) return;
  ctx.strokeStyle = C.meas; ctx.fillStyle = C.meas; ctx.lineWidth = 1.6;
  ctx.setLineDash(m.live ? [6, 4] : []);
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  if (m.type === 'area' && pts.length > 2) {
    ctx.closePath(); ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.stroke(); ctx.setLineDash([]);
  for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill(); }
  const u = S.drawing ? unitShort() : '';
  if (m.type === 'point') {
    const o = S.space.origin, p = m.pts[0];
    ctx.beginPath(); ctx.moveTo(pts[0][0] - 7, pts[0][1]); ctx.lineTo(pts[0][0] + 7, pts[0][1]); ctx.moveTo(pts[0][0], pts[0][1] - 7); ctx.lineTo(pts[0][0], pts[0][1] + 7); ctx.stroke();
    label(`X ${fmt(p.x + o[0])}\nY ${fmt(p.y + o[1])}`, pts[0][0], pts[0][1]);
  } else if (m.type === 'dist' && m.pts.length >= 2) {
    const a = m.pts[0], b = m.pts[1], dx = b.x - a.x, dy = b.y - a.y;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    label(`거리 ${fmt(Math.hypot(dx, dy))}${u}\nΔX ${fmt(dx)}  ΔY ${fmt(dy)}\n각도 ${fmt((ang + 360) % 360)}°`, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  } else if (m.type === 'area' && m.pts.length >= 3) {
    const { A, L } = polyAreaLen(m.pts);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    label(`면적 ${fmt(A)}${u ? u + '²' : ''}\n둘레 ${fmt(L)}${u}`, cx, cy);
  }
}
const polyAreaLen = (p) => { let A = 0, L = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; A += a.x * b.y - b.x * a.y; L += Math.hypot(b.x - a.x, b.y - a.y); } return { A: Math.abs(A) / 2, L }; };
const unitShort = () => ({ 1: ' in', 2: ' ft', 4: ' mm', 5: ' cm', 6: ' m' }[S.drawing.header.INSUNITS] || '');

function entPath(sp, id) {
  const p = new Path2D(), sg = sp.segs, se = sp.segEnt;
  for (let i = 0; i < se.length; i++) if (se[i] === id) { p.moveTo(sg[i * 4], sg[i * 4 + 1]); p.lineTo(sg[i * 4 + 2], sg[i * 4 + 3]); }
  for (const t of sp.texts) if (t.ent === id) textRect(p, t);
  for (const f of sp.fills) if (f.ent === id) for (const r of f.rings) { p.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]); p.closePath(); }
  return p;
}
function textRect(p, t) {
  const c = Math.cos(t.rot), s = Math.sin(t.rot), L = t.local;
  const q = [[L[0], L[1]], [L[2], L[1]], [L[2], L[3]], [L[0], L[3]]].map(([x, y]) => [t.x + x * c - y * s, t.y + x * s + y * c]);
  p.moveTo(q[0][0], q[0][1]); for (const v of q.slice(1)) p.lineTo(v[0], v[1]); p.closePath();
}
function buildSelPath(sp) {
  const p = new Path2D(), sg = sp.segs, se = sp.segEnt, set = S.sel;
  for (let i = 0; i < se.length; i++) if (set.has(se[i])) { p.moveTo(sg[i * 4], sg[i * 4 + 1]); p.lineTo(sg[i * 4 + 2], sg[i * 4 + 3]); }
  for (const t of sp.texts) if (set.has(t.ent)) textRect(p, t);
  for (const f of sp.fills) if (set.has(f.ent)) for (const r of f.rings) { p.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]); p.closePath(); }
  S.selPath = p; S.selPathFor = S.selKey;
}
function setSel(ids) { S.sel = new Set(ids); S.selKey = Math.random(); S.selPath = null; renderProps(); redraw(); }

// ---------- picking & snapping ----------
function pick(sx, sy) {
  const sp = S.space; if (!sp) return null;
  const [wx, wy] = toWorld(sx, sy), tol = 6 / S.view.s, vis = S.visLp;
  let best = null, bd = tol * tol;
  const sg = sp.segs, n = sp.segEnt.length;
  for (let i = 0; i < n; i++) {
    if (!vis[sp.segLp[i]]) continue;
    const x1 = sg[i * 4], y1 = sg[i * 4 + 1], x2 = sg[i * 4 + 2], y2 = sg[i * 4 + 3];
    if ((wx < x1 - tol && wx < x2 - tol) || (wx > x1 + tol && wx > x2 + tol) || (wy < y1 - tol && wy < y2 - tol) || (wy > y1 + tol && wy > y2 + tol)) continue;
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((wx - x1) * dx + (wy - y1) * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x1 + dx * t - wx, ey = y1 + dy * t - wy, d = ex * ex + ey * ey;
    if (d < bd) { bd = d; best = sp.segEnt[i]; }
  }
  if (best != null) return best;
  for (let k = sp.texts.length - 1; k >= 0; k--) {
    const t = sp.texts[k]; if (!vis[t.lp]) continue;
    const c = Math.cos(-t.rot), s = Math.sin(-t.rot), lx = (wx - t.x) * c - (wy - t.y) * s, ly = (wx - t.x) * s + (wy - t.y) * c;
    if (lx >= t.local[0] - tol && lx <= t.local[2] + tol && ly >= t.local[1] - tol && ly <= t.local[3] + tol) return t.ent;
  }
  for (let k = sp.fills.length - 1; k >= 0; k--) {
    const f = sp.fills[k]; if (!vis[f.lp]) continue;
    let inside = false;
    for (const r of f.rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if ((r[i + 1] > wy) !== (r[j + 1] > wy) && wx < (r[j] - r[i]) * (wy - r[i + 1]) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
    }
    if (inside) return f.ent;
  }
  return null;
}
function boxSelect(x0, y0, x1, y1) {
  const sp = S.space; if (!sp) return [];
  const [a0, a1] = toWorld(x0, y0), [b0, b1] = toWorld(x1, y1), vis = S.visLp;
  const minX = Math.min(a0, b0), maxX = Math.max(a0, b0), minY = Math.min(a1, b1), maxY = Math.max(a1, b1);
  const crossing = x1 < x0; // AutoCAD convention: drag right-to-left touches, left-to-right must fully enclose
  const sg = sp.segs, se = sp.segEnt, slp = sp.segLp, bb = new Map();
  for (let i = 0; i < se.length; i++) {
    if (!vis[slp[i]]) continue;
    const ent = se[i], x1s = sg[i * 4], y1s = sg[i * 4 + 1], x2s = sg[i * 4 + 2], y2s = sg[i * 4 + 3];
    const lo = Math.min(x1s, x2s), hi = Math.max(x1s, x2s), lo2 = Math.min(y1s, y2s), hi2 = Math.max(y1s, y2s);
    let b = bb.get(ent);
    if (!b) bb.set(ent, [lo, lo2, hi, hi2]);
    else { if (lo < b[0]) b[0] = lo; if (lo2 < b[1]) b[1] = lo2; if (hi > b[2]) b[2] = hi; if (hi2 > b[3]) b[3] = hi2; }
  }
  const ids = [];
  for (const [ent, b] of bb) {
    const hit = crossing ? (b[0] <= maxX && b[2] >= minX && b[1] <= maxY && b[3] >= minY)
      : (b[0] >= minX && b[2] <= maxX && b[1] >= minY && b[3] <= maxY);
    if (hit) ids.push(ent);
  }
  return ids;
}
const SNAP_BIAS = [0, 3, 1, 4, 5];
function findSnap(sx, sy) {
  const sp = S.space; if (!sp || !S.snapOn) return null;
  const sn = sp.snaps, vis = S.visLp, s = S.view.s;
  const [wx, wy] = toWorld(sx, sy), R = 12 / s;
  let best = null, bs = 1e9;
  for (let i = 0; i < sn.length; i += 4) {
    const x = sn[i], y = sn[i + 1];
    if (x < wx - R || x > wx + R || y < wy - R || y > wy + R || !vis[sn[i + 3]] || !S.snapKinds[sn[i + 2]]) continue;
    const d = Math.hypot(x - wx, y - wy) * s + SNAP_BIAS[sn[i + 2]];
    if (d < bs) { bs = d; best = { x, y, kind: sn[i + 2] }; }
  }
  return best;
}

const isMeasure = () => S.mode === 'dist' || S.mode === 'area' || S.mode === 'point';
// ---------- input ----------
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0016));
}, { passive: false });
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  S.ptrs.set(e.pointerId, { x, y });
  if (S.ptrs.size === 2) { const [a, b] = [...S.ptrs.values()]; S.drag = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y), s0: S.view.s, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], c0: [S.view.cx, S.view.cy] }; return; }
  S.drag = { x0: x, y0: y, cx: S.view.cx, cy: S.view.cy, btn: e.button, moved: false, pan: e.button === 1 || e.button === 2 || S.mode === 'pan' || (e.pointerType === 'touch' && !['dist', 'area'].includes(S.mode)) };
  if (S.mode === 'zoomwin' && e.button === 0) S.drag.zoom = true;
  if (S.mode === 'select' && e.button === 0 && e.pointerType !== 'touch') S.drag.box = true;
});
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (S.ptrs.has(e.pointerId)) S.ptrs.set(e.pointerId, { x, y });
  const d = S.drag;
  if (d && d.pinch && S.ptrs.size === 2) {
    const [a, b] = [...S.ptrs.values()], dist = Math.hypot(a.x - b.x, a.y - b.y), mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    S.view.s = d.s0 * dist / (d.d0 || 1);
    const wx = (d.mid[0] - W / 2) / d.s0 + d.c0[0], wy = (H / 2 - d.mid[1]) / d.s0 + d.c0[1];
    S.view.cx = wx - (mid[0] - W / 2) / S.view.s; S.view.cy = wy - (H / 2 - mid[1]) / S.view.s;
    redraw(); return;
  }
  const [wx, wy] = toWorld(x, y);
  updateCoords(wx, wy);
  if (d && !d.pinch) {
    if (Math.hypot(x - d.x0, y - d.y0) > 4) d.moved = true;
    if (d.zoom) { S.zoomRect = [[d.x0, d.y0], [x, y]]; redraw(); return; }
    if (d.box) { S.boxRect = [[d.x0, d.y0], [x, y]]; redraw(); return; }
    if (d.moved && d.pan) {
      d.panning = true;
      S.view.cx = d.cx - (x - d.x0) / S.view.s; S.view.cy = d.cy + (y - d.y0) / S.view.s;
      canvas.style.cursor = 'grabbing'; redraw(); return;
    }
  }
  if (isMeasure()) {
    S.snapPt = findSnap(x, y);
    S.cursor = S.snapPt ? { x: S.snapPt.x, y: S.snapPt.y } : { x: wx, y: wy };
    redraw();
  } else if (S.mode === 'select' && e.pointerType === 'mouse') {
    const h = pick(x, y); if (h !== S.hover) { S.hover = h; canvas.style.cursor = h != null ? 'pointer' : ''; redraw(); }
  }
});
canvas.addEventListener('pointerup', e => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  S.ptrs.delete(e.pointerId);
  const d = S.drag; S.drag = null; canvas.style.cursor = '';
  if (!d) return;
  if (d.pinch) { if (S.ptrs.size) S.drag = null; return; }
  if (d.zoom) {
    S.zoomRect = null;
    if (d.moved) { const [a0, a1] = toWorld(d.x0, d.y0), [b0, b1] = toWorld(x, y); zoomBox([Math.min(a0, b0), Math.min(a1, b1), Math.max(a0, b0), Math.max(a1, b1)], 0); setMode('select'); }
    redraw(); return;
  }
  if (d.box) {
    S.boxRect = null;
    if (d.moved) {
      const ids = boxSelect(d.x0, d.y0, x, y);
      if (MV.active) { mvCapture(ids); redraw(); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(S.sel); for (const id of ids) s.add(id); setSel(s); }
      else setSel(ids);
      redraw(); return;
    }
    if (MV.active) return;
  }
  if (d.moved) return;
  if (d.btn === 2) { if (S.mode === 'area' && S.pending.length >= 3) finishArea(); else showCtx(e.clientX, e.clientY); return; }
  if (d.btn !== 0) return;
  if (S.mode === 'select' || S.mode === 'pan') {
    const id = pick(x, y);
    if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(S.sel); if (id != null) s.has(id) ? s.delete(id) : s.add(id); setSel(s); }
    else setSel(id != null ? [id] : []);
    if (id != null && window.matchMedia('(max-width: 860px)').matches) $('#app').classList.add('props-open');
  } else if (isMeasure()) {
    const sn = findSnap(x, y), [wx, wy] = toWorld(x, y);
    const p = sn ? { x: sn.x, y: sn.y } : { x: wx, y: wy };
    if (S.mode === 'point') { S.measures.push({ type: 'point', pts: [p] }); updateMeasureList(); redraw(); return; }
    S.pending.push(p);
    if (S.mode === 'dist' && S.pending.length === 2) { S.measures.push({ type: 'dist', pts: S.pending }); S.pending = []; updateMeasureList(); }
    redraw();
  }
});
canvas.addEventListener('dblclick', e => {
  if (S.mode === 'area') { S.pending.pop(); finishArea(); return; }
  if (S.mode === 'select' && S.sel.size) { zoomToEnts([...S.sel]); }
});
canvas.addEventListener('auxclick', e => { if (e.button === 1 && e.detail === 2) zoomExtents(); });
canvas.addEventListener('pointerleave', () => { S.hover = null; S.snapPt = null; S.cursor = null; redraw(); });

function finishArea(cancelIfShort) {
  if (S.mode === 'area' && S.pending.length >= 3) { S.measures.push({ type: 'area', pts: S.pending }); updateMeasureList(); }
  else if (S.mode !== 'area' && !cancelIfShort) { }
  S.pending = []; redraw();
}
window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (k === 'escape' && closeMenus()) return;
  if (k === 'escape') { if (S.pending.length) S.pending = []; else if (S.mode !== 'select') setMode('select'); else setSel([]); redraw(); }
  else if (k === 'enter') finishArea();
  else if ((k === 'f' || k === 'e') && !e.ctrlKey && !e.metaKey) zoomExtents();
  else if (k === 'd') setMode('dist');
  else if (k === 'a') setMode('area');
  else if (k === 'w') setMode('zoomwin');
  else if (k === 'p') setMode('pan');
  else if (k === 'i') setMode('point');
  else if (k === 'l') act('panel', 'pLayers');
  else if (k === 'f' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act('panel', 'pTexts'); }
  else if (k === '?') act('keys');
  else if (k === 's' && !e.ctrlKey && !e.metaKey) toggleSnap();
  else if (k === '+' || k === '=') zoomAt(W / 2, H / 2, 1.4);
  else if (k === '-') zoomAt(W / 2, H / 2, 1 / 1.4);
  else if (k === 'o' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#fileInput').click(); }
  else return;
});

function setMode(m) {
  S.mode = m; S.pending = []; S.snapPt = null;
  $$('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m));
  canvas.dataset.mode = m;
  const hints = {
    select: '클릭: 객체 선택 · 드래그: 영역 선택(→크게 감싸기, ←닿으면 선택) · 휠: 확대/축소 · Shift+드래그: 추가 선택 · 가운데/오른쪽 버튼: 화면 이동',
    pan: '드래그해서 화면을 이동합니다',
    zoomwin: '확대할 영역을 드래그하세요',
    dist: '두 점을 클릭하세요 · 끝점·중심·중간점에 자동으로 붙습니다 (S로 스냅 켜기/끄기)',
    area: '꼭짓점을 차례로 클릭하고 더블클릭, Enter, 오른쪽 클릭으로 닫으세요',
    point: '좌표를 확인할 점을 클릭하세요 · 끝점·중심에 자동으로 붙습니다',
  };
  $('#hint').textContent = hints[m];
  redraw();
}
function toggleSnap() { S.snapOn = !S.snapOn; store.set('snap', S.snapOn); syncToggles(); }

function updateCoords(wx, wy) {
  const sp = S.space; if (!sp) return;
  $('#cx').textContent = fmt(wx + sp.origin[0]); $('#cy').textContent = fmt(wy + sp.origin[1]);
}

function zoomToEnts(ids, flash) {
  const sp = S.space, b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) { const r = sp.ents[id]?.bbox; if (!r) continue; b[0] = Math.min(b[0], r[0]); b[1] = Math.min(b[1], r[1]); b[2] = Math.max(b[2], r[2]); b[3] = Math.max(b[3], r[3]); }
  if (!(b[0] <= b[2])) return;
  const w = b[2] - b[0], h = b[3] - b[1], pad = Math.max(w, h) * 0.6 + 1e-3;
  zoomBox([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], 0);
  if (flash) { S.flash = b; clearTimeout(S.flashT); S.flashT = setTimeout(() => { S.flash = null; redraw(); }, 1600); }
}

// ---------- panels ----------
function buildTabs() {
  const el = $('#tabs');
  el.innerHTML = S.spaces.map((sp, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-i="${i}">${esc(sp.name)}${sp.ents.length || i === 0 ? '' : ' <span class="muted">(비어 있음)</span>'}</button>`).join('');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSpace(+b.dataset.i); });

function renderLayers() {
  const d = S.drawing; if (!d) return;
  const q = $('#layerFilter').value.trim().toLowerCase();
  const list = [...d.layers.values()].filter(l => l.count > 0 || l.name === '0').filter(l => !q || l.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  $('#layerCount').textContent = `${list.length}개`;
  $('#layerList').innerHTML = list.map(l => `
    <li class="row${l.on ? '' : ' off'}">
      <button type="button" class="eye" data-layer="${esc(l.name)}" aria-pressed="${l.on}" title="${l.on ? '끄기' : '켜기'}">${l.on ? ICON.eye : ICON.eyeOff}</button>
      <span class="sw" style="--c:${col(l.color)}"></span>
      <span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>
      <span class="lt">${esc(l.lineType === 'Continuous' ? '' : l.lineType)}</span>
      <span class="ct">${l.count.toLocaleString()}</span>
      <button type="button" class="solo" data-solo="${esc(l.name)}" title="이 레이어만 보기">단독</button>
    </li>`).join('');
}
$('#layerList').addEventListener('click', e => {
  const d = S.drawing; if (!d) return;
  const b = e.target.closest('[data-layer]'), so = e.target.closest('[data-solo]');
  if (b) { const l = d.layers.get(b.dataset.layer); l.on = !l.on; }
  else if (so) { for (const l of d.layers.values()) l.on = l.name === so.dataset.solo; }
  else return;
  computeVis(); renderLayers(); redraw();
});
$('#layerFilter').addEventListener('input', renderLayers);
$('#layersAllOn').addEventListener('click', () => { if (!S.drawing) return; for (const l of S.drawing.layers.values()) l.on = true; computeVis(); renderLayers(); redraw(); });
$('#layersAllOff').addEventListener('click', () => { if (!S.drawing) return; for (const l of S.drawing.layers.values()) l.on = l.name === '0'; computeVis(); renderLayers(); redraw(); });

function blockStats() {
  const sp = S.space, nested = $('#blkNested').checked, anon = $('#blkAnon').checked;
  const map = new Map();
  const add = (name, id) => { if (!anon && /^\*|^A\$C[0-9A-F]+$/i.test(name)) return; let r = map.get(name); if (!r) map.set(name, r = { name, count: 0, ids: [] }); r.count++; if (id != null) r.ids.push(id); };
  const walk = (name, id, depth) => {
    add(name, id);
    if (!nested || depth > 10) return;
    const b = S.drawing.blocks.get(name); if (!b) return;
    for (const e of b.entities) if (e.type === 'INSERT') walk(e.name, id, depth + 1);
  };
  for (const r of sp.ents) if (r.type === 'INSERT') walk(r.raw.name, r.id, 0);
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko', { numeric: true }));
}
function renderBlocks() {
  if (!S.drawing) return;
  const q = $('#blkFilter').value.trim().toLowerCase();
  const rows = blockStats().filter(r => !q || r.name.toLowerCase().includes(q));
  const total = rows.reduce((s, r) => s + r.count, 0);
  $('#blkSummary').textContent = `${rows.length}종 · 총 ${total.toLocaleString()}개`;
  $('#blkList').innerHTML = rows.length ? rows.map(r => `<li class="row link" data-blk="${esc(r.name)}"><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="ct strong">${r.count.toLocaleString()}</span></li>`).join('')
    : `<li class="none">${S.space.ents.some(e => e.type === 'INSERT') ? '조건에 맞는 블록이 없습니다' : '이 공간에는 블록 참조가 없습니다'}</li>`;
  S.blkRows = rows;
}
$('#blkList').addEventListener('click', e => {
  const li = e.target.closest('[data-blk]'); if (!li) return;
  const r = S.blkRows.find(x => x.name === li.dataset.blk); if (!r) return;
  const ids = [...new Set(r.ids)]; setSel(ids); zoomToEnts(ids);
  $$('#blkList .row').forEach(x => x.classList.toggle('active', x === li));
});
['#blkNested', '#blkAnon'].forEach(s => $(s).addEventListener('change', renderBlocks));
$('#blkFilter').addEventListener('input', renderBlocks);
$('#blkCopy').addEventListener('click', () => copyTSV([['블록 이름', '수량'], ...(S.blkRows || []).map(r => [r.name, r.count])], '블록 집계표'));
$('#blkCsv').addEventListener('click', () => saveCSV([['블록 이름', '수량'], ...(S.blkRows || []).map(r => [r.name, r.count])], 'blocks'));

function renderTexts() {
  if (!S.drawing) return;
  const q = $('#txtFilter').value.trim().toLowerCase();
  const sp = S.space;
  const seen = new Set(), rows = [];
  for (const t of sp.texts) {
    const s = t.lines.join(' ');
    if (q && !s.toLowerCase().includes(q)) continue;
    const key = t.ent + '|' + s; if (seen.has(key)) continue; seen.add(key);
    rows.push({ s, t });
    if (rows.length >= 400) break;
  }
  S.txtRows = rows;
  $('#txtSummary').textContent = q ? `"${$('#txtFilter').value.trim()}" 검색 결과 ${rows.length >= 400 ? '400개 이상' : rows.length + '개'}` : `문자 ${sp.texts.length.toLocaleString()}개`;
  $('#txtList').innerHTML = rows.length ? rows.map((r, i) => {
    let s = esc(r.s);
    if (q) s = s.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>"]/g, c => esc(c)), 'gi'), m => `<mark>${m}</mark>`);
    return `<li class="row link" data-ti="${i}"><span class="tx">${s}</span><span class="lt">${esc(r.t.layer)}</span></li>`;
  }).join('') : `<li class="none">${q ? '일치하는 문자가 없습니다' : '문자가 없습니다'}</li>`;
}
$('#txtFilter').addEventListener('input', () => { clearTimeout(S.txtT); S.txtT = setTimeout(renderTexts, 120); });
$('#txtList').addEventListener('click', e => {
  const li = e.target.closest('[data-ti]'); if (!li) return;
  const r = S.txtRows[+li.dataset.ti]; if (!r) return;
  setSel([r.t.ent]); zoomToEnts([r.t.ent], true);
  $$('#txtList .row').forEach(x => x.classList.toggle('active', x === li));
});
$('#txtCopy').addEventListener('click', () => copyTSV([['문자', '레이어'], ...(S.txtRows || []).map(r => [r.s, r.t.layer])], '문자 목록'));

function engineLine() {
  return S.engine === 'ok' ? '<span class="okc">준비됨</span>' : S.engine ? '<span class="warnc">사용 불가 · ' + esc(S.engine).slice(0, 120) + '</span>' : '<span class="muted">불러오는 중</span>';
}
function renderInfo() {
  const d = S.drawing;
  if (!d) { $('#infoBody').innerHTML = `<dl class="kv"><dt>도면</dt><dd class="muted">열린 도면 없음</dd><dt>DWG 엔진</dt><dd>${engineLine()}</dd><dt>버전</dt><dd>${APP_VERSION}</dd></dl><p class="pad"><button type="button" class="linkbtn" onclick="document.querySelector('[data-about]').click()">프로그램 정보 · 라이선스</button></p>`; return; }
  const m = d.meta, sp = d.model;
  const b = sp.viewBBox, o = sp.origin;
  const types = Object.entries(d.typeCount).sort((a, b) => b[1] - a[1]);
  const uns = Object.entries(d.unsupported);
  $('#infoBody').innerHTML = `
    <dl class="kv">
      <dt>파일</dt><dd>${esc(m.name)}</dd>
      <dt>크기</dt><dd>${(m.size / 1024).toFixed(1)} KB</dd>
      <dt>형식</dt><dd>${m.isDwg ? 'DWG' : 'DXF'} · ${esc(versionName(m.version))}${m.version ? ` <span class="muted">(${esc(m.version)})</span>` : ''}</dd>
      <dt>도면 단위</dt><dd>${esc(unitName(d.header.INSUNITS))}</dd>
      <dt>도면 범위</dt><dd class="mono">${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])}</dd>
      <dt>범위 좌하단</dt><dd class="mono">${fmt(b[0] + o[0])}, ${fmt(b[1] + o[1])}</dd>
      <dt>레이어</dt><dd>${d.layers.size}개</dd>
      <dt>블록 정의</dt><dd>${[...d.blocks.keys()].filter(n => !n.startsWith('*')).length}개</dd>
      <dt>DWG 엔진</dt><dd>${engineLine()}</dd>
      <dt>처리 시간</dt><dd>해석 ${m.parseMs.toLocaleString()}ms · 변환 ${m.buildMs.toLocaleString()}ms</dd>
    </dl>
    <h3>객체 종류 <span class="muted">(모델+배치 최상위)</span></h3>
    <table class="tbl"><tbody>${types.map(([k, v]) => `<tr><td>${esc(TYPE_KO[k] || k)} <span class="muted">${esc(k)}</span></td><td class="num">${v.toLocaleString()}</td></tr>`).join('')}</tbody></table>
    ${uns.length ? `<h3>표시하지 못한 객체</h3><table class="tbl warn"><tbody>${uns.map(([k, v]) => `<tr><td>${esc(TYPE_KO[k] || k)} <span class="muted">${esc(k)}</span></td><td class="num">${v.toLocaleString()}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">모든 객체를 표시했습니다.</p>'}
  `;
}

function renderProps() {
  const el = $('#propsBody');
  const sp = S.space;
  if (!S.drawing || !sp) { el.innerHTML = '<p class="muted pad">도면을 열면 객체 정보가 여기에 표시됩니다.</p>'; return; }
  const ids = [...S.sel];
  if (!ids.length) {
    el.innerHTML = `<p class="muted pad">도면에서 객체를 클릭하면 레이어, 색상, 좌표, 길이 같은 속성이 표시됩니다.</p>`;
    $('#selCount').textContent = '';
    return;
  }
  $('#selCount').textContent = `${ids.length}개 선택`;
  if (ids.length > 1) {
    const by = {}; for (const id of ids) { const t = sp.ents[id].type; by[t] = (by[t] || 0) + 1; }
    el.innerHTML = `<dl class="kv"><dt>선택</dt><dd>${ids.length.toLocaleString()}개</dd>${Object.entries(by).map(([k, v]) => `<dt>${esc(TYPE_KO[k] || k)}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="pad row-btns"><button type="button" class="btn sm" id="selZoom">선택 객체로 확대</button><button type="button" class="btn sm ghost" id="selDxf">DXF로 내보내기</button><button type="button" class="btn sm ghost" id="sel3d">3D 미리보기</button></div>`;
    $('#selZoom').onclick = () => zoomToEnts(ids);
    $('#selDxf').onclick = exportSelDxf;
    $('#sel3d').onclick = open3DPreview;
    return;
  }
  const r = sp.ents[ids[0]], e = r.raw, d = S.drawing;
  const L = d.layers.get(r.layer);
  const ci = e.colorIndex == null ? 256 : e.colorIndex;
  const colorTxt = typeof e.color === 'number' ? `RGB #${(e.color & 0xffffff).toString(16).padStart(6, '0')}` : ci === 256 ? `ByLayer (${L?.aci ?? 7})` : ci === 0 ? 'ByBlock' : `색상 ${ci}`;
  const rows = entityProps(r, d);
  el.innerHTML = `
    <div class="ptype"><strong>${esc(TYPE_KO[r.type] || r.type)}</strong> <span class="muted mono">${esc(r.type)}</span></div>
    <dl class="kv">
      <dt>레이어</dt><dd><span class="sw" style="--c:${col(L?.color || '@fg')}"></span>${esc(r.layer)}</dd>
      <dt>색상</dt><dd>${esc(colorTxt)}</dd>
      <dt>선종류</dt><dd>${esc(e.lineType || 'ByLayer')}</dd>
      <dt>핸들</dt><dd class="mono">${esc(r.handle || '-')}</dd>
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd${/^[-\d.,\s/°]+$/.test(String(v)) ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('')}
    </dl>
    <div class="pad row-btns"><button type="button" class="btn sm" id="selZoom">이 객체로 확대</button><button type="button" class="btn sm ghost" id="selDxf">DXF로 내보내기</button><button type="button" class="btn sm ghost" id="sel3d">3D 미리보기</button><button type="button" class="btn sm ghost" id="selLayerOff">이 레이어 끄기</button></div>`;
  $('#selZoom').onclick = () => zoomToEnts(ids);
  $('#selDxf').onclick = exportSelDxf;
  $('#sel3d').onclick = open3DPreview;
  $('#selLayerOff').onclick = () => { const l = d.layers.get(r.layer); if (l) { l.on = false; computeVis(); renderLayers(); setSel([]); } };
}

function updateMeasureList() {
  const el = $('#measList');
  const u = S.drawing ? unitShort() : '';
  $('#measPanel').hidden = !S.measures.length;
  el.innerHTML = S.measures.map((m, i) => {
    if (m.type === 'point') { const o = S.space.origin, p = m.pts[0]; return `<li><span class="muted">#${i + 1} 좌표</span> <span class="mono">${fmt(p.x + o[0])}, ${fmt(p.y + o[1])}</span></li>`; }
    if (m.type === 'dist') { const [a, b] = m.pts; return `<li><span class="muted">#${i + 1} 거리</span> <span class="mono">${fmt(Math.hypot(b.x - a.x, b.y - a.y))}${u}</span></li>`; }
    const { A, L } = polyAreaLen(m.pts); return `<li><span class="muted">#${i + 1} 면적</span> <span class="mono">${fmt(A)}${u ? u + '²' : ''}</span> <span class="muted">둘레 ${fmt(L)}</span></li>`;
  }).join('');
}
$('#measClear').addEventListener('click', () => act('meas-clear'));
function measRows() {
  const u = S.drawing ? unitShort().trim() : '', o = S.space?.origin || [0, 0];
  return [['번호', '종류', '값', '단위', '비고'], ...S.measures.map((m, i) => {
    if (m.type === 'point') return [i + 1, '좌표', `${fmt(m.pts[0].x + o[0])}, ${fmt(m.pts[0].y + o[1])}`, u, ''];
    if (m.type === 'dist') { const [a, b] = m.pts; return [i + 1, '거리', fmt(Math.hypot(b.x - a.x, b.y - a.y)), u, `ΔX ${fmt(b.x - a.x)} ΔY ${fmt(b.y - a.y)}`]; }
    const { A, L } = polyAreaLen(m.pts); return [i + 1, '면적', fmt(A), u ? u + '²' : '', `둘레 ${fmt(L)}`];
  })];
}

// ---------- clipboard / files ----------
async function copyTSV(rows, what) {
  const txt = rows.map(r => r.map(c => String(c).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
  try { await navigator.clipboard.writeText(txt); toast(`${what}를 복사했습니다. 엑셀에 붙여넣으세요`); }
  catch { const ta = $('#copyFallback'); ta.hidden = false; ta.value = txt; ta.select(); toast('복사 권한이 없습니다. 선택된 내용을 Ctrl+C로 복사하세요'); setTimeout(() => ta.hidden = true, 15000); }
}
function saveCSV(rows, base) {
  const csv = '\ufeff' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = (S.drawing?.meta.name.replace(/\.\w+$/, '') || 'drawing') + '_' + base + '.csv'; a.click();
}
function exportSelDxf() {
  if (!S.sel.size) { toast('\ub0b4\ubcf4\ub0bc \uac1d\uccb4\ub97c \uba3c\uc800 \uc120\ud0dd\ud558\uc138\uc694'); return; }
  const sp = S.space, sg = sp.segs, se = sp.segEnt, set = S.sel;
  const lines = [];
  for (let i = 0; i < se.length; i++) if (set.has(se[i])) lines.push(sg[i * 4], sg[i * 4 + 1], sg[i * 4 + 2], sg[i * 4 + 3]);
  if (!lines.length) { toast('\uc120\ud0dd\ud55c \uac1d\uccb4\uc5d0\uc11c \uc120 \ub370\uc774\ud130\ub97c \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4 (\ubb38\uc790\u00b7\uce58\uc218 \ub4f1\uc740 \uc9c0\uc6d0\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4)'); return; }
  const f = n => Number(n).toFixed(6);
  let body = '0\nSECTION\n2\nENTITIES\n';
  for (let i = 0; i < lines.length; i += 4) {
    body += `0\nLINE\n8\n0\n10\n${f(lines[i])}\n20\n${f(lines[i + 1])}\n30\n0\n11\n${f(lines[i + 2])}\n21\n${f(lines[i + 3])}\n31\n0\n`;
  }
  body += '0\nENDSEC\n0\nEOF\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/dxf' }));
  a.download = (S.drawing?.meta.name.replace(/\.\w+$/, '') || 'drawing') + '_\uc120\ud0dd\uc601\uc5ed.dxf';
  a.click();
  const copied = copyTextToClipboard(body);
  const base = `\uc120\ud0dd\ud55c ${set.size}\uac1c \uac1d\uccb4(\uc120\ubd84 ${lines.length / 4}\uac1c)\ub97c DXF\ub85c \ub0b4\ubcf4\ub0c8\uc2b5\ub2c8\ub2e4.`;
  if (copied) {
    toast(`${base} DXF \ub0b4\uc6a9\uc774 \ud074\ub9bd\ubcf4\ub4dc\uc5d0\ub3c4 \ubcf5\uc0ac\ub418\uc5c8\uc2b5\ub2c8\ub2e4 \u2014 Claude \ub300\ud654\uc5d0 \ubd99\uc5ec\ub123\uc73c\uc138\uc694 (Ctrl/Cmd+V), \uc790\ub3d9\uc73c\ub85c 3D\ub85c \ub9cc\ub4e4\uc5b4\uc9c4 \ub2e4\uc74c \uc5ec\uae30\uc5d0 \ub2e4\uc2dc \ub098\ud0c0\ub0a9\ub2c8\ub2e4.`);
  } else {
    toast(`${base} 3D \ubcc0\ud658\uc5d0 \uc4f0\ub824\uba74 \uc774 \ud30c\uc77c\uc744 SolidCraft \uc2a4\ucf00\uce58\uc5d0 \uc0bd\uc785\ud558\uc138\uc694 (\ub2e4\uc6b4\ub85c\ub4dc\ub9cc \uc131\uacf5, \ud074\ub9bd\ubcf4\ub4dc \ubcf5\uc0ac\ub294 \uc774 \ud658\uacbd\uc5d0\uc11c \uc9c0\uc6d0\ub418\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4)`);
  }
}
// \ud074\ub9bd\ubcf4\ub4dc\uc5d0 \ud574\ub2f9 DXF \ud14d\uc2a4\ud2b8\ub97c \ubc14\ub85c \ub123\uc5b4\uc90c \u2014 Claude \ub300\ud654\uc5d0 \ubd99\uc5ec\ub123\uae30\ub9cc \ud558\uc5ec\ub3c4 \uc790\ub3d9\uc73c\ub85c 3D\ub85c \ub9cc\ub4e0 \ud30c\uc77c\uc744 \uc804\ub2ec\ud560 \uc218 \uc788\ub3c4\ub85d \ud568.
function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
    return fallbackCopy(text);
  } catch (e) {
    return fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}
// ---------- 3D 미리보기 (오프라인, Three.js로 선택 영역을 돌출) ----------
const V3D = { ready: false, selLines: null, loops: null, group: null, scene: null, camera: null, renderer: null, controls: null, raf: null, name: 'part' };
function traceClosedLoops(lines) {
  // lines: flat [x1,y1,x2,y2, x1,y1,x2,y2, ...]
  const key = (x, y) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4);
  const segs = [];
  for (let i = 0; i < lines.length; i += 4) segs.push([[lines[i], lines[i + 1]], [lines[i + 2], lines[i + 3]]]);
  const byPoint = new Map();
  segs.forEach(([p1, p2], idx) => {
    const k1 = key(...p1), k2 = key(...p2);
    (byPoint.get(k1) || byPoint.set(k1, []).get(k1)).push({ idx, end: 0 });
    (byPoint.get(k2) || byPoint.set(k2, []).get(k2)).push({ idx, end: 1 });
  });
  const used = new Array(segs.length).fill(false);
  const loops = []; let openCount = 0;
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const [p0, p1] = segs[start];
    const chain = [p0, p1];
    let cur = p1, closed = false, guard = 0;
    while (guard++ < segs.length + 5) {
      const cand = (byPoint.get(key(...cur)) || []).find(c => !used[c.idx]);
      if (!cand) break;
      used[cand.idx] = true;
      const seg = segs[cand.idx];
      const next = cand.end === 0 ? seg[1] : seg[0];
      chain.push(next); cur = next;
      if (key(...cur) === key(...chain[0])) { closed = true; break; }
    }
    if (closed && chain.length > 3) { chain.pop(); loops.push(chain); }
    else openCount++;
  }
  return { loops, openCount };
}
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}
function pointInPoly([px, py], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function loopsToShapes(loops) {
  const polys = loops.map(pts => ({ pts, area: signedArea(pts) }));
  const n = polys.length;
  const contains = (i, j) => i !== j && pointInPoly(polys[j].pts[0], polys[i].pts);
  const depth = polys.map((_, i) => { let c = 0; for (let j = 0; j < n; j++) if (contains(j, i)) c++; return c; });
  const parent = polys.map((_, i) => {
    if (depth[i] === 0) return -1;
    let best = -1, bestArea = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && depth[j] === depth[i] - 1 && contains(j, i) && Math.abs(polys[j].area) < bestArea) { best = j; bestArea = Math.abs(polys[j].area); }
    return best;
  });
  const shapes = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue;
    const shape = new THREE.Shape(polys[i].pts.map(([x, y]) => new THREE.Vector2(x, y)));
    for (let j = 0; j < n; j++) if (parent[j] === i) shape.holes.push(new THREE.Path(polys[j].pts.map(([x, y]) => new THREE.Vector2(x, y))));
    shapes.push(shape);
  }
  return shapes;
}
function buildExtrudeGroup(selLines, thickness) {
  const { loops, openCount } = traceClosedLoops(selLines);
  const shapes = loopsToShapes(loops);
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b8def, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2026, transparent: true, opacity: 0.35 });
  for (const shape of shapes) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
    group.add(edges);
  }
  return { group, loopCount: loops.length, shapeCount: shapes.length, openCount };
}
function open3DPreview() {
  if (!S.sel.size) { toast('내보낼 객체를 먼저 선택하세요'); return; }
  const sp = S.space, sg = sp.segs, se = sp.segEnt, set = S.sel;
  const lines = [];
  for (let i = 0; i < se.length; i++) if (set.has(se[i])) lines.push(sg[i * 4], sg[i * 4 + 1], sg[i * 4 + 2], sg[i * 4 + 3]);
  if (!lines.length) { toast('선택한 객체에서 선 데이터를 찾을 수 없습니다 (문자·치수 등은 지원하지 않습니다)'); return; }
  V3D.mv = null;
  V3D.selLines = lines;
  V3D.name = (S.drawing?.meta.name.replace(/\.\w+$/, '') || 'part') + '_선택영역';
  $('#v3dThickWrap').hidden = false;
  $('#v3dFlipWrap').hidden = true;
  $('#view3d').hidden = false;
  if (!V3D.ready) init3DRenderer();
  startLoop();
  rebuild3D();
}
// ---------- 3뷰(정면·평면·측면) 투상도 교차 3D 모델링 ----------
const MV = { active: false, step: 0, lines: { front: null, top: null, side: null } };
const MV_STEPS = ['front', 'top', 'side'];
const MV_LABEL = { front: '정면도', top: '평면도', side: '측면도' };
function mvBar(html) {
  let el = $('#mvBar');
  if (!el) { el = document.createElement('div'); el.id = 'mvBar'; el.className = 'mv-bar'; document.body.appendChild(el); }
  el.innerHTML = html;
  el.hidden = false;
  if ($('#mvCancel')) $('#mvCancel').onclick = mvCancel;
  if ($('#mvSkip')) $('#mvSkip').onclick = mvFinish;
}
function mvHideBar() { const el = $('#mvBar'); if (el) el.hidden = true; }
function startMultiViewCapture() {
  if (!S.space) { toast('도면을 먼저 여세요'); return; }
  MV.active = true; MV.step = 0; MV.lines.front = MV.lines.top = MV.lines.side = null;
  setMode('select');
  setSel([]);
  mvShowStep();
}
function mvShowStep() {
  if (MV.step === 0) mvBar(`<span>① <b>정면도</b> 영역을 드래그로 선택하세요</span><button type="button" class="btn sm ghost" id="mvCancel">취소</button>`);
  else if (MV.step === 1) mvBar(`<span>② <b>평면도</b> 영역을 드래그로 선택하세요</span><button type="button" class="btn sm ghost" id="mvCancel">취소</button>`);
  else mvBar(`<span>③ <b>측면도</b> 영역을 드래그로 선택하세요 (없으면 완료를 누르세요)</span><button type="button" class="btn sm" id="mvSkip">완료 (측면도 생략)</button><button type="button" class="btn sm ghost" id="mvCancel">취소</button>`);
}
function mvCapture(ids) {
  const sp = S.space, sg = sp.segs, se = sp.segEnt;
  const idSet = new Set(ids);
  const lines = [];
  for (let i = 0; i < se.length; i++) if (idSet.has(se[i])) lines.push(sg[i * 4], sg[i * 4 + 1], sg[i * 4 + 2], sg[i * 4 + 3]);
  if (!lines.length) { toast('선택 영역에서 선 데이터를 찾지 못했습니다. 다시 드래그하세요'); return; }
  const key = MV_STEPS[MV.step];
  MV.lines[key] = lines;
  MV.step++;
  toast(`${MV_LABEL[key]} 선택 완료 (선분 ${lines.length / 4}개)`);
  if (MV.step >= MV_STEPS.length) { mvFinish(); return; }
  mvShowStep();
}
function mvCancel() { MV.active = false; mvHideBar(); }
function mvFinish() {
  MV.active = false; mvHideBar();
  if (!MV.lines.front || !MV.lines.top) { toast('정면도와 평면도는 반드시 선택해야 합니다'); return; }
  V3D.mv = { front: MV.lines.front, top: MV.lines.top, side: MV.lines.side };
  V3D.selLines = null;
  V3D.name = (S.drawing?.meta.name.replace(/\.\w+$/, '') || 'part') + '_3뷰모델';
  $('#v3dThickWrap').hidden = true;
  $('#v3dFlipWrap').hidden = false;
  $('#view3d').hidden = false;
  if (!V3D.ready) init3DRenderer();
  startLoop();
  rebuildMV();
}
function shapesFromLines(lines) {
  const { loops, openCount } = traceClosedLoops(lines);
  return { shapes: loopsToShapes(loops), openCount };
}
function bboxOfLines(lines) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < lines.length; i += 4) {
    minX = Math.min(minX, lines[i], lines[i + 2]); maxX = Math.max(maxX, lines[i], lines[i + 2]);
    minY = Math.min(minY, lines[i + 1], lines[i + 3]); maxY = Math.max(maxY, lines[i + 1], lines[i + 3]);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}
function buildViewGeometry(shapes, depth) {
  if (!shapes.length) return null;
  const geos = shapes.map(sh => { const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 }); g.computeVertexNormals(); return g; });
  return geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
}
function buildMultiViewSolid(mv, opts) {
  const frontBB = bboxOfLines(mv.front), topBB = bboxOfLines(mv.top), sideBB = mv.side ? bboxOfLines(mv.side) : null;
  const W = frontBB.w, H = frontBB.h, D = topBB.h;
  const front = shapesFromLines(mv.front), top = shapesFromLines(mv.top), side = mv.side ? shapesFromLines(mv.side) : null;
  let frontGeo = buildViewGeometry(front.shapes, D);
  let topGeo = buildViewGeometry(top.shapes, H);
  let sideGeo = side ? buildViewGeometry(side.shapes, W) : null;
  if (!frontGeo || !topGeo) throw new Error('닫힌 외곽선을 찾지 못했습니다');
  frontGeo.translate(-frontBB.cx, -frontBB.cy, -D / 2);
  topGeo.translate(-topBB.cx, -topBB.cy, 0);
  topGeo.rotateX(-Math.PI / 2);
  topGeo.translate(0, -H / 2, 0);
  let openCount = front.openCount + top.openCount;
  if (sideGeo) {
    sideGeo.translate(-sideBB.cx, -sideBB.cy, 0);
    if (opts.flipSide) { sideGeo.rotateY(-Math.PI / 2); sideGeo.translate(W / 2, 0, 0); }
    else { sideGeo.rotateY(Math.PI / 2); sideGeo.translate(-W / 2, 0, 0); }
    openCount += side.openCount;
  }
  const evaluator = new Evaluator();
  let result = evaluator.evaluate(new Brush(frontGeo), new Brush(topGeo), INTERSECTION);
  if (sideGeo) result = evaluator.evaluate(result, new Brush(sideGeo), INTERSECTION);
  result.geometry.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b8def, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2026, transparent: true, opacity: 0.35 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(result.geometry, mat));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(result.geometry, 25), edgeMat));
  return { group, size: { W, H, D }, openCount };
}
function rebuildMV() {
  if (!V3D.mv) return;
  const flipSide = $('#mvFlip')?.checked || false;
  disposeGroupChildren(V3D.group);
  let built, info;
  try {
    const r = buildMultiViewSolid(V3D.mv, { flipSide });
    built = r.group; info = r;
  } catch (err) {
    toast('3뷰 모델 생성에 실패했습니다: 각 투상도 영역에 완전히 닫힌 윤곽선이 포함되도록 다시 선택해보세요');
    $('#v3dStats').innerHTML = `<div style="color:#e5a33a">모델 생성 실패 (${esc(err.message || String(err))})</div>`;
    return;
  }
  const box = new THREE.Box3();
  built.children.forEach(c => { if (c.geometry) { c.geometry.computeBoundingBox(); box.union(c.geometry.boundingBox); } });
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  built.position.set(-center.x, -center.y, -box.min.z || 0);
  V3D.group.add(built);
  const size = box.isEmpty() ? new THREE.Vector3(100, 100, 100) : box.getSize(new THREE.Vector3());
  const dist = Math.max(60, Math.hypot(size.x, size.y, size.z) * 1.6);
  V3D.camera.position.set(dist * 0.5, -dist * 0.85, dist * 0.6);
  V3D.controls.target.set(0, 0, size.z / 2 || 0);
  V3D.camera.updateProjectionMatrix();
  $('#v3dStats').innerHTML = `<div>정면도 선분: ${V3D.mv.front.length / 4}개</div><div>평면도 선분: ${V3D.mv.top.length / 4}개</div>` +
    (V3D.mv.side ? `<div>측면도 선분: ${V3D.mv.side.length / 4}개</div>` : '<div class="muted">측면도 없음</div>') +
    (info.openCount ? `<div style="color:#e5a33a">닫히지 않은 선: ${info.openCount}개 (제외됨)</div>` : '') +
    `<div>크기(추정): ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm</div>` +
    '<div style="color:#e5a33a">※ 3개 투상도를 교차(intersection)시킨 근사 모델입니다. 결과가 뒤집혀 보이면 "측면도 뒤집기"를 체크해보세요.</div>';
}
function init3DRenderer() {
  const canvas = $('#v3dCanvas');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2026);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(1, 1.3, 2); scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4); dir2.position.set(-1.5, -0.6, -1); scene.add(dir2);
  const grid = new THREE.GridHelper(400, 40, 0x3a4350, 0x2a3138); scene.add(grid);
  const wrap = canvas.parentElement;
  const camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight || 1, 0.1, 100000);
  camera.position.set(80, -140, 160); camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const group = new THREE.Group(); scene.add(group);
  V3D.scene = scene; V3D.camera = camera; V3D.renderer = renderer; V3D.controls = controls; V3D.group = group;
  V3D.ready = true;
  const resize = () => {
    const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  resize();
  new ResizeObserver(resize).observe(wrap);
  V3D.loopFn = () => { controls.update(); renderer.render(scene, camera); V3D.raf = requestAnimationFrame(V3D.loopFn); };
  startLoop();
}
function startLoop() { if (!V3D.raf && V3D.loopFn) V3D.loopFn(); }
function stopLoop() { if (V3D.raf) { cancelAnimationFrame(V3D.raf); V3D.raf = 0; } }
function disposeGroupChildren(group) {
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse?.(o => {
      o.geometry?.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    group.remove(c);
  }
}
function rebuild3D() {
  if (!V3D.selLines) return;
  const thickness = Math.max(0.01, Number($('#v3dThick').value) || 20);
  disposeGroupChildren(V3D.group);
  const { group: built, loopCount, shapeCount, openCount } = buildExtrudeGroup(V3D.selLines, thickness);
  // center the model and lift it onto the grid
  const box = new THREE.Box3();
  built.children.forEach(c => { c.geometry.computeBoundingBox(); box.union(c.geometry.boundingBox); });
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  built.position.set(-center.x, -center.y, -box.min.z || 0);
  V3D.group.add(built);
  V3D.lastShapeCount = shapeCount;
  const size = box.isEmpty() ? new THREE.Vector3(100, 100, 100) : box.getSize(new THREE.Vector3());
  const dist = Math.max(60, Math.hypot(size.x, size.y, size.z) * 1.6);
  V3D.camera.position.set(dist * 0.5, -dist * 0.85, dist * 0.6);
  V3D.controls.target.set(0, 0, size.z / 2 || 0);
  V3D.camera.updateProjectionMatrix();
  $('#v3dStats').innerHTML = `<div>닫힌 외곽선: ${loopCount}개</div><div>돌출된 솔리드: ${shapeCount}개</div>` + (openCount ? `<div style="color:#e5a33a">닫히지 않은 선: ${openCount}개 (제외됨)</div>` : '') + `<div>크기: ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${thickness.toFixed(1)} mm</div>`;
  if (!shapeCount) toast('닫힌 외곽선을 찾지 못했습니다. 선택 영역에 완전히 닫힌 윤곽선이 포함되도록 다시 선택해보세요');
}
function close3DPreview() {
  $('#view3d').hidden = true;
  stopLoop();
}
$('#v3dClose').onclick = close3DPreview;
$('#view3d').addEventListener('click', e => { if (e.target.id === 'view3d') close3DPreview(); });
$('#v3dRebuild').onclick = () => { V3D.mv ? rebuildMV() : rebuild3D(); };
$('#mvFlip')?.addEventListener('change', () => rebuildMV());
$('#v3dStl').onclick = () => {
  if (!V3D.group || !V3D.group.children.length) { toast('먼저 3D 모델을 만들어주세요'); return; }
  const exporter = new STLExporter();
  const result = exporter.parse(V3D.group, { binary: false });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([result], { type: 'model/stl' }));
  a.download = V3D.name + '.stl';
  a.click();
  toast('STL 파일로 내보냈습니다');
};
$('#v3dObj').onclick = () => {
  if (!V3D.group || !V3D.group.children.length) { toast('먼저 3D 모델을 만들어주세요'); return; }
  const exporter = new OBJExporter();
  const result = exporter.parse(V3D.group);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([result], { type: 'text/plain' }));
  a.download = V3D.name + '.obj';
  a.click();
  toast('OBJ 파일로 내보냈습니다');
};
if (IS_LOCAL) $$('.local-only').forEach(el => el.hidden = false);

// ---------- chrome ----------
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, 3200); }
function showLoading(msg) { $('#loading').hidden = false; setLoading(msg); }
function setLoading(msg) { $('#loadingMsg').textContent = msg; }
function hideLoading() { $('#loading').hidden = true; }
function showError(msg, isDwg) {
  $('#errMsg').textContent = msg;
  $('#errDxf').hidden = !isDwg;
  $('#error').hidden = false;
}
$('#errClose').addEventListener('click', () => $('#error').hidden = true);

$('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
$$('[data-open]').forEach(b => b.addEventListener('click', () => $('#fileInput').click()));
let dragN = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; $('#drop').hidden = false; });
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; $('#drop').hidden = true; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

$$('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#propsClose').addEventListener('click', () => syncToggles());
$('#snapBtn').addEventListener('click', toggleSnap);

// ---------- actions (ribbon, menus, status bar share one dispatcher) ----------
const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;
function act(name, arg) {
  closeMenus();
  switch (name) {
    case 'extents': zoomExtents(); break;
    case 'zin': zoomAt(W / 2, H / 2, 1.5); break;
    case 'zout': zoomAt(W / 2, H / 2, 1 / 1.5); break;
    case 'close': closeDrawing(); break;
    case 'png': canvas.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (S.drawing?.meta.name.replace(/\.\w+$/, '') || 'drawing') + '.png'; a.click(); }); break;
    case 'bg': S.bgDark = !S.bgDark; store.set('bgDark', S.bgDark); renderLayers(); break;
    case 'mono': S.mono = !S.mono; store.set('mono', S.mono); renderLayers(); break;
    case 'dash': S.showDash = !S.showDash; store.set('dash', S.showDash); break;
    case 'text': S.showText = !S.showText; store.set('text', S.showText); break;
    case 'snap': toggleSnap(); break;
    case 'snapk': S.snapKinds[arg] = S.snapKinds[arg] ? 0 : 1; store.set('snapKinds', S.snapKinds); if (S.snapKinds[arg] && !S.snapOn) toggleSnap(); break;
    case 'side':
      if (isNarrow()) $('#app').classList.toggle('side-open'); else $('#app').classList.toggle('side-collapsed'); break;
    case 'props':
      if (isNarrow()) $('#app').classList.toggle('props-open'); else $('#app').classList.toggle('props-collapsed'); break;
    case 'panel': {
      const b = $(`.stabs button[data-panel="${arg}"]`); if (b) b.click();
      $('#app').classList.remove('side-collapsed'); if (isNarrow()) $('#app').classList.add('side-open');
      const inp = { pTexts: '#txtFilter', pBlocks: '#blkFilter', pLayers: '#layerFilter' }[arg]; if (inp && !isNarrow()) setTimeout(() => $(inp).focus(), 0);
      break;
    }
    case 'full': {
      const el = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen?.();
      else Promise.resolve(el.requestFullscreen?.()).catch(() => toast('이 환경에서는 전체 화면을 쓸 수 없습니다'));
      break;
    }
    case 'meas-copy': if (!S.measures.length) toast('복사할 측정 결과가 없습니다'); else copyTSV(measRows(), '측정 결과'); break;
    case 'meas-clear': S.measures = []; S.pending = []; updateMeasureList(); break;
    case 'blk-copy': if (!S.drawing) toast('먼저 도면을 여세요'); else { renderBlocks(); $('#blkCopy').click(); } break;
    case 'txt-copy': if (!S.drawing) toast('먼저 도면을 여세요'); else $('#txtCopy').click(); break;
    case 'keys': $('#keys').hidden = false; $('#keys [data-close]').focus(); break;
    case 'sel-zoom': zoomToEnts([...S.sel]); break;
    case 'sel-dxf': exportSelDxf(); break;
    case 'sel-3d': open3DPreview(); break;
    case 'sel-3d-mv': startMultiViewCapture(); break;
    case 'sel-clear': setSel([]); break;
    case 'sel-layer-off': { const r = S.space.ents[[...S.sel][0]]; const l = S.drawing.layers.get(r?.layer); if (l) { l.on = false; computeVis(); renderLayers(); setSel([]); } break; }
    case 'area-close': finishArea(); break;
    case 'cancel': S.pending = []; break;
    case 'mode': setMode(arg); break;
  }
  syncToggles(); redraw();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) { act(b.dataset.act, b.dataset.panelOpen ?? b.dataset.arg); return; }
  const k = e.target.closest('[data-snapk]'); if (k) { act('snapk', +k.dataset.snapk); return; }
  const m = e.target.closest('[data-mode]'); if (m && m.closest('.menu')) closeMenus();
  if (!e.target.closest('.menu, #appBtn, #snapMore')) closeMenus();
});
function syncToggles() {
  const pr = (sel, v) => $$(sel).forEach(b => b.setAttribute('aria-pressed', !!v));
  pr('[data-act="bg"]', !S.bgDark); $$('.rbtn[data-act="bg"] span').forEach(sp => sp.textContent = S.bgDark ? '검정 배경' : '흰 배경');
  pr('[data-act="mono"]', S.mono); pr('[data-act="dash"]', S.showDash); pr('[data-act="text"]', S.showText);
  pr('[data-act="snap"]', S.snapOn); pr('#snapBtn', S.snapOn);
  $$('[data-snapk]').forEach(b => b.setAttribute('aria-pressed', !!S.snapKinds[+b.dataset.snapk]));
  $$('[data-snapchk]').forEach(c => c.checked = !!S.snapKinds[+c.dataset.snapchk]);
  pr('[data-act="side"]', !$('#app').classList.contains(isNarrow() ? 'nope' : 'side-collapsed') && (!isNarrow() || $('#app').classList.contains('side-open')));
  pr('[data-act="props"]', isNarrow() ? $('#app').classList.contains('props-open') : !$('#app').classList.contains('props-collapsed'));
  pr('[data-act="full"]', !!document.fullscreenElement);
  canvas.parentElement.dataset.bg = S.bgDark ? 'dark' : 'light';
}
document.addEventListener('fullscreenchange', syncToggles);

// ribbon tabs
function setRibbonTab(t) {
  $$('[data-rtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.rtab === t));
  $$('.rb-pane').forEach(p => p.hidden = p.dataset.pane !== t);
  store.set('rtab', t);
}
function setRibbonMin(v) { $('#ribbon').classList.toggle('min', v); $('#ribbonMin').setAttribute('aria-pressed', v); store.set('rmin', v); }
$$('[data-rtab]').forEach(b => {
  b.addEventListener('click', () => { setRibbonTab(b.dataset.rtab); if ($('#ribbon').classList.contains('min')) setRibbonMin(false); });
  b.addEventListener('dblclick', () => setRibbonMin(!$('#ribbon').classList.contains('min')));
});
$('#ribbonMin').addEventListener('click', () => setRibbonMin(!$('#ribbon').classList.contains('min')));
setRibbonTab(store.get('rtab', 'home')); setRibbonMin(store.get('rmin', false));

// menus
function placeMenu(m, x, y) {
  m.hidden = false; m.style.left = '0px'; m.style.top = '0px';
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  m.querySelector('button:not([hidden]):not(:disabled), input')?.focus({ preventScroll: true });
}
function closeMenus() {
  let any = false;
  for (const id of ['appMenu', 'ctxMenu', 'snapPop']) { const m = $('#' + id); if (!m.hidden) { m.hidden = true; any = true; } }
  if (!$('#keys').hidden) { $('#keys').hidden = true; any = true; }
  $('#appBtn').setAttribute('aria-expanded', 'false');
  return any;
}
$('#appBtn').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('#appMenu').hidden; closeMenus();
  if (open) { const r = e.currentTarget.getBoundingClientRect(); placeMenu($('#appMenu'), r.left, r.bottom + 4); $('#appBtn').setAttribute('aria-expanded', 'true'); }
});
$('#snapMore').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('#snapPop').hidden; closeMenus();
  if (open) { const r = e.currentTarget.getBoundingClientRect(); const m = $('#snapPop'); m.hidden = false; placeMenu(m, r.right - m.offsetWidth, r.top - m.offsetHeight - 6); syncToggles(); }
});
$$('[data-snapchk]').forEach(c => c.addEventListener('change', () => { S.snapKinds[+c.dataset.snapchk] = c.checked ? 1 : 0; store.set('snapKinds', S.snapKinds); syncToggles(); }));
$$('.menu').forEach(m => m.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...m.querySelectorAll('button:not([hidden]):not(:disabled)')], i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}));
$('#keys').addEventListener('click', e => { if (e.target.id === 'keys' || e.target.closest('[data-close]')) $('#keys').hidden = true; });
function showCtx(x, y) {
  closeMenus();
  const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const it = (icon, label, a, arg, key = '', dis = false) => `<button type="button" role="menuitem" data-act="${a}"${arg != null ? ` data-arg="${arg}"` : ''}${dis ? ' disabled' : ''}>${I(icon)}<span>${label}</span>${key ? `<kbd>${key}</kbd>` : '<span></span>'}</button>`;
  const P = { ext: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', pan: '<path d="M12 3v18M3 12h18"/>', win: '<rect x="3" y="3" width="12" height="12" rx="1"/><path d="M18.5 18.5L21 21"/>', dist: '<path d="M3 17L17 3l4 4L7 21z"/>', area: '<path d="M4 18L7 5l12 3-2 11z"/>', pt: '<circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', ok: '<path d="M5 12l5 5 9-10"/>', z: '<circle cx="11" cy="11" r="7"/><path d="M16 16l5 5"/>', off: '<path d="M3 3l18 18"/><path d="M12 3l9 5-9 5-9-5z"/>', snap: '<rect x="8" y="8" width="8" height="8"/>', dxf: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><path d="M9 13v5M9 13l3 5M12 13l3 5"/>', cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>' };
  let h = '';
  if (S.pending.length) {
    h += `<div class="mhead">${S.mode === 'area' ? '면적 측정 중' : '거리 측정 중'}</div>`;
    if (S.mode === 'area') h += it(P.ok, '면적 닫기', 'area-close', null, 'Enter', S.pending.length < 3);
    h += it(P.x, '측정 취소', 'cancel', null, 'Esc') + '<hr>';
  }
  if (S.sel.size) {
    h += `<div class="mhead">선택 ${S.sel.size}개</div>` + it(P.z, '선택 객체로 확대', 'sel-zoom') + it(P.dxf, 'DXF로 내보내기 (3D 변환용)', 'sel-dxf') + it(P.cube, '3D 미리보기 (오프라인)', 'sel-3d') + (S.sel.size === 1 ? it(P.off, '이 레이어 끄기', 'sel-layer-off') : '') + it(P.x, '선택 해제', 'sel-clear', null, 'Esc') + '<hr>';
  }
  h += it(P.ext, '전체 보기', 'extents', null, 'F') + it(P.pan, '화면 이동', 'mode', 'pan', 'P') + it(P.win, '창 확대', 'mode', 'zoomwin', 'W') + '<hr>';
  h += it(P.dist, '거리 측정', 'mode', 'dist', 'D') + it(P.area, '면적 측정', 'mode', 'area', 'A') + it(P.pt, '점 좌표', 'mode', 'point', 'I') + '<hr>';
  h += it(P.snap, S.snapOn ? '객체 스냅 끄기' : '객체 스냅 켜기', 'snap', null, 'S');
  const m = $('#ctxMenu'); m.innerHTML = h; placeMenu(m, x, y);
}
$$('.stabs button').forEach(b => b.addEventListener('click', () => {
  $$('.stabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  $$('.spanel').forEach(p => p.hidden = p.id !== b.dataset.panel);
  store.set('panel', b.dataset.panel);
}));
{ const p = store.get('panel', 'pLayers'); const b = $(`.stabs button[data-panel="${p}"]`); if (b) b.click(); }
$('#propsClose').addEventListener('click', () => $('#app').classList.remove('props-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('side-open', 'props-open'));

new ResizeObserver(resize).observe(canvas.parentElement);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { C = null; redraw(); });
new MutationObserver(() => { C = null; redraw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

const ICON = {
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>',
};

// ---------- boot ----------
syncToggles();
setMode('select');
resize();
renderProps();
(async () => {
  // warm up the DWG engine in the background so the first DWG opens faster
  setTimeout(() => prepareSpare().then(() => { S.engine = 'ok'; }, err => { S.engine = String(err && err.message || err); }).finally(renderInfo), 800);
})();
const _open = openFile;
window.__dwgv = { S, openBuffer, redraw, zoomBox, setSel, zoomToEnts, setMode, MV, mvCapture, mvFinish, boxSelect, V3D, rebuildMV, open3DPreview, getWH: () => [W, H] };
document.addEventListener('dwgv-opened', () => { });
// ---------- about ----------
$('#aboutVer').textContent = `버전 ${APP_VERSION}`;
$('#welcomeVer').textContent = `도면 뷰어 ${APP_VERSION} · 무료 배포판`;
$('#aboutCopy').textContent = `Copyright (C) ${new Date(2026, 0).getFullYear()} ${AUTHOR}`;
$('#aboutSource').textContent = SOURCE_NOTE;
function openAbout() {
  const pre = $('#gplText'); if (!pre.textContent) pre.textContent = ($('#gpl-src')?.textContent || '').trim() || 'https://www.gnu.org/licenses/gpl-3.0.html';
  $('#about').hidden = false; $('#aboutClose').focus();
}
$$('[data-about]').forEach(b => b.addEventListener('click', openAbout));
$('#aboutClose').addEventListener('click', () => $('#about').hidden = true);
$('#about').addEventListener('click', e => { if (e.target.id === 'about') $('#about').hidden = true; });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#about').hidden) { $('#about').hidden = true; e.stopImmediatePropagation(); } }, true);
