// 몽글 마을 멀티플레이 서버
// - public/index.html 을 내려주고, /ws 웹소켓으로 같은 채널 사람들의 위치를 주고받아요.
// - 파일이나 DB에 저장하는 데이터는 없어요. 신고·차단 기록만 BAN_FILE 을 정해 두면 파일에 남기고, 아니면 메모리에만 있어요.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const CHANNELS = 10;                                               // 공용 채널 수
const MAX_PER_CHANNEL = Number(process.env.MAX_PER_CHANNEL) || 20; // 채널당 최대 인원 (비공개 채널도 같아요)
const TICK_MS = 100;                                              // 위치 동기화 주기 (초당 10번)
const NEAR = 90;                                                  // 이보다 먼 친구는 초당 2번만 알려 줘요 (어차피 작게 보이거나 안 보여요)
const FAR_EVERY = 5;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 2000;     // 서버 전체 동시 접속 상한 (넘으면 「잠시 뒤에 와 주세요」)
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 10;         // 한 IP에서 동시에 열 수 있는 접속 수 (학교·카페는 IP를 같이 써서 넉넉히)
const CHAR_IDS = new Set(['mongsil', 'tosil', 'haneul', 'leo']);
const PHRASE_COUNT = 5;   // 다섯 번째(메리 크리스마스!)는 크리스마스 선물에서 나와요
const CHAT_MAX = 60;       // 채팅 최대 글자 수
const CHAT_GAP_MS = 700;   // 채팅 최소 간격
const NICK_MAX = 12;       // 닉네임 최대 글자 수
const UFO_CHANCE = process.env.UFO_CHANCE != null ? Number(process.env.UFO_CHANCE) : 0.1;   // 유성우가 내릴 때 UFO가 떨어질 확률

// 비공개 채널: 만든 사람이 받은 6글자 코드를 아는 친구만 들어와요. 아무도 없이 3분이 지나면 사라져요. 헷갈리는 글자(0 O 1 I)는 안 써요
const CODE_LEN = 6, CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PRIVATE = Number(process.env.MAX_PRIVATE) || 300;        // 동시에 열 수 있는 비공개 채널 수
const PRIVATE_KEEP_MS = 3 * 60e3;                                  // 비공개 채널이 비어도 3분은 남겨 둬요 (친구 바꾸기로 잠깐 나갔다 와도 같은 코드로 들어오게)
// 크리스마스 채널: 12월 한 달(한국 시간) 동안만 열려요. 꽉 차면 「크리스마스 2」, 「크리스마스 3」…이 저절로 열려요.
// XMAS=1 이면 기간이 아니어도 열고, XMAS=0 이면 닫아요. 주소에 ?xmas=1 을 붙이면 기간 전에도 미리 들어가 볼 수 있어요
const XMAS_ENV = process.env.XMAS, MAX_XMAS_ROOMS = 60;
const xmasOpen = (now = Date.now()) => XMAS_ENV === '1' ? true : XMAS_ENV === '0' ? false : new Date(now + 9 * 3600e3).getUTCMonth() === 11;
const CODE_MISS_MAX = 12, CODE_MISS_MS = 10 * 60e3;               // 없는 코드를 10분에 12번 넘게 넣으면 잠깐 막아요 (코드 맞히기 방지)

// 관리자: 채팅창에 「/코드」를 치면 관리자 모드가 켜져요. 코드 자체는 저장소에 없고, 해시(지문)만 있어요.
// Render 환경 변수 ADMIN_CODES 에 쉼표로 코드를 더 넣을 수도 있어요.
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const ADMIN_HASHES = new Set([
  'e96756e2c42fe5692519158b8bc546ff3080d8ac9cb4b6e38fd44737251c6eb5',
  'ab06ff9b2049319b47f5fc2acd060f36bb84bdffc416b683cd24dfbb324a0ad2',
  ...String(process.env.ADMIN_CODES || '').split(',').map(s => s.trim()).filter(Boolean).map(sha),
]);
const ADMIN_TRIES = 5;     // 접속 한 번에 틀릴 수 있는 횟수

