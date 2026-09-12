/**
 * dsh-workspace-tools host half.
 *
 * 只为「工作区背景」提供持久化：浏览器半把裁好的 PNG（dataURL）POST 上来，
 * 落到 ~/.dsh/storages/workspace-covers/（每工作区一个 <key>.png + <key>-src.png
 * 原图 + index.json + global.json），再按 key 供浏览器取回。
 * 另两个功能（折叠 / 分组）是纯前端，服务端不需要任何状态。
 *
 * 放在 ~/.dsh 而不是工作区目录里，是为了不污染用户的项目文件夹。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.join(os.homedir(), '.dsh', 'storages', 'workspace-covers');
const PRESET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'presets');
const PRESET_IDS = new Set(['life', 'study', 'paper', 'tech', 'health', 'leisure', 'video', 'engineering']);
// 只接受来自本机的请求。DSH Web 不一定跑在默认端口上，所以按 host 判断而不是写死端口。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const INDEX = path.join(DIR, 'index.json');
const GLOBAL_FILE = path.join(DIR, 'global.json');
const MAX_BODY = 16 * 1024 * 1024;
const MAX_PNG = 8 * 1024 * 1024;

const ensureDir = () => { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) { /* ignore */ } };
const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')) || {}; } catch (_) { return {}; } };
const writeIndex = (o) => { ensureDir(); fs.writeFileSync(INDEX, JSON.stringify(o, null, 1), 'utf8'); };
const keyFor = (name) => crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 12);

const allowed = (req) => {
  const origin = req.headers['origin'];
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
    } catch (_) { return false; }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
};
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      data += c;
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(''); }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function sendJson(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export default {
  name: 'dsh-workspace-tools',
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.get('webServer');
    if (webServer === undefined) return;
    const disposers = [];
    const route = (p, handler) => disposers.push(webServer.register({ kind: 'exact', path: p, handler }));

    route('/dsh-cover-list', (req, res) => {
      if (!allowed(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403);
      const idx = readIndex();
      const items = Object.keys(idx).map((name) =>
        Object.assign({ name }, idx[name], { params: idx[name].params || {} }));
      sendJson(res, { ok: true, items });
    });

    route('/dsh-cover-global', async (req, res) => {
      if (!allowed(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403);
      const clamp = (v) => Math.max(28, Math.min(120, Number(v) || 34));
      try {
        if (String(req.method || 'GET').toUpperCase() === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const rowHeight = clamp(body.rowHeight);
          ensureDir();
          fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ rowHeight }, null, 1), 'utf8');
          return sendJson(res, { ok: true, rowHeight });
        }
        let g = {};
        try { g = JSON.parse(fs.readFileSync(GLOBAL_FILE, 'utf8')) || {}; } catch (_) { /* 首次运行 */ }
        sendJson(res, { ok: true, rowHeight: clamp(g.rowHeight) });
      } catch (e) { sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }); }
    });

    route('/dsh-cover-save', async (req, res) => {
      if (!allowed(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403);
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim().slice(0, 200);
        const dataUrl = String(body.dataUrl || '');
        const prefix = 'data:image/png;base64,';
        if (!name) return sendJson(res, { ok: false, error: '缺少工作区名' });
        if (dataUrl.indexOf(prefix) !== 0) return sendJson(res, { ok: false, error: '只接受 PNG dataURL' });
        const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64');
        if (!buf.length || buf.length > MAX_PNG) return sendJson(res, { ok: false, error: '图片为空或过大' });
        ensureDir();
        const key = keyFor(name);
        fs.writeFileSync(path.join(DIR, key + '.png'), buf);
        const srcUrl = String(body.srcDataUrl || '');
        let hasSrc = false;
        if (srcUrl.indexOf(prefix) === 0) {
          const srcBuf = Buffer.from(srcUrl.slice(prefix.length), 'base64');
          if (srcBuf.length && srcBuf.length <= MAX_PNG) {
            fs.writeFileSync(path.join(DIR, key + '-src.png'), srcBuf);
            hasSrc = true;
          }
        }
        const idx = readIndex();
        idx[name] = {
          key,
          bytes: buf.length,
          hasSrc,
          params: body.params && typeof body.params === 'object' ? body.params : {},
          updatedAt: Date.now(),
        };
        writeIndex(idx);
        sendJson(res, { ok: true, key, bytes: buf.length });
      } catch (e) { sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }); }
    });

    route('/dsh-cover-delete', async (req, res) => {
      if (!allowed(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403);
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        const idx = readIndex();
        if (idx[name]) {
          const key = idx[name].key;
          delete idx[name];
          writeIndex(idx);
          if (key) {
            try { fs.unlinkSync(path.join(DIR, key + '.png')); } catch (_) { /* already gone */ }
            try { fs.unlinkSync(path.join(DIR, key + '-src.png')); } catch (_) { /* no source kept */ }
          }
        }
        sendJson(res, { ok: true });
      } catch (e) { sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) }); }
    });

    const servePng = (suffix, fallback) => (req, res) => {
      try {
        const qs = String(req.url || '').split('?')[1] || '';
        const key = new URLSearchParams(qs).get('k') || '';
        if (!/^[0-9a-f]{6,40}$/.test(key)) { res.writeHead(400); res.end(); return; }
        let file = path.join(DIR, key + suffix);
        if (fallback && !fs.existsSync(file)) file = path.join(DIR, key + fallback);
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch (_) { res.writeHead(404); res.end(); }
    };
    route('/dsh-cover-img', servePng('.png'));
    route('/dsh-cover-src', servePng('-src.png', '.png'));

    // 内置默认图集：插件自带 assets/presets/*.png，只读、可长缓存
    route('/dsh-cover-preset', (req, res) => {
      try {
        const qs = String(req.url || '').split('?')[1] || '';
        const id = new URLSearchParams(qs).get('id') || '';
        if (!PRESET_IDS.has(id)) { res.writeHead(404); res.end(); return; }
        const buf = fs.readFileSync(path.join(PRESET_DIR, id + '.png'));
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(buf);
      } catch (_) { res.writeHead(404); res.end(); }
    });

    return () => {
      for (const dispose of disposers) { try { dispose(); } catch (_) { /* already gone */ } }
    };
  },
};
