/*
 * Viral Video Mini App — একটি মাত্র API ফাইল (Vercel Serverless + Upstash Redis)
 *
 *  GET  /api?r=data     → সবার জন্য পোস্ট/ক্যাটাগরি/সেটিংস/ভিউ (CDN ক্যাশ হয়, তাই ২০০+ জনেও লোড নেই)
 *  POST /api?r=event    → view / like / unlike / ad / unlock কাউন্টার (atomic)
 *  POST /api?r=login    → অ্যাডমিন লগইন (পাসওয়ার্ড শুধু সার্ভারে যাচাই হয়)
 *  POST /api?r=save     → অ্যাডমিন পরিবর্তন সেভ (টোকেন লাগে)
 *
 * Environment variables (Vercel → Storage → Upstash Redis কানেক্ট করলে নিজে থেকেই বসে যায়):
 *   KV_REST_API_URL , KV_REST_API_TOKEN   (অথবা UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
 *   BOT_USERNAME  (ঐচ্ছিক, অ্যাডমিন সেটিংসেও দেওয়া যায়)
 */
const crypto = require('crypto');

// ---- অ্যাডমিন: ইউজারনেম "admin" — পাসওয়ার্ড কোডে নেই, শুধু scrypt হ্যাশ আছে। পরিবর্তনের কোনো API নেই। ----
const ADMIN_USER = 'admin';
const ADMIN_SALT = 'vv-admin-salt-v1';
const ADMIN_HASH = 'bcdf040ad7c30454a947a0ffaa5ae1d23a218bd91bcd95468b4626a90c60bacb';

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HASH = 'vv'; // একটাই Redis hash: state, v:<id>, l:<id>, s:<stat>

async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('NO_DB');
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('DB_' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x && x.error) throw new Error(x.error);
    return x.result;
  });
}

function hgetallToObj(arr) {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  else if (arr && typeof arr === 'object') return arr;
  return o;
}

