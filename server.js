const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 4096 });
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

const SUITS = ['S', 'H', 'D', 'C'];
const MAX_PLAYERS = 8;
const MAX_ROOMS = 300;
const EMOJIS = ['😂', '😡', '😎', '🔥', '👏', '😭', '🤫', '💥'];
const DELAY = Number(process.env.DELAY_X || 1); // test speed multiplier
const TURN_MS = 30000 * DELAY;      // AFK limit for a connected player
const OFFLINE_PLAY_MS = 1500 * DELAY; // disconnected / auto players are played for after this
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const LOBBY_GRACE_MS = 90 * 1000 * DELAY; // a dropped lobby player keeps the seat (app switch / refresh)
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const rooms = {};

// ---------- helpers ----------
const cid = c => c.s + c.r;
const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const newId = () => crypto.randomBytes(6).toString('hex'); // public player id, never the token
const rnd = n => crypto.randomInt(n);

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(h) {
  const o = { S: 0, H: 1, C: 2, D: 3 };
  h.sort((a, b) => o[a.s] - o[b.s] || a.r - b.r);
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 5 }, () => CODE_CHARS[rnd(CODE_CHARS.length)]).join(''); } while (rooms[c]);
  return c;
}
function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}
function cleanName(n) {
  return String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14) || 'Player';
}
function uniqueName(room, name, except) {
  const taken = new Set(room.players.filter(p => p !== except).map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 20; i++) {
    const s = ' ' + i, cand = name.slice(0, 14 - s.length) + s;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name.slice(0, 10) + ' ' + rnd(900 + 100);
}
const humans = room => room.players.filter(p => !p.bot);
const connectedHumans = room => room.players.filter(p => !p.bot && p.connected);

// ---------- state sent to each player (never contains tokens) ----------
function publicState(room, pid) {
  const me = room.players.find(p => p.id === pid);
  let turn = null;
  if (room.state === 'playing' && !room.resolving) {
    const p = room.players[room.trickOrder[room.trickPos]];
    turn = p ? p.id : null;
  }
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    you: pid,
    now: Date.now(),
    players: room.players.map(p => ({
      id: p.id, name: p.name, count: p.hand.length, out: p.out, connected: p.connected || p.bot,
      bot: !!p.bot, auto: !!p.auto, bh: p.bhabhiCount, w: p.winCount
    })),
    hand: me ? me.hand : [],
    trick: room.trick.map(t => ({ pid: t.pid, card: t.card, thulla: t.thulla })),
    leadSuit: room.leadSuit,
    turn,
    turnEndsAt: turn ? room.turnEndsAt || null : null,
    firstTrick: room.firstTrick,
    resolving: room.resolving,
    lastEvent: room.lastEvent,
    finishOrder: room.finishOrder,
    bhabhi: room.bhabhi,
    log: room.log.slice(-8)
  };
}
function broadcast(room) {
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  });
}

// ---------- timers ----------
function clearTimers(room) {
  clearTimeout(room.resolveTimer); room.resolveTimer = null;
  clearTimeout(room.turnTimer); room.turnTimer = null;
  room.turnEndsAt = null;
}
function destroyRoom(room) {
  clearTimers(room);
  clearTimeout(room.cleanup);
  delete rooms[room.code];
}

// ---------- game logic ----------
function startGame(room) {
  clearTimers(room);
  room.gen = (room.gen || 0) + 1;
  // drop humans who are gone and bots that were only standing in for a leaver
  room.players = room.players.filter(p => p.bot ? !p.replaced : p.connected);
  if (!room.players.some(p => p.id === room.hostId)) room.hostId = (humans(room)[0] || room.players[0]).id;
  const deck = shuffle(makeDeck());
  room.players.forEach(p => { p.hand = []; p.out = false; p.auto = false; p.timeouts = 0; });
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.players.forEach(p => sortHand(p.hand));
  room.state = 'playing';
  room.finishOrder = [];
  room.bhabhi = null;
  room.firstTrick = true;
  room.resolving = false;
  room.lastEvent = null;
  room.log = [];
  const starter = room.players.findIndex(p => p.hand.some(c => c.s === 'S' && c.r === 14));
  addLog(room, `${room.players[starter].name} has the Ace of Spades and starts`);
  beginTrick(room, starter);
  scheduleTurn(room);
}

