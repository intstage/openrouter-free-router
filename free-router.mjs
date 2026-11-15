#!/usr/bin/env node
// free-router — automatic selection of free OpenRouter models, as one OpenAI-compatible endpoint.
//   node free-router.mjs            run the proxy on FR_HOST:FR_PORT (and refresh the catalog once a day)
//   node free-router.mjs --sync     refresh the catalog now, probe new models, update DeepSeek Harness config
//   node free-router.mjs --status   show what is in use
// Configuration: environment variables (see README.md). Node.js >= 20, no dependencies.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  filterFree, rankModels, workingModels, pickBatch, needProbe, probeBody, judgeProbe,
} from './catalog.mjs';
import { updatePatchFile, AUTO_MODEL } from './dsh-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const CFG = {
  host: env.FR_HOST || '127.0.0.1',
  port: Number(env.FR_PORT || 11500),
  stateDir: env.FR_STATE_DIR || join(HERE, 'state'),
  keyFile: env.FR_KEY_FILE || '',
  patches: (env.FR_DSH_PATCHES || '').split(':').filter(Boolean),
  apiKeyEnv: env.FR_DSH_API_KEY_ENV || '',          // env var name DSH must resolve for this provider
  notify: env.FR_NOTIFY || 'none',                  // "mac" — macOS notification about new models
  syncHours: Number(env.FR_SYNC_HOURS || 24),
  cooldownMs: Number(env.FR_COOLDOWN_MIN || 10) * 60_000,
  maxBatches: Number(env.FR_MAX_BATCHES || 3),
  upstreamProxy: env.FR_HTTPS_PROXY || '',          // optional http://host:port proxy to reach openrouter.ai
};
const UPSTREAM = 'openrouter.ai';
const STATE_FILE = join(CFG.stateDir, 'state.json');
const LOG_FILE = join(CFG.stateDir, 'requests.jsonl');
const FAVORITES_FILE = existsSync(join(CFG.stateDir, 'favorites.txt'))
  ? join(CFG.stateDir, 'favorites.txt') : join(HERE, 'favorites.txt');

const log = (...p) => process.stdout.write(`${new Date().toISOString()} ${p.join(' ')}\n`);

// ---------- state ----------
mkdirSync(CFG.stateDir, { recursive: true });
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { probes: {}, working: [], syncedAt: 0 }; }
}
function saveState(s) {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}
function favorites() {
  try {
    return readFileSync(FAVORITES_FILE, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  } catch { return []; }
}

// ---------- API key (re-read when the file changes, so it can be added without a restart) ----------
let keyCache = { mtime: -1, key: '' };
function apiKey() {
  if (!CFG.keyFile) return env.OPENROUTER_API_KEY || '';
  try {
    const { mtimeMs } = statSync(CFG.keyFile);
    if (mtimeMs !== keyCache.mtime) {
      const m = readFileSync(CFG.keyFile, 'utf8').match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\s]+)/m);
      keyCache = { mtime: mtimeMs, key: m ? m[1] : '' };
    }
    return keyCache.key;
  } catch { return env.OPENROUTER_API_KEY || ''; }
}

// ---------- upstream requests (node:https: no 5-minute header timeout like fetch) ----------
/** TLS socket to openrouter.ai through an HTTP CONNECT proxy, if FR_HTTPS_PROXY is set. */
function proxySocket() {
  return new Promise((resolve, reject) => {
    const proxy = new URL(CFG.upstreamProxy);
    const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${UPSTREAM}:443` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT: HTTP ${res.statusCode}`)); }
      resolve(tls.connect({ socket, servername: UPSTREAM }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function upstream(method, path, body, { stream = false } = {}) {
  const socket = CFG.upstreamProxy ? await proxySocket() : null;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: UPSTREAM, path: `/api/v1${path}`, method,
      ...(socket && { createConnection: () => socket }),
      headers: {
        authorization: `Bearer ${apiKey()}`,
        'content-type': 'application/json',
        'x-title': 'free-router',
        ...(data && { 'content-length': data.length }),
      },
    }, (res) => {
      if (stream && res.statusCode === 200) return resolve({ status: 200, res });
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(600_000, () => req.destroy(new Error('timeout after 10 min')));
    if (data) req.write(data);
    req.end();
  });
}

// "Rate limit exceeded: free-models-per-day" — the account-wide daily cap; trying other models is pointless.
const isDailyLimit = (text = '') => /per-day/i.test(text);

