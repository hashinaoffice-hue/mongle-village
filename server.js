// 몽글 마을 멀티플레이 서버
// - public/index.html 을 내려주고, /ws 웹소켓으로 같은 채널 사람들의 위치를 주고받아요.
// - 파일이나 DB에 저장하는 데이터는 없어요. 신고·차단 기록도 메모리에만 있어서 서버가 꺼지거나 잠들면 모두 사라져요.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const CHANNELS = 10;                                               // 공용 채널 수
const MAX_PER_CHANNEL = Number(process.env.MAX_PER_CHANNEL) || 20; // 채널당 최대 인원 (비공개 채널도 같아요)
const TICK_MS = 100;                                              // 위치 동기화 주기 (초당 10번)
const CHAR_IDS = new Set(['mongsil', 'tosil', 'haneul', 'leo']);
const PHRASE_COUNT = 4;
const CHAT_MAX = 60;       // 채팅 최대 글자 수
const CHAT_GAP_MS = 700;   // 채팅 최소 간격
const NICK_MAX = 12;       // 닉네임 최대 글자 수
const UFO_CHANCE = process.env.UFO_CHANCE != null ? Number(process.env.UFO_CHANCE) : 0.1;   // 유성우가 내릴 때 UFO가 떨어질 확률

// 비공개 채널: 만든 사람이 받은 6글자 코드를 아는 친구만 들어와요. 아무도 없이 3분이 지나면 사라져요. 헷갈리는 글자(0 O 1 I)는 안 써요
const CODE_LEN = 6, CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PRIVATE = Number(process.env.MAX_PRIVATE) || 300;        // 동시에 열 수 있는 비공개 채널 수
const PRIVATE_KEEP_MS = 3 * 60e3;                                  // 비공개 채널이 비어도 3분은 남겨 둬요 (친구 바꾸기로 잠깐 나갔다 와도 같은 코드로 들어오게)
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

// 신고: 한 채널에서 서로 다른 사람(IP) 3명에게 신고받으면 내보내고 그 IP는 2시간 못 들어와요.
// 같은 IP가 누적 9번 신고받으면 영구 차단이에요. (메모리에만 있어서 서버가 다시 켜지면 초기화돼요)
const REPORTS_TO_KICK = 3, KICK_BAN_MS = 2 * 3600e3, REPORTS_TO_BAN = 9;
const bans = new Map();      // ip -> 풀리는 시각 (Infinity = 영구)
const strikes = new Map();   // ip -> 지금까지 받은 신고 수
const codeMiss = new Map();  // ip -> { n, t }
function banLeft(ip) {       // 0 = 차단 아님, Infinity = 영구, 그 밖엔 남은 ms
  const until = bans.get(ip); if (!until) return 0;
  if (until !== Infinity && until <= Date.now()) { bans.delete(ip); return 0; }
  return until === Infinity ? Infinity : until - Date.now();
}
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
function makeRoom(pub, idx, code, sky) { return { pub, idx, code, sky, players: new Map(), ufo: null, showerEnd: 0, screen: null }; }
const publicRooms = Array.from({ length: CHANNELS }, (_, i) => makeRoom(true, i, null, i));
const privateRooms = new Map();   // code -> room
const allRooms = () => [...publicRooms, ...privateRooms.values()];
const label = room => room.pub ? `채널 ${room.idx + 1}` : `비공개 ${room.code}`;
function newCode() {
  for (;;) {
    let s = ''; for (let i = 0; i < CODE_LEN; i++) s += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
    if (!privateRooms.has(s)) return s;
  }
}