function beginTrick(room, leaderIdx) {
  room.trick = [];
  room.leadSuit = null;
  room.trickOrder = [];
  const n = room.players.length;
  for (let k = 0; k < n; k++) {
    const i = (leaderIdx + k) % n;
    const p = room.players[i];
    if (!p.out && p.hand.length > 0) room.trickOrder.push(i);
  }
  room.trickPos = 0;
}

function highestIdx(room) {
  let best = null;
  for (const t of room.trick) {
    if (t.card.s === room.leadSuit && (!best || t.card.r > best.card.r)) best = t;
  }
  return best.idx;
}

function legalMoves(room, p) {
  const h = p.hand;
  if (room.trick.length === 0) return room.firstTrick ? h.filter(c => c.s === 'S' && c.r === 14) : h.slice();
  const f = h.filter(c => c.s === room.leadSuit);
  return f.length ? f : h.slice();
}

function playCard(room, pid, cardId) {
  if (room.state !== 'playing') return 'The game has not started';
  if (room.resolving) return 'Please wait...';
  const idx = room.trickOrder[room.trickPos];
  const p = room.players[idx];
  if (!p || p.id !== pid) return 'It is not your turn';
  const ci = p.hand.findIndex(c => cid(c) === cardId);
  if (ci < 0) return 'You do not have that card';
  const card = p.hand[ci];

  if (room.trick.length === 0) {
    if (room.firstTrick && !(card.s === 'S' && card.r === 14)) return 'The first trick must start with the Ace of Spades ♠';
  } else if (card.s !== room.leadSuit && p.hand.some(c => c.s === room.leadSuit)) {
    return `You must follow suit: ${SYM[room.leadSuit]}`;
  }

  clearTimeout(room.turnTimer); room.turnTimer = null; room.turnEndsAt = null;
  p.hand.splice(ci, 1);
  if (room.trick.length === 0) room.leadSuit = card.s;
  const offSuit = room.trick.length > 0 && card.s !== room.leadSuit;
  const isThulla = offSuit && !room.firstTrick; // no thulla on the first trick
  room.trick.push({ pid: p.id, idx, card, thulla: isThulla });

  if (isThulla) {
    resolveTrick(room, 'pickup', highestIdx(room), p.name);
  } else if (room.trickPos >= room.trickOrder.length - 1) {
    resolveTrick(room, 'discard', highestIdx(room));
  } else {
    room.trickPos++;
    scheduleTurn(room);
  }
  return null;
}

function resolveTrick(room, type, winnerIdx, throwerName) {
  room.resolving = true;
  const gen = room.gen;
  const w = room.players[winnerIdx];
  if (type === 'pickup') {
    room.lastEvent = { type: 'thulla', by: throwerName, to: w.name, toId: w.id, n: room.trick.length, t: Date.now() };
    addLog(room, `💥 ${throwerName} played a Thulla! ${w.name} picks up ${room.trick.length} cards`);
  } else {
    room.lastEvent = { type: 'clear', to: w.name, toId: w.id, t: Date.now() };
    addLog(room, `Trick cleared. ${w.name} leads next`);
  }
  broadcast(room);

  clearTimeout(room.resolveTimer);
  room.resolveTimer = setTimeout(() => {
    room.resolveTimer = null;
    if (!rooms[room.code] || room.gen !== gen || room.state !== 'playing') return;
    try {
      if (type === 'pickup') {
        w.hand.push(...room.trick.map(t => t.card));
        sortHand(w.hand);
      }
      room.trick = [];
      room.firstTrick = false;
      room.resolving = false;

      room.players.forEach(p => {
        if (!p.out && p.hand.length === 0) {
          p.out = true;
          room.finishOrder.push(p.id);
          addLog(room, `✅ ${p.name} is safe!`);
        }
      });

      const active = room.players.filter(p => !p.out);
      if (active.length <= 1) {
        room.state = 'over';
        room.bhabhi = active[0] ? active[0].id : null;
        room.players.forEach(p => { p.games = (p.games || 0) + 1; });
        const first = room.players.find(p => p.id === room.finishOrder[0]);
        if (first) first.winCount++;
        if (active[0]) active[0].bhabhiCount++;
        addLog(room, active[0] ? `😂 ${active[0].name} is the BHABHI!` : 'Draw, no Bhabhi this time!');
        clearTimers(room);
        broadcast(room);
        return;
      }

      let lead = winnerIdx;
      const n = room.players.length;
      while (room.players[lead].out) lead = (lead + 1) % n;
      beginTrick(room, lead);
      scheduleTurn(room);
      broadcast(room);
    } catch (e) {
      console.error('resolveTrick error', e);
    }
  }, (type === 'pickup' ? 2400 : 1500) * DELAY);
}