// ---------- catalog refresh ----------
async function sync({ probe = true } = {}) {
  const state = loadState();
  const list = await upstream('GET', '/models');
  if (list.status !== 200 || !Array.isArray(list.json?.data)) throw new Error(`model list: HTTP ${list.status}`);
  const fav = favorites();
  const free = filterFree(list.json.data);
  let ranked = rankModels(free, fav, state.probes);

  if (probe && apiKey()) {
    for (const m of needProbe(ranked, state.probes)) {
      let ok = null;
      try {
        const r = await upstream('POST', '/chat/completions', probeBody(m.id));
        ok = judgeProbe(r.status, r.json);
        if (r.status === 429 && isDailyLimit(r.text)) { log('probe: daily limit reached, the rest tomorrow'); break; }
      } catch (e) { log('probe', m.id, 'error:', e.message); }
      state.probes[m.id] = { ok, at: Date.now() };
      log('probe', m.id, ok === true ? 'passed' : ok === false ? 'FAILED' : 'unknown (busy)');
    }
    ranked = rankModels(free, fav, state.probes);
  }

  const working = workingModels(ranked, fav, state.probes);
  const before = new Set(state.working || []);
  const added = working.filter((m) => !before.has(m.id)).map((m) => m.id);
  const removed = [...before].filter((id) => !working.some((m) => m.id === id));
  state.working = working.map((m) => m.id);
  state.models = Object.fromEntries(working.map((m) => [m.id, { name: m.name, context_length: m.context_length }]));
  state.candidates = free.length;
  state.syncedAt = Date.now();
  if (added.length || removed.length) {
    state.changes = [...(state.changes || []), { at: state.syncedAt, added, removed }].slice(-30);
  }
  saveState(state);

  for (const path of CFG.patches) {
    try {
      const r = updatePatchFile(path, working, { baseURL: `http://${CFG.host}:${CFG.port}/v1`, apiKeyEnv: CFG.apiKeyEnv });
      log('DSH config', path, r);
    } catch (e) { log('DSH config', path, 'error:', e.message); }
  }
  log(`catalog: ${free.length} eligible free models, ${working.length} in use`,
    added.length ? `new: ${added.join(', ')}` : '', removed.length ? `removed: ${removed.join(', ')}` : '');
  if (added.length && before.size) notify(`New free models: ${added.join(', ')}`);
  return { free: free.length, working: state.working, added, removed };
}

// One refresh at a time: a manual trigger and the daily timer must not spend the quota twice.
let syncing = null;
function syncOnce() {
  if (!syncing) syncing = sync().finally(() => { syncing = null; });
  return syncing;
}

function notify(text) {
  if (CFG.notify !== 'mac') return;
  const script = `display notification ${JSON.stringify(text)} with title "free-router"`;
  execFile('osascript', ['-e', script], () => {});
}

// ---------- proxy ----------
const cooldown = {};             // model id → do not offer until (after 429/503)
let dailyLimitUntil = 0;         // OpenRouter daily cap — until midnight UTC

function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.getTime();
}

function record(entry) {
  try { appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* log is optional */ }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const fail = (res, status, message) => sendJson(res, status, { error: { message: `free-router: ${message}`, code: status } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function chat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'request body is not JSON'); }
  if (!apiKey()) return fail(res, 503, `no OpenRouter key: put OPENROUTER_API_KEY=… into ${CFG.keyFile || 'the environment'}`);
  const state = loadState();
  const isAuto = !body.model || body.model === AUTO_MODEL || body.model.endsWith(`/${AUTO_MODEL}`);
  const pool = isAuto ? state.working || [] : [body.model];
  if (isAuto && !pool.length) return fail(res, 503, 'no free models yet — run node free-router.mjs --sync');
  if (Date.now() < dailyLimitUntil) {
    return fail(res, 429, `OpenRouter daily free-request limit reached until ${new Date(dailyLimitUntil).toISOString()}`);
  }

  const tried = [];
  for (let attempt = 0; attempt < (isAuto ? CFG.maxBatches : 1); attempt++) {
    const batch = isAuto ? pickBatch(pool.filter((id) => !tried.includes(id)), cooldown) : pool;
    if (!batch.length) break;
    tried.push(...batch);
    const out = { ...body, model: batch[0] };
    if (batch.length > 1) out.models = batch; else delete out.models;
    const t0 = Date.now();
    let r;
    try { r = await upstream('POST', '/chat/completions', out, { stream: !!body.stream }); } catch (e) {
      record({ batch, error: e.message });
      return fail(res, 502, `OpenRouter unreachable: ${e.message}`);
    }
    if (r.status === 200 && r.res) return pipeStream(r.res, res, { batch, t0 });
    if (r.status === 200) {
      record({ batch, status: 200, model: r.json?.model, ms: Date.now() - t0 });
      return sendJson(res, 200, r.json ?? {});
    }
    record({ batch, status: r.status, ms: Date.now() - t0, error: (r.json?.error?.message || r.text || '').slice(0, 200) });
    if (r.status === 429 && isDailyLimit(r.text)) {
      dailyLimitUntil = nextUtcMidnight();
      return fail(res, 429, 'OpenRouter daily free-request limit reached');
    }
    const retryable = [429, 502, 503, 504, 404].includes(r.status) || (r.status === 400 && /provider|endpoint/i.test(r.text));
    if (!isAuto || !retryable) {
      res.writeHead(r.status, { 'content-type': r.headers?.['content-type'] || 'application/json' });
      return res.end(r.text);
    }
    for (const id of batch) cooldown[id] = Date.now() + CFG.cooldownMs;
  }
  return fail(res, 429, `all free models are busy right now (tried: ${tried.join(', ')}); retry in a few minutes`);
}