// 신고: 한 채널에서 서로 다른 사람 3명에게 신고받으면 내보내고 그 기기는 2시간 못 들어와요.
// 같은 기기가 누적 9번 신고받으면 영구 차단이에요.
// - 차단은 기기 단위예요. PC방·학교처럼 IP를 같이 쓰는 곳의 다른 사람은 막히지 않아요
// - 신고한 사람은 IP로 세요. 한 사람이 창을 여러 개 열어 혼자 3번을 채울 수 없게요
const REPORTS_TO_KICK = 3, KICK_BAN_MS = 2 * 3600e3, REPORTS_TO_BAN = 9;
const SNOWMEN_EACH = 3, SNOWMEN_MAX = 40;      // 눈사람: 한 사람이 세울 수 있는 수, 한 채널에 있을 수 있는 수
const bans = new Map();      // 기기 -> 풀리는 시각 (Infinity = 영구)
const strikes = new Map();   // 기기 -> 지금까지 받은 신고 수
const codeMiss = new Map();  // ip -> { n, t }
// BAN_FILE 을 정해 두면(예: /var/lib/mongle/bans.json) 차단과 신고 수를 파일에 남겨서 서버를 다시 켜도 이어져요
const BAN_FILE = process.env.BAN_FILE || '';
if (BAN_FILE) {
  try {
    const d = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    for (const [ip, u] of Object.entries(d.bans || {})) bans.set(ip, u === 'forever' ? Infinity : +u);
    for (const [ip, n] of Object.entries(d.strikes || {})) strikes.set(ip, +n);
    console.log(`차단 기록을 불러왔어요 (차단 ${bans.size}개, 신고받은 기기 ${strikes.size}개)`);
  } catch (e) { if (e.code !== 'ENOENT') console.log('차단 기록을 읽지 못했어요:', e.message); }
}
let banSaveT = null;
function saveBans() {
  if (!BAN_FILE || banSaveT) return;
  banSaveT = setTimeout(() => {
    banSaveT = null;
    const d = { bans: {}, strikes: Object.fromEntries(strikes) };
    for (const [ip, u] of bans) d.bans[ip] = u === Infinity ? 'forever' : u;
    const tmp = BAN_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(d), err => { if (err) return console.log('차단 기록 저장 실패:', err.message); fs.rename(tmp, BAN_FILE, () => {}); });
  }, 2000);
}
function banLeft(dev) {      // 0 = 차단 아님, Infinity = 영구, 그 밖엔 남은 ms
  const until = bans.get(dev); if (!until) return 0;
  if (until !== Infinity && until <= Date.now()) { bans.delete(dev); return 0; }
  return until === Infinity ? Infinity : until - Date.now();
}
// 기기 표: 브라우저마다 서버가 무작위 번호를 하나 주고, 서버만 아는 비밀 열쇠로 서명해요(위조 불가). 개인정보는 없어요.
// 열쇠가 바뀌면 모든 표가 새로 발급돼서 차단도 풀려요. 그래서 DEVICE_SECRET 이나 BAN_FILE 옆 파일(.key)에 열쇠를 남겨 둬요
const DEVICE_KEY = (() => {
  if (process.env.DEVICE_SECRET) return process.env.DEVICE_SECRET;
  if (BAN_FILE) {
    const f = BAN_FILE + '.key';
    try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
    const k = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(f, k, { mode: 0o600 }); } catch (e) { console.log('기기 열쇠를 저장하지 못했어요:', e.message); }
    return k;
  }
  return crypto.randomBytes(32).toString('hex');
})();
const devSig = id => crypto.createHmac('sha256', DEVICE_KEY).update(id).digest('base64url').slice(0, 22);
function checkDevice(tok) {   // 맞는 표면 기기 번호, 아니면 ''
  if (typeof tok !== 'string' || tok.length > 64) return '';
  const [id, sig] = tok.split('.');
  if (!/^[A-Za-z0-9_-]{22}$/.test(id || '') || !sig) return '';
  const a = Buffer.from(sig), b = Buffer.from(devSig(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : '';
}
function newDevice() { const id = crypto.randomBytes(16).toString('base64url'); return { id, tok: id + '.' + devSig(id) }; }
const banMsg = left => ({ t: 'banned', left: left === Infinity ? 0 : Math.ceil(left) });
// Render 같은 호스팅에서는 앞단 프록시가 진짜 주소를 알려 줘요. 내 PC에서 켤 땐 그 머리글을 믿지 않아요 (누구나 꾸며 보낼 수 있어서)
// CF-Connecting-IP 는 Cloudflare가 늘 덮어써서 꾸밀 수 없어요. 없을 때만 X-Forwarded-For 의 첫 주소를 써요
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RENDER;
function clientIp(req) {
  let ip = TRUST_PROXY ? String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  if (!ip) ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

const ADJ = ['말랑한', '폭신한', '졸린', '배고픈', '수줍은', '용감한', '느긋한', '반짝이는', '동글동글한', '콩닥이는',
  '신난', '꼬물꼬물', '달콤한', '포근한', '깡총깡총', '엉뚱한', '조그만', '부지런한', '방긋 웃는', '살금살금'];
const NOUN = ['도토리', '구름', '푸딩', '쿠키', '민들레', '솜사탕', '감자', '당근', '버섯', '다람쥐',
  '고구마', '찹쌀떡', '별사탕', '호빵', '올챙이', '클로버', '눈송이', '마카롱', '떡볶이', '달팽이'];

// 채널(방): 공용 채널 10개는 늘 있고, 비공개 채널은 코드로 만들었다가 아무도 없이 3분이 지나면 사라져요.
// 방마다 UFO·유성우·화면 공유를 따로 가져요. sky: 하늘과 날씨를 어느 공용 채널 것으로 보여 줄지
// theme: 'xmas' 면 크리스마스로 꾸민 마을이에요. xmas: 공용 크리스마스 채널 (번호는 idx + 1)
function makeRoom(pub, idx, code, sky, theme = '') { return { pub, idx, code, sky, theme, xmas: false, players: new Map(), ufo: null, showerEnd: 0, screen: null, tick: 0, snow: [], snowId: 1 }; }
const publicRooms = Array.from({ length: CHANNELS }, (_, i) => makeRoom(true, i, null, i));
const privateRooms = new Map();   // code -> room
const xmasRooms = [];             // 크리스마스 1, 2, 3 … (한번 열리면 비어도 남아 있어요. 비어 있으면 하는 일이 없어 가벼워요)
function xmasRoom() {             // 자리가 남은 첫 크리스마스 채널. 다 찼으면 하나 더 열어요
  for (const r of xmasRooms) if (r.players.size < MAX_PER_CHANNEL) return r;
  if (xmasRooms.length >= MAX_XMAS_ROOMS) return null;
  const r = makeRoom(true, xmasRooms.length, null, 0, 'xmas'); r.xmas = true; xmasRooms.push(r);
  console.log(`크리스마스 ${xmasRooms.length} 채널이 열렸어요`);
  return r;
}
const allRooms = () => [...publicRooms, ...xmasRooms, ...privateRooms.values()];
const label = room => room.xmas ? `크리스마스 ${room.idx + 1}` : room.pub ? `채널 ${room.idx + 1}` : `비공개 ${room.code}`;
function newCode() {
  for (;;) {
    let s = ''; for (let i = 0; i < CODE_LEN; i++) s += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
    if (!privateRooms.has(s)) return s;
  }
}

// 유성우는 채널 모두가 같이 봐요. 한 채널에는 한 번에 하나만, 끝나고 조금 쉰 뒤에 다음 유성우를 부를 수 있어요
const SHOWER_MS = 36000, SHOWER_GAP_MS = 3000;
const SHOUT = '별똥별이다', XMAS_SHOUT = '메리크리스마스';   // 크리스마스 채널에서는 「메리 크리스마스!」도 돼요                                         // 별사탕을 다 모은 사람이 채팅으로 외치면 유성우가 다시 내려요
function callShower(me, why) {
  const now = Date.now(), room = me.room;
  if (now < room.showerEnd) { if (why === 'shout') send(me.ws, { t: 'shower', busy: 1 }); return false; }   // 별사탕을 막 다 모았다면 이미 내리는 유성우를 같이 보면 돼요
  room.showerEnd = now + SHOWER_MS + SHOWER_GAP_MS;
  broadcast(room.players, { t: 'shower', id: me.id, nick: me.nick, why, left: SHOWER_MS });
  console.log(`[${label(room)}] 유성우 (${me.nick}, ${why === 'stars' ? '별사탕 완성' : '외침'})`);
  return true;
}
// 유성우가 내릴 때마다(처음 다 모았을 때도, 외쳤을 때도) 확률을 굴려 UFO를 떨어뜨려요. 이미 박혀 있으면 더 오지 않아요
function rollUfo(me) {
  const room = me.room;
  if (room.ufo || Math.random() >= UFO_CHANCE) return;
  room.ufo = { at: Date.now() };
  broadcast(room.players, { t: 'ufo' });
  console.log(`[${label(room)}] UFO가 광장에 떨어졌어요 (${me.nick})`);
}
// 화면 공유(빔 프로젝터): 채널마다 한 번에 한 명만 허공에 화면을 띄울 수 있어요.
// 비공개 채널에서는 누구나, 공용 채널에서는 관리자만 띄울 수 있어요.
// 영상은 서버를 거치지 않고 사람들끼리 직접 주고받아요(WebRTC). 서버는 누가 어디에 띄웠는지와, 서로 연결하는 데 필요한 신호만 전해 줘요.
const RTC_MAX = 12000;                                             // 연결 신호 하나의 최대 크기 (글자 수)
function endScreen(room, id) {
  if (!room.screen || (id != null && room.screen.id !== id)) return;
  room.screen = null;
  broadcast(room.players, { t: 'screen', off: 1 });
}
let nextId = 1;

function makeNick(players) {
  const used = new Set([...players.values()].map(p => p.nick));
  for (let i = 0; i < 40; i++) {
    const nick = ADJ[Math.random() * ADJ.length | 0] + ' ' + NOUN[Math.random() * NOUN.length | 0];
    if (!used.has(nick)) return nick;
  }
  return NOUN[Math.random() * NOUN.length | 0] + ' ' + (100 + Math.random() * 900 | 0);
}

const INDEX = path.join(__dirname, 'public', 'index.html');
// 게임 페이지(약 600KB)는 미리 압축해 두고(br 약 150KB), 바뀌지 않았으면 「그대로예요(304)」만 보내요
let page = null, pageLoading = null;
function loadPage() {
  if (pageLoading) return pageLoading;
  pageLoading = new Promise((ok, no) => fs.stat(INDEX, (err, st) => {
    if (err) return no(err);
    if (page && page.mtime === st.mtimeMs) return ok(page);
    fs.readFile(INDEX, (e, raw) => {
      if (e) return no(e);
      page = { mtime: st.mtimeMs, raw, etag: '"' + sha(raw).slice(0, 20) + '"',
        gz: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) };
      ok(page);
    });
  })).finally(() => { pageLoading = null; });
  return pageLoading;
}
function servePage(req, res) {
  loadPage().then(pg => {
    const head = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': pg.etag, 'Vary': 'Accept-Encoding' };
    if (req.headers['if-none-match'] === pg.etag) { res.writeHead(304, head); return res.end(); }
    const ae = String(req.headers['accept-encoding'] || '');
    const [body, enc] = /\bbr\b/.test(ae) ? [pg.br, 'br'] : /\bgzip\b/.test(ae) ? [pg.gz, 'gzip'] : [pg.raw, null];
    if (enc) head['Content-Encoding'] = enc;
    head['Content-Length'] = body.length;
    res.writeHead(200, head); res.end(req.method === 'HEAD' ? undefined : body);
    stats.out += body.length;
  }, () => { res.writeHead(500); res.end('index.html not found'); });
}
const stats = { out: 0, outRate: 0, since: Date.now() };   // 내보낸 바이트 (운영 현황용)
// 비행선 전광판: 운영자가 public/airship 폴더에 그림·영상과 playlist.json을 넣어 두면 그대로 내보내요
const AIRSHIP_DIR = path.join(__dirname, 'public', 'airship');
const MIME = { '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function serveAirship(req, res, url) {
  let name; try { name = decodeURIComponent(url.slice('/airship/'.length)); } catch { name = ''; }
  const file = path.resolve(AIRSHIP_DIR, name), type = MIME[path.extname(file).toLowerCase()];
  if (!name || !type || !file.startsWith(AIRSHIP_DIR + path.sep)) { res.writeHead(404); return res.end('not found'); }   // 폴더 밖이나 모르는 종류의 파일은 안 내보내요
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': type.startsWith('application/json') ? 'no-cache' : 'public, max-age=300' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');   // 영상은 중간부터 틀 수 있게 일부분씩 보내 줘요
    if (m && (m[1] || m[2])) {
      let a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/channels') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // now: 날씨 시각을 모두가 똑같이 맞추도록 서버 시계를 알려 줘요. xmas: 크리스마스 채널이 열려 있으면 채널마다 인원
    return res.end(JSON.stringify({ max: MAX_PER_CHANNEL, channels: publicRooms.map(r => r.players.size), xmas: xmasOpen() ? (xmasRooms.length ? xmasRooms.map(r => r.players.size) : [0]) : null, now: Date.now() }));
  }
  if (url === '/api/stats') {   // 운영 현황: 접속자 수와 내보내는 데이터 양 (개인 정보는 없어요)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const n = rs => rs.reduce((a, r) => a + r.players.size, 0);
    return res.end(JSON.stringify({ players: wss.clients.size, public: publicRooms.map(r => r.players.size), xmas: xmasRooms.map(r => r.players.size), private: { rooms: privateRooms.size, players: n([...privateRooms.values()]) },
      outKBps: Math.round(stats.outRate / 1024), outMBTotal: Math.round(stats.out / 1048576), upMin: Math.round((Date.now() - stats.since) / 60000), bans: bans.size, mem: Math.round(process.memoryUsage().rss / 1048576) }));
  }
  if (url.startsWith('/airship/')) return serveAirship(req, res, url);
  if (url === '/' || url === '/index.html') return servePage(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const out = (ws, data) => { if (ws.readyState !== 1) return; ws.send(data); stats.out += data.length || data.byteLength || 0; };
const send = (ws, obj) => out(ws, JSON.stringify(obj));
const broadcast = (players, obj, except) => { const s = JSON.stringify(obj); for (const p of players.values()) if (p !== except) out(p.ws, s); };
const info = p => ({ id: p.id, nick: p.nick, char: p.char, s: p.s, look: p.look });
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : 0;
const r2 = v => Math.round(v * 100) / 100;
// 제어 문자와 방향 바꾸는 보이지 않는 문자를 지우고 공백을 하나로 모아요
const clean = (v, max) => typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim() : '';

// 신고가 쌓인 사람을 내보내요. 연결을 끊으면 'close'에서 방 정리를 해요
function kick(p, left) {
  send(p.ws, { t: 'kicked', left: left === Infinity ? 0 : Math.ceil(left) });
  p.ws.close(4003, 'kicked');
  setTimeout(() => p.ws.terminate(), 3000);
}
function report(me, m) {
  const to = me.room.players.get(m.id);
  if (!to || to === me) return;
  if (to.reportedBy.has(me.ip)) return send(me.ws, { t: 'report', dup: 1, nick: to.nick });   // 한 사람(IP)이 같은 친구를 여러 번 신고해도 한 번만 세요
  to.reportedBy.add(me.ip);
  send(me.ws, { t: 'report', ok: 1, nick: to.nick });
  if (to.admin) return;                                             // 관리자는 내보내지지 않아요
  to.hits++;
  const total = (strikes.get(to.dev) || 0) + 1; strikes.set(to.dev, total); saveBans();
  console.log(`[${label(me.room)}] ${to.nick} 신고됨 (이번 접속 ${to.hits}/${REPORTS_TO_KICK}, 누적 ${total}/${REPORTS_TO_BAN})`);
  if (total >= REPORTS_TO_BAN) {
    bans.set(to.dev, Infinity); saveBans();
    console.log(`[${label(me.room)}] ${to.nick} 영구 차단`);
    for (const room of allRooms()) for (const p of room.players.values()) if (p.dev === to.dev) kick(p, Infinity);   // 같은 기기로 열어 둔 다른 창도 모두 내보내요
  } else if (to.hits >= REPORTS_TO_KICK) {
    bans.set(to.dev, Math.max(bans.get(to.dev) || 0, Date.now() + KICK_BAN_MS)); saveBans();
    for (const room of allRooms()) for (const p of room.players.values()) if (p.dev === to.dev && p !== to) kick(p, KICK_BAN_MS);
    console.log(`[${label(me.room)}] ${to.nick} 강제 퇴장 (2시간 차단)`);
    kick(to, KICK_BAN_MS);
  }
}

const perIp = new Map();   // ip -> 지금 열려 있는 접속 수
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });   // 화면 공유 연결 신호(SDP)는 몇 KB쯤 돼요
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const ip = clientIp(req);
  if (wss.clients.size > MAX_PLAYERS) { send(ws, { t: 'busy' }); return ws.close(); }
  const nIp = (perIp.get(ip) || 0) + 1;
  if (nIp > MAX_PER_IP) { send(ws, { t: 'busy', ip: 1 }); return ws.close(); }
  perIp.set(ip, nIp);
  ws.on('close', () => { const k = (perIp.get(ip) || 1) - 1; if (k > 0) perIp.set(ip, k); else perIp.delete(ip); });
  let me = null, budget = 40, last = Date.now();

  ws.on('message', raw => {
    // 초당 40개까지만 받아요 (토큰 버킷)
    const now = Date.now(); budget = Math.min(40, budget + (now - last) * 0.04); last = now;
    if (budget < 1) return; budget--;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!me) {
      if (m.t !== 'join') return;
      if (!CHAR_IDS.has(m.char)) return ws.close();
      // 기기 표 확인: 없거나 틀리면 새로 주고, 차단된 기기면 못 들어와요
      let dev = checkDevice(m.dev), devTok = '';
      if (!dev) { const d = newDevice(); dev = d.id; devTok = d.tok; }
      { const left = banLeft(dev); if (left) { send(ws, banMsg(left)); return ws.close(); } }
      // 어느 방에 들어갈지: 공용 채널 번호(ch), 새 비공개 채널(make), 비공개 채널 코드(code)
      let room = null, made = false;
      const xmasOk = xmasOpen() || m.preview === 1;                 // 미리보기(?xmas=1)는 기간 전에도 들어갈 수 있어요
      if (m.make === 1) {
        if (privateRooms.size >= MAX_PRIVATE) { send(ws, { t: 'full', rooms: 1 }); return ws.close(); }
        const sky = Number.isInteger(m.sky) && m.sky >= 0 && m.sky < CHANNELS ? m.sky : 0;
        room = makeRoom(false, -1, newCode(), sky, m.xmas === 1 && xmasOk ? 'xmas' : ''); made = true;
      } else if (m.xmas === 1) {
        if (!xmasOk) { send(ws, { t: 'closed' }); return ws.close(); }
        room = xmasRoom();
        if (!room) { send(ws, { t: 'full' }); return ws.close(); }
      } else if (typeof m.code === 'string') {
        const miss = codeMiss.get(ip);
        if (miss && now - miss.t < CODE_MISS_MS && miss.n >= CODE_MISS_MAX) { send(ws, { t: 'nocode', slow: 1 }); return ws.close(); }
        room = privateRooms.get(m.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN));
        if (!room) {
          if (!miss || now - miss.t >= CODE_MISS_MS) codeMiss.set(ip, { n: 1, t: now }); else miss.n++;
          send(ws, { t: 'nocode' }); return ws.close();
        }
      } else {
        const ch = Number.isInteger(m.ch) ? m.ch : -1;
        if (ch < 0 || ch >= CHANNELS) return ws.close();
        room = publicRooms[ch];
      }
      const players = room.players;
      if (players.size >= MAX_PER_CHANNEL) { send(ws, { t: 'full' }); return ws.close(); }
      // 닉네임: 들어올 때 고른 이름을 이번 접속 동안만 써요 (비어 있으면 랜덤). 같은 채널에 같은 이름은 안 돼요.
      const want = clean(m.nick, NICK_MAX);
      if (want && [...players.values()].some(p => p.nick === want)) { send(ws, { t: 'taken' }); return ws.close(); }
      if (made) privateRooms.set(room.code, room);
      me = { id: nextId++, ws, ip, dev, room, char: m.char, nick: want || makeNick(players), s: [6, 0, 22, 0, 0, 1, 0], ver: 1, seen: new Map(), lastChat: 0, admin: false, adminTries: 0, reportedBy: new Set(), hits: 0 };
      if (m.stars === true) me.starsDone = true;   // 다른 채널에서 이미 별사탕을 다 모았어요: 외치기는 되지만 첫 유성우·UFO는 다시 굴리지 않아요
      players.set(me.id, me);
      send(ws, { t: 'welcome', dev: devTok || undefined, id: me.id, nick: me.nick, ch: room.pub && !room.xmas ? room.idx : -1, code: room.code, xmas: room.xmas ? room.idx + 1 : 0, theme: room.theme, made: made ? 1 : 0, sky: room.sky, max: MAX_PER_CHANNEL, now: Date.now(), ufo: room.ufo ? 1 : 0, shower: Math.max(0, room.showerEnd - SHOWER_GAP_MS - Date.now()), screen: room.screen, snow: room.snow, players: [...players.values()].filter(p => p !== me).map(info) });
      broadcast(players, { t: 'join', ...info(me) }, me);
      console.log(`[${label(room)}] ${me.nick} ${made ? '비공개 채널을 만들고 ' : ''}입장 (${players.size}/${MAX_PER_CHANNEL})`);
      return;
    }
    const room = me.room;
    if (m.t === 's') {
      // x reaches ~1400 inside grandpa tree (indoor spaces sit east of the map), y up to the treetop terrace
      // 7th value: sitting on the cabin sofa (so others see the seat taken). ver goes up only when something changed
      const old = me.s;
      me.s = [r2(num(m.x, -2000, 2000)), r2(num(m.y, -50, 150)), r2(num(m.z, -2000, 2000)), r2(num(m.yaw, -50, 50)), r2(num(m.sp, 0, 20)), m.g ? 1 : 0, m.sit ? 1 : 0];
      if (me.s.some((v, i) => v !== old[i])) me.ver++;
    } else if (m.t === 'e') {
      const k = Number.isInteger(m.k) ? m.k : -1;
      if (k >= 0 && k < PHRASE_COUNT) broadcast(room.players, { t: 'e', id: me.id, k }, me);
    } else if (m.t === 'stars') {
      // 별사탕을 다 모았어요: 접속마다 한 번만, 서버가 확률을 굴려 채널 모두에게 UFO를 떨어뜨려요
      if (me.starsDone) return; me.starsDone = true;
      callShower(me, 'stars');
      rollUfo(me);
    } else if (m.t === 'screen') {
      // 화면 공유 시작/끝: 공용 채널은 관리자만, 이미 다른 사람이 띄우고 있으면 못 띄워요
      if (m.off) return endScreen(room, me.id);
      if ((room.pub || m.bb) && !me.admin) return send(ws, { t: 'screen', locked: 1 });   // 광장 대형 전광판(bb)은 어느 채널이든 관리자만 띄워요
      const cur = room.screen;
      if (cur && cur.id !== me.id) return send(ws, { t: 'screen', busy: 1, nick: cur.nick });
      room.screen = { id: me.id, nick: me.nick, x: r2(num(m.x, -2000, 2000)), y: r2(num(m.y, -50, 150)), z: r2(num(m.z, -2000, 2000)), yaw: r2(num(m.yaw, -50, 50)), k: 1, bb: m.bb ? 1 : 0 };
      broadcast(room.players, { t: 'screen', ...room.screen });
      console.log(`[${label(room)}] ${me.nick} 화면 공유 시작`);
    } else if (m.t === 'scr') {
      // 화면 크기: 띄운 사람만 바꿀 수 있어요 (0.6배~4배)
      const cur = room.screen;
      if (!cur || cur.id !== me.id || typeof m.k !== 'number' || !Number.isFinite(m.k)) return;
      cur.k = r2(Math.max(0.6, Math.min(4, m.k)));
      broadcast(room.players, { t: 'scr', k: cur.k });
    } else if (m.t === 'rtc') {
      // 연결 신호 전달: 화면을 띄운 사람과 보는 사람 사이에서만, 내용은 들여다보지 않고 그대로 건네요
      const cur = room.screen, to = room.players.get(m.to);
      if (!cur || !to || to === me || (cur.id !== me.id && cur.id !== to.id)) return;
      if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;
      let size = 0; try { size = JSON.stringify(m.d).length; } catch { return; }
      if (size > RTC_MAX) return;
      send(to.ws, { t: 'rtc', from: me.id, d: m.d });
    } else if (m.t === 'admin') {
      // 관리자 코드: 채팅으로는 보내지 않고 서버만 확인해요. 접속 한 번에 5번까지 틀릴 수 있어요
      if (me.admin) return send(ws, { t: 'admin', ok: 1 });
      if (me.adminTries >= ADMIN_TRIES || typeof m.code !== 'string' || m.code.length > 64) return send(ws, { t: 'admin', ok: 0 });
      me.adminTries++;
      if (!ADMIN_HASHES.has(sha(m.code.trim()))) return send(ws, { t: 'admin', ok: 0 });
      me.admin = true;
      send(ws, { t: 'admin', ok: 1 });
      console.log(`[${label(room)}] ${me.nick} 관리자 모드`);
    } else if (m.t === 'look') {
      // 크리스마스 꾸미기 (산타 모자, 순록 뿔, 반짝이 발자국): 켜고 끄는 값만 받아서 같은 채널에 알려요
      const look = { h: m.h ? 1 : 0, a: m.a ? 1 : 0, f: m.f ? 1 : 0 };
      me.look = look; broadcast(room.players, { t: 'look', id: me.id, look }, me);
    } else if (m.t === 'fx') {
      // 폭죽: 1초에 한 번까지
      if (m.k !== 'fw' || now - (me.lastFx || 0) < 1000) return; me.lastFx = now;
      broadcast(room.players, { t: 'fx', id: me.id, k: 'fw' }, me);
    } else if (m.t === 'ball') {
      // 눈덩이: 던진 자리와 빠르기만 같은 채널에 전해요. 0.4초에 한 번까지
      if (room.theme !== 'xmas' || now - (me.lastBall || 0) < 400) return; me.lastBall = now;
      broadcast(room.players, { t: 'ball', id: me.id, x: r2(num(m.x, -2000, 2000)), y: r2(num(m.y, -50, 150)), z: r2(num(m.z, -2000, 2000)), vx: r2(num(m.vx, -40, 40)), vy: r2(num(m.vy, -40, 40)), vz: r2(num(m.vz, -40, 40)) }, me);
    } else if (m.t === 'snowman') {
      // 눈사람: 크리스마스 채널에서만, 2.5초에 하나. 한 사람이 3개, 채널에 40개까지 (넘으면 오래된 것부터 녹아요). 채널이 비면 모두 사라져요
      if (room.theme !== 'xmas' || now - (me.lastSnow || 0) < 2500) return; me.lastSnow = now;
      const melt = i => { const [g] = room.snow.splice(i, 1); broadcast(room.players, { t: 'snowgone', id: g.id }); };
      const mine = room.snow.filter(g => g.by === me.id);
      if (mine.length >= SNOWMEN_EACH) melt(room.snow.indexOf(mine[0]));
      if (room.snow.length >= SNOWMEN_MAX) melt(0);
      const sm = { id: room.snowId++, by: me.id, x: r2(num(m.x, -2000, 2000)), z: r2(num(m.z, -2000, 2000)), yaw: r2(num(m.yaw, -50, 50)), v: Math.floor(num(m.v, 0, 1e6)) };
      room.snow.push(sm); broadcast(room.players, { t: 'snowman', s: sm });
    } else if (m.t === 'ufoBye') {
      // 크리스마스의 길 잃은 순록: 누군가 말을 걸면 썰매로 돌아가요 (모두에게서 사라져요)
      if (room.theme !== 'xmas' || !room.ufo) return;
      room.ufo = null; broadcast(room.players, { t: 'ufo', bye: 1, id: me.id, nick: me.nick });
    } else if (m.t === 'report') {
      report(me, m);
    } else if (m.t === 'c') {
      // 채팅: 0.7초에 한 번, 60자까지. 내용은 저장하지 않아요.
      if (typeof m.text !== 'string' || now - me.lastChat < CHAT_GAP_MS) return;
      const text = clean(m.text, CHAT_MAX);
      if (!text || text.startsWith('/')) return;                    // 「/」로 시작하는 건 명령이라 채팅으로 퍼뜨리지 않아요
      me.lastChat = now;
      broadcast(room.players, { t: 'c', id: me.id, text }, me);
      const said = text.replace(/[\s!~.?,…]+/g, '');
      if (me.starsDone && (said === SHOUT || (room.theme === 'xmas' && said === XMAS_SHOUT)) && callShower(me, 'shout')) rollUfo(me);
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = me.room, players = room.players;
    players.delete(me.id);
    for (const p of players.values()) p.seen.delete(me.id);
    endScreen(room, me.id);                                          // 화면을 띄운 사람이 나가면 화면도 꺼져요
    if (players.size === 0) {
      room.ufo = null; room.showerEnd = 0; room.screen = null;       // 채널이 비면 UFO도 유성우도 사라져요
      room.snow = [];                                                // 눈사람도 녹아요
      if (!room.pub) room.emptyAt = Date.now();                      // 비공개 채널은 아무도 없이 3분이 지나면 없어져요
    }
    broadcast(players, { t: 'leave', id: me.id });
    console.log(`[${label(room)}] ${me.nick} 퇴장 (${players.size}/${MAX_PER_CHANNEL})`);
  });
});

