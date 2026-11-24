// سرور چت عمومی ضرب‌المثل‌یار
// متغیرهای محیطی (در Render > Environment):
//   CHAT_PASSWORD   (الزامی)  رمز ورود به چت
//   ADMIN_PASSWORD  (اختیاری) اگر با این رمز وارد شوید «مدیر» می‌شوید: /kick نام ، /ban نام ، /clear
//   ALLOWED_ORIGINS (اختیاری) آدرس‌های مجاز، با کاما جدا؛ برای اجازه به همه بنویسید *  . پیش‌فرض: https://mojtaba5496.github.io
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mojtaba5496.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_HISTORY = 50;
const MAX_TEXT = 300;

if (!CHAT_PASSWORD) { console.error('CHAT_PASSWORD تنظیم نشده است.'); process.exit(1); }

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ===== کوییز روزانه: جدول برترین‌های امروز (فقط در حافظه) =====
const IRAN_OFFSET = 3.5 * 3600 * 1000;
const dayNow = () => Math.floor((Date.now() + IRAN_OFFSET) / 86400000);
let quizDay = dayNow();
const quizScores = new Map();   // کلید اسم → { name, dev, score, time, ts }
const quizDevs = new Map();     // دستگاه → کلید اسم
const nameKey = (s) => String(s).toLowerCase();
const apiHits = new Map();      // ip → زمان‌های درخواست

function rollDay() {
  const d = dayNow();
  if (d !== quizDay) { quizDay = d; quizScores.clear(); quizDevs.clear(); }
}
function sendJSON(req, res, code, obj) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : (origin && ORIGINS.includes(origin) ? origin : '');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (allow) { h['Access-Control-Allow-Origin'] = allow; h['Vary'] = 'Origin'; }
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2048) { req.destroy(); } });
  req.on('end', () => { try { cb(JSON.parse(data || '{}')); } catch (e) { cb(null); } });
}
function topList() {
  return [...quizScores.values()]
    .sort((a, b) => b.score - a.score || a.time - b.time || a.ts - b.ts)
    .slice(0, 20)
    .map((e) => ({ name: e.name, score: e.score, time: e.time }));
}

function handleQuiz(req, res, url) {
  const ip = ipOf(req);
  const now = Date.now();
  const hits = (apiHits.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now); apiHits.set(ip, hits);
  if (hits.length > 60) return sendJSON(req, res, 429, { ok: false, error: 'rate' });
  rollDay();

  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    const allow = ORIGINS.includes('*') ? '*' : (origin && ORIGINS.includes(origin) ? origin : '');
    const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
    if (allow) h['Access-Control-Allow-Origin'] = allow;
    res.writeHead(204, h); return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/quiz/top') {
    return sendJSON(req, res, 200, { ok: true, day: quizDay, total: quizScores.size, entries: topList() });
  }

  if (req.method === 'GET' && url.pathname === '/quiz/check') {
    const name = cleanName(url.searchParams.get('name'));
    const dev = String(url.searchParams.get('dev') || '').slice(0, 64);
    if (name.length < 2) return sendJSON(req, res, 200, { ok: false, reason: 'name' });
    const mine = quizDevs.get(dev);
    if (mine) { const e = quizScores.get(mine); return sendJSON(req, res, 200, { ok: true, played: true, score: e.score, name: e.name }); }
    const taken = quizScores.get(nameKey(name));
    if (taken && taken.dev !== dev) return sendJSON(req, res, 200, { ok: false, reason: 'taken' });
    return sendJSON(req, res, 200, { ok: true, played: false, day: quizDay });
  }

  if (req.method === 'POST' && url.pathname === '/quiz/score') {
    return readBody(req, (d) => {
      if (!d) return sendJSON(req, res, 400, { ok: false, error: 'bad' });
      const name = cleanName(d.name);
      const dev = String(d.dev || '').slice(0, 64);
      const score = Math.floor(Number(d.score));
      const time = Math.max(0, Math.min(200000, Math.floor(Number(d.time) || 0)));
      if (name.length < 2 || !dev || !(score >= 0 && score <= 10)) return sendJSON(req, res, 400, { ok: false, error: 'bad' });
      if (Number(d.day) !== quizDay) return sendJSON(req, res, 409, { ok: false, error: 'day' });
      if (quizDevs.has(dev)) return sendJSON(req, res, 200, { ok: true, already: true });
      const k = nameKey(name);
      const taken = quizScores.get(k);
      if (taken && taken.dev !== dev) return sendJSON(req, res, 409, { ok: false, error: 'taken' });
      if (quizScores.size >= 1000) return sendJSON(req, res, 503, { ok: false, error: 'full' });
      quizScores.set(k, { name, dev, score, time, ts: now });
      quizDevs.set(dev, k);
      const rank = [...quizScores.values()].filter((e) => e.score > score || (e.score === score && e.time < time)).length + 1;
      return sendJSON(req, res, 200, { ok: true, rank });
    });
  }

  if (req.method === 'POST' && url.pathname === '/quiz/remove') {
    return readBody(req, (d) => {
      if (!d || !ADMIN_PASSWORD || !same(d.password, ADMIN_PASSWORD)) return sendJSON(req, res, 403, { ok: false });
      const k = nameKey(cleanName(d.name));
      const e = quizScores.get(k);
      if (e) { quizScores.delete(k); quizDevs.delete(e.dev); }
      return sendJSON(req, res, 200, { ok: !!e });
    });
  }
  return sendJSON(req, res, 404, { ok: false });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/quiz/')) return handleQuiz(req, res, url);
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 2048,
  verifyClient: ({ origin }, done) => {
    // برنامه‌ی TWA و GitHub Pages با همین origin می‌آیند
    const ok = !origin || ORIGINS.includes('*') || ORIGINS.includes(origin);
    console.log('connection attempt, origin =', origin, ok ? '(allowed)' : '(REJECTED)');
    if (ok) return done(true);
    done(false, 403, 'Forbidden');
  }
});