function pipeStream(up, res, { batch, t0 }) {
  res.writeHead(200, {
    'content-type': up.headers['content-type'] || 'text/event-stream',
    'cache-control': 'no-cache',
  });
  let head = '';
  let model = null;
  up.on('data', (c) => {
    if (!model && head.length < 8192) {
      head += c.toString('utf8');
      model = head.match(/"model"\s*:\s*"([^"]+)"/)?.[1] || null;
    }
    res.write(c);
  });
  up.on('end', () => { record({ batch, status: 200, stream: true, model, ms: Date.now() - t0 }); res.end(); });
  up.on('error', (e) => { record({ batch, stream: true, error: e.message }); res.destroy(e); });
  res.on('close', () => up.destroy());
}

function listModels(res) {
  const s = loadState();
  const data = [{ id: AUTO_MODEL, object: 'model', owned_by: 'free-router', context_length: 128000, name: 'Auto: best available free model' },
    ...(s.working || []).map((id) => ({ id, object: 'model', owned_by: 'openrouter', ...s.models?.[id] }))];
  sendJson(res, 200, { object: 'list', data });
}

function status() {
  const s = loadState();
  const now = Date.now();
  return {
    syncedAt: s.syncedAt ? new Date(s.syncedAt).toISOString() : null,
    candidates: s.candidates ?? null,
    working: s.working || [],
    cooling: Object.entries(cooldown).filter(([, t]) => t > now).map(([id, t]) => `${id}: ${Math.ceil((t - now) / 60000)} min`),
    dailyLimitUntil: dailyLimitUntil > now ? new Date(dailyLimitUntil).toISOString() : null,
    failedProbes: Object.entries(s.probes || {}).filter(([, p]) => p.ok === false).map(([id]) => id),
    hasKey: Boolean(apiKey()),
    lastChanges: (s.changes || []).slice(-3),
  };
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0].replace(/\/+$/, '');
    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
      return chat(req, res).catch((e) => { log('error', e.stack); if (!res.headersSent) fail(res, 500, e.message); else res.destroy(); });
    }
    if (req.method === 'GET' && /\/models$/.test(url)) return listModels(res);
    if (req.method === 'POST' && url === '/sync') {
      return syncOnce()
        .then((r) => sendJson(res, 200, { ok: true, ...r }))
        .catch((e) => sendJson(res, 502, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && (url === '' || url === '/status' || url === '/health')) return sendJson(res, 200, status());
    return fail(res, 404, `unknown endpoint: ${req.method} ${req.url}`);
  });
  server.listen(CFG.port, CFG.host, () => log(`listening on http://${CFG.host}:${CFG.port}/v1, key: ${apiKey() ? 'yes' : 'MISSING'}`));

  const maybeSync = () => {
    const s = loadState();
    if (Date.now() - (s.syncedAt || 0) < CFG.syncHours * 3600_000) return;
    syncOnce().catch((e) => log('catalog refresh failed:', e.message));
  };
  setTimeout(maybeSync, 5_000);
  setInterval(maybeSync, 3600_000).unref();
}

// ---------- entry point ----------
const arg = process.argv[2];
if (arg === '--sync') {
  sync({ probe: !process.argv.includes('--no-probe') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error('error:', e.message); process.exit(1); });
} else if (arg === '--status') {
  console.log(JSON.stringify(status(), null, 2));
} else if (!arg) {
  serve();
} else {
  console.error('usage: node free-router.mjs [--sync [--no-probe] | --status]');
  process.exit(2);
}