// 유성우는 채널 모두가 같이 봐요. 한 채널에는 한 번에 하나만, 끝나고 조금 쉰 뒤에 다음 유성우를 부를 수 있어요
const SHOWER_MS = 36000, SHOWER_GAP_MS = 3000;
const SHOUT = '별똥별이다';                                         // 별사탕을 다 모은 사람이 채팅으로 외치면 유성우가 다시 내려요
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
    return res.end(JSON.stringify({ max: MAX_PER_CHANNEL, channels: publicRooms.map(r => r.players.size), now: Date.now() }));   // now: 날씨 시각을 모두가 똑같이 맞추도록 서버 시계를 알려 줘요
  }
  if (url.startsWith('/airship/')) return serveAirship(req, res, url);
  if (url === '/' || url === '/index.html') {
    return fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (players, obj, except) => { const s = JSON.stringify(obj); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const info = p => ({ id: p.id, nick: p.nick, char: p.char, s: p.s });
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
  if (to.admin || to.ip === me.ip) return;                         // 관리자는 내보내지지 않아요. 같은 인터넷(IP)끼리의 신고는 세지 않아요
  to.hits++;
  const total = (strikes.get(to.ip) || 0) + 1; strikes.set(to.ip, total);
  console.log(`[${label(me.room)}] ${to.nick} 신고됨 (이번 접속 ${to.hits}/${REPORTS_TO_KICK}, 누적 ${total}/${REPORTS_TO_BAN})`);
  if (total >= REPORTS_TO_BAN) {
    bans.set(to.ip, Infinity);
    console.log(`[${label(me.room)}] ${to.nick} 영구 차단`);
    for (const room of allRooms()) for (const p of room.players.values()) if (p.ip === to.ip) kick(p, Infinity);   // 같은 IP로 들어와 있는 접속도 모두 내보내요
  } else if (to.hits >= REPORTS_TO_KICK) {
    bans.set(to.ip, Math.max(bans.get(to.ip) || 0, Date.now() + KICK_BAN_MS));
    console.log(`[${label(me.room)}] ${to.nick} 강제 퇴장 (2시간 차단)`);
    kick(to, KICK_BAN_MS);
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });   // 화면 공유 연결 신호(SDP)는 몇 KB쯤 돼요
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const ip = clientIp(req);
  { const left = banLeft(ip); if (left) { send(ws, banMsg(left)); return ws.close(); } }
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
      { const left = banLeft(ip); if (left) { send(ws, banMsg(left)); return ws.close(); } }
      // 어느 방에 들어갈지: 공용 채널 번호(ch), 새 비공개 채널(make), 비공개 채널 코드(code)
      let room = null, made = false;
      if (m.make === 1) {
        if (privateRooms.size >= MAX_PRIVATE) { send(ws, { t: 'full', rooms: 1 }); return ws.close(); }
        const sky = Number.isInteger(m.sky) && m.sky >= 0 && m.sky < CHANNELS ? m.sky : 0;
        room = makeRoom(false, -1, newCode(), sky); made = true;
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
      me = { id: nextId++, ws, ip, room, char: m.char, nick: want || makeNick(players), s: [6, 0, 22, 0, 0, 1, 0], lastChat: 0, admin: false, adminTries: 0, reportedBy: new Set(), hits: 0 };
      if (m.stars === true) me.starsDone = true;   // 다른 채널에서 이미 별사탕을 다 모았어요: 외치기는 되지만 첫 유성우·UFO는 다시 굴리지 않아요
      players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, nick: me.nick, ch: room.pub ? room.idx : -1, code: room.code, made: made ? 1 : 0, sky: room.sky, max: MAX_PER_CHANNEL, now: Date.now(), ufo: room.ufo ? 1 : 0, shower: Math.max(0, room.showerEnd - SHOWER_GAP_MS - Date.now()), screen: room.screen, players: [...players.values()].filter(p => p !== me).map(info) });
      broadcast(players, { t: 'join', ...info(me) }, me);
      console.log(`[${label(room)}] ${me.nick} ${made ? '비공개 채널을 만들고 ' : ''}입장 (${players.size}/${MAX_PER_CHANNEL})`);
      return;
    }
    const room = me.room;
    if (m.t === 's') {
      // x reaches ~1400 inside grandpa tree (indoor spaces sit east of the map), y up to the treetop terrace
      // 7th value: sitting on the cabin sofa (so others see the seat taken)
      me.s = [r2(num(m.x, -2000, 2000)), r2(num(m.y, -50, 150)), r2(num(m.z, -2000, 2000)), r2(num(m.yaw, -50, 50)), r2(num(m.sp, 0, 20)), m.g ? 1 : 0, m.sit ? 1 : 0];
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
      if (room.pub && !me.admin) return send(ws, { t: 'screen', locked: 1 });
      const cur = room.screen;
      if (cur && cur.id !== me.id) return send(ws, { t: 'screen', busy: 1, nick: cur.nick });
      room.screen = { id: me.id, nick: me.nick, x: r2(num(m.x, -2000, 2000)), y: r2(num(m.y, -50, 150)), z: r2(num(m.z, -2000, 2000)), yaw: r2(num(m.yaw, -50, 50)), k: 1 };
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
    } else if (m.t === 'report') {
      report(me, m);
    } else if (m.t === 'c') {
      // 채팅: 0.7초에 한 번, 60자까지. 내용은 저장하지 않아요.
      if (typeof m.text !== 'string' || now - me.lastChat < CHAT_GAP_MS) return;
      const text = clean(m.text, CHAT_MAX);
      if (!text || text.startsWith('/')) return;                    // 「/」로 시작하는 건 명령이라 채팅으로 퍼뜨리지 않아요
      me.lastChat = now;
      broadcast(room.players, { t: 'c', id: me.id, text }, me);
      if (me.starsDone && text.replace(/[\s!~.?,…]+/g, '') === SHOUT && callShower(me, 'shout')) rollUfo(me);
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = me.room, players = room.players;
    players.delete(me.id);
    endScreen(room, me.id);                                          // 화면을 띄운 사람이 나가면 화면도 꺼져요
    if (players.size === 0) {
      room.ufo = null; room.showerEnd = 0; room.screen = null;       // 채널이 비면 UFO도 유성우도 사라져요
      if (!room.pub) room.emptyAt = Date.now();                      // 비공개 채널은 아무도 없이 3분이 지나면 없어져요
    }
    broadcast(players, { t: 'leave', id: me.id });
    console.log(`[${label(room)}] ${me.nick} 퇴장 (${players.size}/${MAX_PER_CHANNEL})`);
  });
});

// 채널마다 모두의 최신 위치를 한 번에 보내요
setInterval(() => {
  for (const room of allRooms()) {
    if (room.players.size < 2) continue;
    const msg = JSON.stringify({ t: 'snap', p: [...room.players.values()].map(p => [p.id, ...p.s]) });
    for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }
}, TICK_MS);

// 응답 없는 연결 정리, 기한이 지난 차단 풀기
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  for (const ip of bans.keys()) banLeft(ip);
  const now = Date.now();
  for (const [ip, v] of codeMiss) if (now - v.t >= CODE_MISS_MS) codeMiss.delete(ip);
  for (const [code, room] of privateRooms) if (room.players.size === 0 && now - room.emptyAt >= PRIVATE_KEEP_MS) privateRooms.delete(code);
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`몽글 마을 서버가 켜졌어요 (공용 채널 ${CHANNELS}개, 채널당 최대 ${MAX_PER_CHANNEL}명)`);
  console.log(`  이 PC에서:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  같은 와이파이에서: http://${a.address}:${PORT}`);
  }
});
