// 몽글 마을 멀티플레이 서버
// - public/index.html 을 내려주고, /ws 웹소켓으로 같은 채널 사람들의 위치를 주고받아요.
// - 저장하는 데이터는 없어요. 서버를 끄면 모두 사라지는 1회성 플레이예요.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const CHANNELS = 10;
const MAX_PER_CHANNEL = Number(process.env.MAX_PER_CHANNEL) || 20; // 채널당 최대 인원
const TICK_MS = 100;                                              // 위치 동기화 주기 (초당 10번)
const CHAR_IDS = new Set(['mongsil', 'tosil', 'haneul', 'leo']);
const PHRASE_COUNT = 4;
const CHAT_MAX = 60;       // 채팅 최대 글자 수
const CHAT_GAP_MS = 700;   // 채팅 최소 간격
const NICK_MAX = 12;       // 닉네임 최대 글자 수
const UFO_CHANCE = process.env.UFO_CHANCE != null ? Number(process.env.UFO_CHANCE) : 0.1;   // 별사탕을 다 모았을 때 UFO가 떨어질 확률

const ADJ = ['말랑한', '폭신한', '졸린', '배고픈', '수줍은', '용감한', '느긋한', '반짝이는', '동글동글한', '콩닥이는',
  '신난', '꼬물꼬물', '달콤한', '포근한', '깡총깡총', '엉뚱한', '조그만', '부지런한', '방긋 웃는', '살금살금'];
const NOUN = ['도토리', '구름', '푸딩', '쿠키', '민들레', '솜사탕', '감자', '당근', '버섯', '다람쥐',
  '고구마', '찹쌀떡', '별사탕', '호빵', '올챙이', '클로버', '눈송이', '마카롱', '떡볶이', '달팽이'];

const channels = Array.from({ length: CHANNELS }, () => new Map()); // id -> player
const ufos = Array(CHANNELS).fill(null);                          // 채널마다 광장에 박힌 UFO (사람이 0명이 되면 사라져요)
let nextId = 1;

function makeNick(room) {
  const used = new Set([...room.values()].map(p => p.nick));
  for (let i = 0; i < 40; i++) {
    const nick = ADJ[Math.random() * ADJ.length | 0] + ' ' + NOUN[Math.random() * NOUN.length | 0];
    if (!used.has(nick)) return nick;
  }
  return NOUN[Math.random() * NOUN.length | 0] + ' ' + (100 + Math.random() * 900 | 0);
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/channels') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ max: MAX_PER_CHANNEL, channels: channels.map(c => c.size) }));
  }
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
const broadcast = (room, obj, except) => { const s = JSON.stringify(obj); for (const p of room.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const info = p => ({ id: p.id, nick: p.nick, char: p.char, s: p.s });
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : 0;
const r2 = v => Math.round(v * 100) / 100;
// 제어 문자와 방향 바꾸는 보이지 않는 문자를 지우고 공백을 하나로 모아요
const clean = (v, max) => typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim() : '';

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let me = null, budget = 40, last = Date.now();

  ws.on('message', raw => {
    // 초당 40개까지만 받아요 (토큰 버킷)
    const now = Date.now(); budget = Math.min(40, budget + (now - last) * 0.04); last = now;
    if (budget < 1) return; budget--;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!me) {
      if (m.t !== 'join') return;
      const ch = Number.isInteger(m.ch) ? m.ch : -1;
      if (ch < 0 || ch >= CHANNELS || !CHAR_IDS.has(m.char)) return ws.close();
      const room = channels[ch];
      if (room.size >= MAX_PER_CHANNEL) { send(ws, { t: 'full' }); return ws.close(); }
      // 닉네임: 들어올 때 고른 이름을 이번 접속 동안만 써요 (비어 있으면 랜덤). 같은 채널에 같은 이름은 안 돼요.
      const want = clean(m.nick, NICK_MAX);
      if (want && [...room.values()].some(p => p.nick === want)) { send(ws, { t: 'taken' }); return ws.close(); }
      me = { id: nextId++, ws, ch, char: m.char, nick: want || makeNick(room), s: [6, 0, 22, 0, 0, 1, 0], lastChat: 0 };
      room.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, nick: me.nick, ch, max: MAX_PER_CHANNEL, ufo: ufos[ch] ? 1 : 0, players: [...room.values()].filter(p => p !== me).map(info) });
      broadcast(room, { t: 'join', ...info(me) }, me);
      console.log(`[채널 ${ch + 1}] ${me.nick} 입장 (${room.size}/${MAX_PER_CHANNEL})`);
      return;
    }
    if (m.t === 's') {
      // x reaches ~1400 inside grandpa tree (indoor spaces sit east of the map), y up to the treetop terrace
      // 7th value: sitting on the cabin sofa (so others see the seat taken)
      me.s = [r2(num(m.x, -2000, 2000)), r2(num(m.y, -50, 150)), r2(num(m.z, -2000, 2000)), r2(num(m.yaw, -50, 50)), r2(num(m.sp, 0, 20)), m.g ? 1 : 0, m.sit ? 1 : 0];
    } else if (m.t === 'e') {
      const k = Number.isInteger(m.k) ? m.k : -1;
      if (k >= 0 && k < PHRASE_COUNT) broadcast(channels[me.ch], { t: 'e', id: me.id, k }, me);
    } else if (m.t === 'stars') {
      // 별사탕을 다 모았어요: 접속마다 한 번만, 서버가 확률을 굴려 채널 모두에게 UFO를 떨어뜨려요
      if (me.starsDone) return; me.starsDone = true;
      if (!ufos[me.ch] && Math.random() < UFO_CHANCE) {
        ufos[me.ch] = { at: Date.now() };
        broadcast(channels[me.ch], { t: 'ufo' });
        console.log(`[채널 ${me.ch + 1}] UFO가 광장에 떨어졌어요 (${me.nick})`);
      }
    } else if (m.t === 'c') {
      // 채팅: 0.7초에 한 번, 60자까지. 내용은 저장하지 않아요.
      if (typeof m.text !== 'string' || now - me.lastChat < CHAT_GAP_MS) return;
      const text = clean(m.text, CHAT_MAX);
      if (!text) return;
      me.lastChat = now;
      broadcast(channels[me.ch], { t: 'c', id: me.id, text }, me);
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = channels[me.ch];
    room.delete(me.id);
    if (room.size === 0) ufos[me.ch] = null;   // 채널이 비면 UFO도 사라져요
    broadcast(room, { t: 'leave', id: me.id });
    console.log(`[채널 ${me.ch + 1}] ${me.nick} 퇴장 (${room.size}/${MAX_PER_CHANNEL})`);
  });
});

// 채널마다 모두의 최신 위치를 한 번에 보내요
setInterval(() => {
  for (const room of channels) {
    if (room.size < 2) continue;
    const msg = JSON.stringify({ t: 'snap', p: [...room.values()].map(p => [p.id, ...p.s]) });
    for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }
}, TICK_MS);

// 응답 없는 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`몽글 마을 서버가 켜졌어요 (채널 ${CHANNELS}개, 채널당 최대 ${MAX_PER_CHANNEL}명)`);
  console.log(`  이 PC에서:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  같은 와이파이에서: http://${a.address}:${PORT}`);
  }
});