const history = [];
const failed = new Map();      // ip -> {count, until}
const banned = new Set();      // ip
const clients = new Set();     // ws های واردشده

const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => clients.forEach(c => send(c, obj));
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f‎‏‪-‮<>]/g, '').trim().slice(0, 20);
const cleanText = (s) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_TEXT);
const onlineCount = () => broadcast({ type: 'online', count: clients.size });

function addMessage(m) {
  history.push(m);
  while (history.length > MAX_HISTORY) history.shift();
  broadcast({ type: 'msg', ...m });
}

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.joined = false;
  ws.stamps = [];

  if (banned.has(ip)) { send(ws, { type: 'error', code: 'banned', message: 'دسترسی شما به چت بسته شده است.' }); return ws.close(); }

  // اگر تا ۱۰ ثانیه وارد نشد، قطع شود
  const joinTimer = setTimeout(() => { if (!ws.joined) ws.close(); }, 10000);

  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }
    if (!d || typeof d !== 'object') return;

    if (d.type === 'join') {
      if (ws.joined) return;
      const f = failed.get(ip);
      if (f && f.until > Date.now()) {
        return send(ws, { type: 'error', code: 'locked', message: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کن.' });
      }
      const name = cleanName(d.name);
      if (name.length < 2) return send(ws, { type: 'error', code: 'name', message: 'اسم باید حداقل ۲ حرف باشد.' });

      const isAdmin = ADMIN_PASSWORD && same(d.password, ADMIN_PASSWORD);
      const ok = isAdmin || same(d.password, CHAT_PASSWORD);
      if (!ok) {
        const c = (f && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1;
        failed.set(ip, { count: c, until: c >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
        return send(ws, { type: 'error', code: 'password', message: 'رمز اشتباه است.' });
      }
      failed.delete(ip);

      for (const c of clients) {
        if (c.name === name) return send(ws, { type: 'error', code: 'name', message: 'این اسم الان در چت هست. اسم دیگری انتخاب کن.' });
      }

      clearTimeout(joinTimer);
      ws.joined = true; ws.name = name; ws.admin = !!isAdmin; ws.ip = ip;
      clients.add(ws);
      send(ws, { type: 'joined', name, admin: ws.admin, history });
      addMessage({ system: true, text: `${name} وارد چت شد`, ts: Date.now() });
      onlineCount();
      return;
    }

    if (!ws.joined || d.type !== 'msg') return;

    // محدودیت سرعت: حداکثر ۵ پیام در ۱۰ ثانیه
    const now = Date.now();
    ws.stamps = ws.stamps.filter(t => now - t < 10000);
    if (ws.stamps.length >= 5) return send(ws, { type: 'error', code: 'rate', message: 'کمی آهسته‌تر بنویس.' });
    ws.stamps.push(now);

    const text = cleanText(d.text);
    if (!text) return;

    // دستورهای مدیر
    if (ws.admin && text.startsWith('/')) {
      const [cmd, ...rest] = text.split(' ');
      const target = cleanName(rest.join(' '));
      if (cmd === '/clear') { history.length = 0; broadcast({ type: 'cleared' }); return; }
      if (cmd === '/kick' || cmd === '/ban') {
        let hit = false;
        for (const c of [...clients]) {
          if (c.name === target && c !== ws) {
            hit = true;
            if (cmd === '/ban') banned.add(c.ip);
            send(c, { type: 'error', code: 'banned', message: cmd === '/ban' ? 'دسترسی شما به چت بسته شد.' : 'از چت خارج شدی.' });
            c.close();
          }
        }
        return send(ws, { type: 'notice', text: hit ? `${target} ${cmd === '/ban' ? 'بن' : 'اخراج'} شد.` : 'کاربری با این اسم نیست.' });
      }
      return send(ws, { type: 'notice', text: 'دستورها: /kick نام ، /ban نام ، /clear' });
    }

    addMessage({ name: ws.name, admin: ws.admin, text, ts: now });
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (ws.joined) {
      clients.delete(ws);
      onlineCount();
    }
  });
  ws.on('error', () => {});
});

// قطع اتصال‌های مرده
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('chat server on', PORT));