function send(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

const safeId = (v) => /^[A-Za-z0-9_-]{1,40}$/.test(String(v));
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();

// প্রতি ইনস্ট্যান্সে সহজ রেট-লিমিট (ইভেন্ট স্প্যাম ঠেকাতে)
const bucket = new Map();
function rateOk(ip, limit) {
  const now = Date.now();
  const b = bucket.get(ip);
  if (!b || now - b.t > 60000) { bucket.set(ip, { t: now, n: 1 }); if (bucket.size > 5000) bucket.clear(); return true; }
  b.n++;
  return b.n <= limit;
}

function verifyPassword(user, pass) {
  try {
    const h = crypto.scryptSync(String(pass), ADMIN_SALT, 32, { N: 16384, r: 8, p: 1 });
    const okHash = crypto.timingSafeEqual(h, Buffer.from(ADMIN_HASH, 'hex'));
    const okUser = String(user) === ADMIN_USER;
    return okHash && okUser;
  } catch { return false; }
}

async function isAdmin(req) {
  const tok = String(req.headers['x-admin-token'] || '');
  if (!/^[a-f0-9]{64}$/.test(tok)) return false;
  const [r] = await redis([['GET', 'vv:sess:' + tok]]);
  return r === '1';
}

// ---------------- handlers ----------------
async function getData(req, res) {
  const [all] = await redis([['HGETALL', HASH]]);
  const h = hgetallToObj(all);
  let state = null;
  try { state = h.state ? JSON.parse(h.state) : null; } catch { state = null; }
  const posts = ((state && state.posts) || []).map((p) => {
    const id = String(p.id);
    const v = h['v:' + id] !== undefined ? parseInt(h['v:' + id], 10) : Number(p.views) || 0;
    const l = h['l:' + id] !== undefined ? parseInt(h['l:' + id], 10) : Number(p.likes) || 0;
    return { ...p, views: Math.max(0, v), likes: Math.max(0, l) };
  });
  const body = {
    ok: 1,
    initialized: !!state,
    posts,
    categories: (state && state.categories) || [],
    settings: (state && state.settings) || null,
    stats: {
      adsWatched: Math.max(0, parseInt(h['s:ad'] || '0', 10)),
      videosUnlocked: Math.max(0, parseInt(h['s:unlock'] || '0', 10)),
      totalViews: 0,
      totalLikes: posts.reduce((a, p) => a + p.likes, 0),
    },
    cfg: { bot: process.env.BOT_USERNAME || '' },
  };
  // CDN ৯০ সেকেন্ড ক্যাশ রাখে (ডাটাবেস ডাউন থাকলেও পুরনো কপি দেয়) → হাজার ইউজারেও ফাংশন/ডাটাবেস প্রায় ফাঁকা থাকে
  send(res, 200, body, 'public, max-age=60, s-maxage=90, stale-while-revalidate=900, stale-if-error=86400');
}

async function postEvent(req, res) {
  if (!rateOk(ipOf(req), 1200)) return send(res, 429, { ok: 0 });
  const b = readBody(req);
  const t = String(b.type || '');
  const id = String(b.id || '');
  const cmds = [];
  if (t === 'view' && safeId(id)) cmds.push(['HINCRBY', HASH, 'v:' + id, 1]);
  else if (t === 'like' && safeId(id)) cmds.push(['HINCRBY', HASH, 'l:' + id, 1]);
  else if (t === 'unlike' && safeId(id)) cmds.push(['HINCRBY', HASH, 'l:' + id, -1]);
  else if (t === 'ad') cmds.push(['HINCRBY', HASH, 's:ad', 1]);
  else if (t === 'unlock') cmds.push(['HINCRBY', HASH, 's:unlock', 1]);
  else return send(res, 400, { ok: 0 });
  await redis(cmds);
  send(res, 200, { ok: 1 });
}

async function postLogin(req, res) {
  const ip = ipOf(req);
  const rlKey = 'vv:rl:' + ip.replace(/[^\w.:-]/g, '_');
  const [n] = await redis([['INCR', rlKey], ['EXPIRE', rlKey, 600]]);
  if (Number(n) > 10) return send(res, 429, { ok: 0, error: 'অনেকবার ভুল চেষ্টা হয়েছে। ১০ মিনিট পর আবার চেষ্টা করুন।' });
  const b = readBody(req);
  if (!verifyPassword(b.username, b.password)) return send(res, 401, { ok: 0, error: 'ভুল ইউজারনেম বা পাসওয়ার্ড!' });
  const token = crypto.randomBytes(32).toString('hex');
  await redis([['SET', 'vv:sess:' + token, '1', 'EX', 60 * 60 * 24 * 7], ['DEL', rlKey]]);
  send(res, 200, { ok: 1, token });
}

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

async function postSave(req, res) {
  if (!(await isAdmin(req))) return send(res, 401, { ok: 0, error: 'সেশন শেষ — আবার লগইন করুন' });
  const b = readBody(req);
  if (!Array.isArray(b.posts) || !Array.isArray(b.categories) || typeof b.settings !== 'object' || !b.settings) {
    return send(res, 400, { ok: 0, error: 'bad data' });
  }
  if (b.posts.length > 2000) return send(res, 400, { ok: 0, error: 'too many posts' });

  const posts = b.posts.filter((p) => p && p.id !== undefined && safeId(p.id)).map((p) => {
    const q = { ...p, id: p.id, title: clip(p.title, 300), link: clip(p.link, 2000), image: clip(p.image, 2000) };
    if (!q.code || !safeId(q.code)) q.code = 'v' + String(p.id).replace(/[^\w-]/g, '').slice(0, 30);
    return q;
  });
  const settings = { ...b.settings };
  delete settings.adminUser; // কখনো সেটিংসে অ্যাডমিন ক্রেডেনশিয়াল রাখা হয় না
  delete settings.adminPass;
  const categories = b.categories.filter((c) => typeof c === 'string').slice(0, 200).map((c) => c.slice(0, 80));

  const [all] = await redis([['HGETALL', HASH]]);
  const h = hgetallToObj(all);
  let old = null;
  try { old = h.state ? JSON.parse(h.state) : null; } catch { old = null; }
  const oldIds = new Set(((old && old.posts) || []).map((p) => String(p.id)));
  const newIds = new Set(posts.map((p) => String(p.id)));
  const ov = b.overrides && typeof b.overrides === 'object' ? b.overrides : {};

  const cmds = [['HSET', HASH, 'state', JSON.stringify({ posts, categories, settings, rev: Date.now() })]];
  for (const p of posts) {
    const id = String(p.id);
    const o = ov[id];
    if (o && Number.isFinite(Number(o.views))) cmds.push(['HSET', HASH, 'v:' + id, Math.max(0, Math.floor(Number(o.views)))]);
    else if (h['v:' + id] === undefined) cmds.push(['HSET', HASH, 'v:' + id, Math.max(0, Math.floor(Number(p.views) || 0))]);
    if (o && Number.isFinite(Number(o.likes))) cmds.push(['HSET', HASH, 'l:' + id, Math.max(0, Math.floor(Number(o.likes)))]);
    else if (h['l:' + id] === undefined) cmds.push(['HSET', HASH, 'l:' + id, Math.max(0, Math.floor(Number(p.likes) || 0))]);
  }
  for (const id of oldIds) if (!newIds.has(id)) cmds.push(['HDEL', HASH, 'v:' + id, 'l:' + id]);
  await redis(cmds);
  send(res, 200, { ok: 1 });
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const r = (req.query && req.query.r) || url.searchParams.get('r') || '';
    if (req.method === 'GET' && r === 'data') return await getData(req, res);
    if (req.method === 'POST' && r === 'event') return await postEvent(req, res);
    if (req.method === 'POST' && r === 'login') return await postLogin(req, res);
    if (req.method === 'POST' && r === 'save') return await postSave(req, res);
    send(res, 404, { ok: 0 });
  } catch (e) {
    const msg = String((e && e.message) || e);
    send(res, msg === 'NO_DB' ? 503 : 500, { ok: 0, error: msg === 'NO_DB' ? 'ডাটাবেস কানেক্ট করা হয়নি (Upstash Redis)' : 'server error' });
  }
};