// ---------- bots / auto-play ----------
function botPick(room, p) {
  const moves = legalMoves(room, p);
  if (moves.length <= 1) return moves[0];
  const sorted = moves.slice().sort((a, b) => a.r - b.r);
  if (room.trick.length === 0) {
    // lead: play the lowest card of the suit we hold the most of (keeps us safe)
    const cnt = s => p.hand.filter(c => c.s === s).length;
    return sorted.sort((a, b) => cnt(b.s) - cnt(a.s) || a.r - b.r)[0];
  }
  if (moves.every(c => c.s === room.leadSuit)) {
    const last = room.trickPos >= room.trickOrder.length - 1;
    if (last || room.firstTrick) return sorted[sorted.length - 1];
    const top = Math.max(...room.trick.filter(t => t.card.s === room.leadSuit).map(t => t.card.r));
    const under = sorted.filter(c => c.r < top);
    return under.length ? under[under.length - 1] : sorted[sorted.length - 1];
  }
  // cannot follow: throw the most dangerous high card
  return sorted[sorted.length - 1];
}

function autoPlay(room, p) {
  const c = botPick(room, p);
  if (!c) return;
  const err = playCard(room, p.id, cid(c));
  if (err) console.error('autoPlay rejected:', err);
  else broadcast(room);
}

function scheduleTurn(room) {
  clearTimeout(room.turnTimer); room.turnTimer = null; room.turnEndsAt = null;
  if (room.state !== 'playing' || room.resolving) return;
  const p = room.players[room.trickOrder[room.trickPos]];
  if (!p) return;
  const gen = room.gen, pid = p.id, pos = room.trickPos, tlen = room.trick.length;
  const fire = (manual) => {
    room.turnTimer = null;
    const cur = room.players[room.trickOrder[room.trickPos]];
    if (!rooms[room.code] || room.gen !== gen || room.state !== 'playing' || room.resolving) return;
    if (!cur || cur.id !== pid || room.trickPos !== pos || room.trick.length !== tlen) return;
    try {
      if (manual) {
        p.timeouts = (p.timeouts || 0) + 1;
        if (p.timeouts >= 2 && !p.auto) { p.auto = true; addLog(room, `${p.name} is AFK, auto-play on`); }
      }
      autoPlay(room, cur);
    } catch (e) { console.error('turn error', e); }
  };
  if (p.bot) {
    room.turnTimer = setTimeout(() => fire(false), (700 + rnd(700)) * DELAY);
  } else if (!p.connected || p.auto) {
    if (connectedHumans(room).length === 0) return; // nobody is watching: pause
    room.turnTimer = setTimeout(() => fire(false), OFFLINE_PLAY_MS);
  } else {
    room.turnEndsAt = Date.now() + TURN_MS;
    room.turnTimer = setTimeout(() => fire(true), TURN_MS);
  }
}

// ---------- room membership ----------
function findBySocket(socketId) {
  for (const code in rooms) {
    const p = rooms[code].players.find(x => x.socketId === socketId);
    if (p) return { room: rooms[code], player: p };
  }
  return null;
}
function findByToken(token) {
  for (const code in rooms) {
    const p = rooms[code].players.find(x => !x.bot && x.token === token);
    if (p) return { room: rooms[code], player: p };
  }
  return null;
}
function newPlayer(name, token, socketId) {
  return { id: newId(), token, name, socketId, hand: [], out: false, connected: true, bot: false,
    auto: false, timeouts: 0, bhabhiCount: 0, winCount: 0, games: 0 };
}

function removePlayer(room, player, intentional) {
  player.socketId = null;
  player.connected = false;

  if (room.state === 'playing') {
    if (intentional) {
      // a bot takes over the leaver's cards, the game goes on
      player.bot = true; player.replaced = true; player.token = null; player.auto = false;
      addLog(room, `${player.name} left, a bot takes over`);
    } else {
      addLog(room, `${player.name} disconnected and can rejoin`);
    }
  } else if (intentional) {
    clearTimeout(player.dropTimer);
    room.players = room.players.filter(p => p !== player);
  } else if (room.state === 'lobby') {
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      if (!rooms[room.code] || player.connected || room.state === 'playing' || !room.players.includes(player)) return;
      removePlayer(room, player, true);
    }, LOBBY_GRACE_MS);
    if (player.dropTimer.unref) player.dropTimer.unref();
  } else {
    addLog(room, `${player.name} disconnected`);
  }

  if (!humans(room).length) return destroyRoom(room);

  if (room.hostId === player.id || !room.players.some(p => p.id === room.hostId)) {
    const next = connectedHumans(room)[0] || humans(room)[0];
    if (next) room.hostId = next.id;
  }
  if (!connectedHumans(room).length) {
    clearTimeout(room.turnTimer); room.turnTimer = null; room.turnEndsAt = null;
    clearTimeout(room.cleanup);
    room.cleanup = setTimeout(() => destroyRoom(room), EMPTY_ROOM_MS);
  } else if (room.state === 'playing') {
    scheduleTurn(room);
  }
  broadcast(room);
}

