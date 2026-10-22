import * as esbuild from 'esbuild';
import fs from 'fs'; import zlib from 'zlib';
const r = await esbuild.build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', minify: true, write: false, platform: 'browser', target: 'es2021', charset: 'ascii', logLevel: 'warning',
  external: ['module', 'node:module', 'fs', 'node:fs', 'path', 'node:path', 'url', 'node:url', 'crypto', 'node:crypto', 'ws', 'worker_threads', 'node:worker_threads'] });
let js = r.outputFiles[0].text;
const wasm = fs.readFileSync('node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm');
const b64 = zlib.gzipSync(wasm, { level: 9 }).toString('base64');
const gpl = fs.readFileSync('LICENSE', 'utf8');
let html = fs.readFileSync('template.html', 'utf8');
html = html.replace('/*__APP__*/', () => js.replace(/<\/script/gi, '<\\/script')).replace('/*__GPL__*/', () => gpl.replace(/<\/script/gi, '<\\/script')).replace('/*__WASM__*/', () => b64);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/도면뷰어.html', html);
console.log('js', (js.length/1024).toFixed(0)+'KB', 'html', (html.length/1024/1024).toFixed(2)+'MB');