// 채널마다 친구들의 위치를 보내요. 짧은 이진 형식으로, 지난번 뒤로 움직인 친구만, 멀리 있는 친구는 초당 2번만 보내요.
// 한 명당 20바이트: id(u32) x y z(f32) 방향(i16, ×600) 빠르기(u8, ×12) 상태(u8: 1 땅에 있음, 2 앉음)
const SNAP_REC = 20, snapBuf = Buffer.alloc(1 + SNAP_REC * 256);
setInterval(() => {
  for (const room of allRooms()) {
    if (room.players.size < 2) continue;
    const farTick = room.tick++ % FAR_EVERY === 0, list = [...room.players.values()];
    for (const me of list) {
      if (me.ws.readyState !== 1) continue;
      let n = 0;
      for (const p of list) {
        if (p === me || me.seen.get(p.id) === p.ver) continue;
        if (!farTick && Math.abs(p.s[0] - me.s[0]) + Math.abs(p.s[2] - me.s[2]) > NEAR) continue;
        me.seen.set(p.id, p.ver);
        const o = 1 + n++ * SNAP_REC, s = p.s;
        snapBuf.writeUInt32LE(p.id, o); snapBuf.writeFloatLE(s[0], o + 4); snapBuf.writeFloatLE(s[1], o + 8); snapBuf.writeFloatLE(s[2], o + 12);
        snapBuf.writeInt16LE(Math.round(s[3] * 600), o + 16); snapBuf.writeUInt8(Math.min(255, Math.round(s[4] * 12)), o + 18); snapBuf.writeUInt8(s[5] | (s[6] << 1), o + 19);
      }
      if (!n) continue;
      snapBuf[0] = 1;   // 1 = 위치 묶음
      out(me.ws, Buffer.from(snapBuf.subarray(0, 1 + n * SNAP_REC)));
    }
  }
}, TICK_MS);
// 초당 내보내는 양 (운영 현황용)
{ let last = 0; setInterval(() => { stats.outRate = (stats.out - last) / 5; last = stats.out; }, 5000); }

// 응답 없는 연결 정리, 기한이 지난 차단 풀기
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  { const n = bans.size; for (const d of bans.keys()) banLeft(d); if (bans.size !== n) saveBans(); }
  const now = Date.now();
  for (const [ip, v] of codeMiss) if (now - v.t >= CODE_MISS_MS) codeMiss.delete(ip);
  for (const [code, room] of privateRooms) if (room.players.size === 0 && now - room.emptyAt >= PRIVATE_KEEP_MS) privateRooms.delete(code);
}, 15000);

const HOST = process.env.HOST || '0.0.0.0';   // Cloudflare Tunnel 뒤에 둘 땐 127.0.0.1 (바깥에서 서버로 바로 못 들어오게)
server.listen(PORT, HOST, () => {
  console.log(`몽글 마을 서버가 켜졌어요 (공용 채널 ${CHANNELS}개, 채널당 최대 ${MAX_PER_CHANNEL}명)`);
  console.log(`  이 PC에서:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  같은 와이파이에서: http://${a.address}:${PORT}`);
  }
});