// ---------- sockets ----------
const createLog = new Map(); // ip -> [timestamps]
function ipOf(socket) {
  const xf = socket.handshake.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : socket.handshake.address) || 'x';
}

io.on('connection', socket => {
  // flood protection: max 20 events per second per socket
  let winStart = Date.now(), winCount = 0, strikes = 0;
  socket.use((_, next) => {
    const now = Date.now();
    if (now - winStart > 1000) { winStart = now; winCount = 0; }
    if (++winCount > 20) {
      if (++strikes > 50) return socket.disconnect(true);
      return; // drop silently
    }
    next();
  });

  // every handler is validated and wrapped so a bad payload can never crash the process
  const on = (event, fn) => socket.on(event, (data, ...rest) => {
    try {
      if (data !== undefined && data !== null && !isObj(data)) return socket.emit('err', 'Invalid request');
      fn(data || {});
    } catch (e) {
      console.error(`handler "${event}" failed:`, e && e.message);
      try { socket.emit('err', 'Something went wrong. Please try again'); } catch (_) {}
    }
  });
  const ctx = () => findBySocket(socket.id);

  on('create', ({ name, token }) => {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return socket.emit('err', 'Session token missing, please reload the page');
    const now = Date.now(), ip = ipOf(socket);
    const recent = (createLog.get(ip) || []).filter(t => now - t < 60000);
    if (recent.length >= 5) return socket.emit('err', 'Too many rooms created. Please wait a minute');
    if (Object.keys(rooms).length >= MAX_ROOMS) return socket.emit('err', 'Server is busy. Please try again later');
    recent.push(now); createLog.set(ip, recent);

    const old = findByToken(token); // one token = one room
    if (old) {
      const prev = old.player.socketId && io.sockets.sockets.get(old.player.socketId);
      if (prev) prev.leave(old.room.code);
      removePlayer(old.room, old.player, true);
    }

    const code = newCode();
    const player = newPlayer(cleanName(name), token, socket.id);
    const room = {
      code, hostId: player.id, state: 'lobby', players: [player], trick: [], trickOrder: [], trickPos: 0,
      leadSuit: null, firstTrick: true, resolving: false, finishOrder: [], bhabhi: null, log: [], lastEvent: null,
      gen: 0, resolveTimer: null, turnTimer: null, turnEndsAt: null, cleanup: null, lastChat: {}
    };
    rooms[code] = room;
    socket.join(code);
    broadcast(room);
  });

  on('join', ({ code, name, token }) => {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return socket.emit('err', 'Session token missing, please reload the page');
    code = String(code == null ? '' : code).trim().toUpperCase().slice(0, 8);
    const room = rooms[code];
    if (!room) return socket.emit('err', 'Room not found. Please check the code', 'no_room');

    let p = room.players.find(x => !x.bot && x.token === token);
    let wasAway = false;
    if (p) {
      wasAway = !p.connected || !p.socketId;
      clearTimeout(p.dropTimer); p.dropTimer = null;
      if (p.socketId && p.socketId !== socket.id) {
        const prev = io.sockets.sockets.get(p.socketId);
        if (prev) { prev.leave(code); prev.emit('err', 'You joined from another device', 'replaced'); }
      }
      p.socketId = socket.id;
      p.connected = true;
      if (wasAway) { p.timeouts = 0; p.auto = false; }
      if (name) p.name = uniqueName(room, cleanName(name), p);
      if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null; }
    } else {
      if (room.state === 'playing') return socket.emit('err', 'A game is in progress. You can join when it finishes', 'in_progress');
      if (room.players.length >= MAX_PLAYERS) return socket.emit('err', 'Room is full (8 players max)', 'full');
      const old = findByToken(token); // leave any other room first
      if (old) removePlayer(old.room, old.player, true);
      p = newPlayer(uniqueName(room, cleanName(name)), token, socket.id);
      room.players.push(p);
      if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null; }
    }
    socket.join(code);
    if (room.state === 'playing' && (wasAway || !room.turnTimer)) scheduleTurn(room); // re-joining must not reset someone's turn clock
    broadcast(room);
  });

  on('start', () => {
    const f = ctx(); if (!f) return;
    const { room, player } = f;
    if (room.hostId !== player.id) return socket.emit('err', 'Only the host can start the game');
    if (room.state === 'playing') return;
    const ready = room.players.filter(p => p.bot ? !p.replaced : p.connected).length;
    if (ready < 2) return socket.emit('err', 'At least 2 players are needed');
    startGame(room);
    broadcast(room);
  });

  on('play', ({ cardId }) => {
    const f = ctx(); if (!f) return;
    if (typeof cardId !== 'string' || cardId.length > 4) return socket.emit('err', 'Invalid card');
    const { room, player } = f;
    const err = playCard(room, player.id, cardId);
    if (err) return socket.emit('err', err);
    player.timeouts = 0;
    if (player.auto) { player.auto = false; }
    broadcast(room);
  });

  on('toLobby', () => {
    const f = ctx(); if (!f) return;
    const { room, player } = f;
    if (room.hostId !== player.id) return socket.emit('err', 'Only the host can do this');
    if (room.state !== 'over') return;
    room.players = room.players.filter(p => p.bot ? !p.replaced : p.connected);
    room.state = 'lobby'; room.trick = []; room.finishOrder = []; room.bhabhi = null; room.lastEvent = null;
    broadcast(room);
  });

  on('addBot', () => {
    const f = ctx(); if (!f) return;
    const { room, player } = f;
    if (room.hostId !== player.id) return socket.emit('err', 'Only the host can add bots');
    if (room.state === 'playing') return socket.emit('err', 'Wait for the game to finish');
    if (room.players.length >= MAX_PLAYERS) return socket.emit('err', 'Room is full (8 players max)', 'full_soft');
    const names = ['Bot Raju', 'Bot Simran', 'Bot Pappu', 'Bot Munni', 'Bot Chintu', 'Bot Babli', 'Bot Golu'];
    const base = names[rnd(names.length)];
    const b = newPlayer(uniqueName(room, base), null, null);
    b.bot = true; b.connected = true;
    room.players.push(b);
    broadcast(room);
  });

  on('removeBot', ({ id }) => {
    const f = ctx(); if (!f) return;
    const { room, player } = f;
    if (room.hostId !== player.id) return socket.emit('err', 'Only the host can remove bots');
    if (room.state === 'playing') return;
    const b = room.players.find(p => p.bot && p.id === id);
    if (!b) return;
    room.players = room.players.filter(p => p !== b);
    broadcast(room);
  });

  on('emoji', ({ e }) => {
    const f = ctx();
    if (!f || typeof e !== 'string' || !EMOJIS.includes(e)) return;
    const now = Date.now();
    if (f.player.lastEmoji && now - f.player.lastEmoji < 800) return;
    f.player.lastEmoji = now;
    io.to(f.room.code).emit('emoji', { pid: f.player.id, e });
  });

  on('chat', ({ m }) => {
    const f = ctx();
    if (!f || typeof m !== 'string') return;
    const text = m.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (f.player.lastChat && now - f.player.lastChat < 700) return;
    f.player.lastChat = now;
    io.to(f.room.code).emit('chat', { pid: f.player.id, name: f.player.name, m: text, t: now });
  });

  on('leave', () => leave(socket, true));
  socket.on('disconnect', () => { try { leave(socket, false); } catch (e) { console.error('disconnect error', e); } });
});

function leave(socket, intentional) {
  const f = findBySocket(socket.id);
  if (!f) return;
  const { room, player } = f;
  socket.leave(room.code);
  removePlayer(room, player, intentional);
}

setInterval(() => { // forget old rate-limit entries
  const now = Date.now();
  for (const [ip, arr] of createLog) {
    const keep = arr.filter(t => now - t < 60000);
    if (keep.length) createLog.set(ip, keep); else createLog.delete(ip);
  }
}, 60000).unref();

// last-resort guards: log and keep serving instead of dying
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

// graceful shutdown (Railway sends SIGTERM on redeploy)
function shutdown() {
  console.log('Shutting down...');
  io.emit('err', 'Server is restarting. Reconnecting in a moment...', 'restart');
  for (const code in rooms) clearTimers(rooms[code]);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Made By Toshi With Pleasure
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bhabhi Thulla server running: http://localhost:${PORT}`));
