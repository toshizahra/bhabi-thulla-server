const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

const SUITS = ['S', 'H', 'D', 'C'];
const MAX_PLAYERS = 8;
const DELAY = Number(process.env.DELAY_X || 1); // testing ke liye
const rooms = {};

// ---------- helpers ----------
const cid = c => c.s + c.r;
const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const cname = c => (RANK[c.r] || c.r) + SYM[c.s];

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(h) {
  const o = { S: 0, H: 1, C: 2, D: 3 };
  h.sort((a, b) => o[a.s] - o[b.s] || a.r - b.r);
}
function newCode() {
  let c;
  do { c = Math.random().toString(36).substring(2, 7).toUpperCase(); } while (rooms[c]);
  return c;
}
function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

// ---------- state sent to each player ----------
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
    players: room.players.map(p => ({
      id: p.id, name: p.name, count: p.hand.length, out: p.out, connected: p.connected
    })),
    hand: me ? me.hand : [],
    trick: room.trick.map(t => ({ pid: t.pid, card: t.card, thulla: t.thulla })),
    leadSuit: room.leadSuit,
    turn,
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

// ---------- game logic ----------
function startGame(room) {
  room.players = room.players.filter(p => p.connected);
  const deck = shuffle(makeDeck());
  room.players.forEach(p => { p.hand = []; p.out = false; });
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
  addLog(room, `${room.players[starter].name} ke paas Ekka Hukum ♠ hai, woh shuru karega`);
  beginTrick(room, starter);
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

function playCard(room, pid, cardId) {
  if (room.state !== 'playing') return 'Game shuru nahi hua';
  if (room.resolving) return 'Thora ruko...';
  const idx = room.trickOrder[room.trickPos];
  const p = room.players[idx];
  if (!p || p.id !== pid) return 'Abhi aapki baari nahi';
  const ci = p.hand.findIndex(c => cid(c) === cardId);
  if (ci < 0) return 'Ye card aapke paas nahi';
  const card = p.hand[ci];

  if (room.trick.length === 0) {
    if (room.firstTrick && !(card.s === 'S' && card.r === 14)) return 'Pehli chaal Ekka Hukum ♠ se hogi';
  } else if (card.s !== room.leadSuit && p.hand.some(c => c.s === room.leadSuit)) {
    return `${SYM[room.leadSuit]} ka card chalna zaroori hai`;
  }

  p.hand.splice(ci, 1);
  if (room.trick.length === 0) room.leadSuit = card.s;
  const offSuit = room.trick.length > 0 && card.s !== room.leadSuit;
  const isThulla = offSuit && !room.firstTrick; // pehli trick mein thulla nahi lagta
  room.trick.push({ pid: p.id, idx, card, thulla: isThulla });

  if (isThulla) {
    resolveTrick(room, 'pickup', highestIdx(room), p.name);
  } else if (room.trickPos >= room.trickOrder.length - 1) {
    resolveTrick(room, 'discard', highestIdx(room));
  } else {
    room.trickPos++;
  }
  return null;
}

function resolveTrick(room, type, winnerIdx, throwerName) {
  room.resolving = true;
  const w = room.players[winnerIdx];
  if (type === 'pickup') {
    room.lastEvent = { type: 'thulla', by: throwerName, to: w.name, n: room.trick.length, t: Date.now() };
    addLog(room, `💥 ${throwerName} ne thulla mara! ${w.name} ${room.trick.length} cards uthayega`);
  } else {
    room.lastEvent = { type: 'clear', to: w.name, t: Date.now() };
    addLog(room, `Haath saaf. ${w.name} agli chaal chalega`);
  }
  broadcast(room);

  setTimeout(() => {
    if (!rooms[room.code] || room.state !== 'playing') return;
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
        addLog(room, `✅ ${p.name} bach gaya!`);
      }
    });

    const active = room.players.filter(p => !p.out);
    if (active.length <= 1) {
      room.state = 'over';
      room.bhabhi = active[0] ? active[0].id : null;
      addLog(room, active[0] ? `😂 ${active[0].name} BHABHI ban gaya!` : 'Koi Bhabhi nahi bana, draw!');
      broadcast(room);
      return;
    }

    let lead = winnerIdx;
    const n = room.players.length;
    while (room.players[lead].out) lead = (lead + 1) % n;
    beginTrick(room, lead);
    broadcast(room);
  }, (type === 'pickup' ? 2400 : 1500) * DELAY);
}

// ---------- sockets ----------
function findBySocket(socketId) {
  for (const code in rooms) {
    const p = rooms[code].players.find(x => x.socketId === socketId);
    if (p) return { room: rooms[code], player: p };
  }
  return null;
}

function cleanName(n) {
  return String(n || '').trim().slice(0, 14) || 'Player';
}

io.on('connection', socket => {
  socket.on('create', ({ name, token }) => {
    if (!token) return socket.emit('err', 'Token missing, page reload karo');
    const code = newCode();
    const room = {
      code, hostId: token, state: 'lobby', players: [], trick: [], trickOrder: [], trickPos: 0,
      leadSuit: null, firstTrick: true, resolving: false, finishOrder: [], bhabhi: null, log: [], lastEvent: null
    };
    room.players.push({ id: token, name: cleanName(name), socketId: socket.id, hand: [], out: false, connected: true });
    rooms[code] = room;
    socket.join(code);
    broadcast(room);
  });

  socket.on('join', ({ code, name, token }) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('err', 'Room nahi mila. Code check karo');
    let p = room.players.find(x => x.id === token);
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
      if (name) p.name = cleanName(name);
      if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null; }
    } else {
      if (room.state !== 'lobby') return socket.emit('err', 'Game chal raha hai, khatam hone ka intezar karo');
      if (room.players.length >= MAX_PLAYERS) return socket.emit('err', 'Room full hai (8 players max)');
      p = { id: token, name: cleanName(name), socketId: socket.id, hand: [], out: false, connected: true };
      room.players.push(p);
    }
    socket.join(code);
    broadcast(room);
  });

  socket.on('start', () => {
    const f = findBySocket(socket.id);
    if (!f) return;
    const { room, player } = f;
    if (room.hostId !== player.id) return socket.emit('err', 'Sirf host game shuru kar sakta hai');
    if (room.state === 'playing') return;
    if (room.players.filter(p => p.connected).length < 2) return socket.emit('err', 'Kam se kam 2 players chahiye');
    startGame(room);
    broadcast(room);
  });

  socket.on('play', ({ cardId }) => {
    const f = findBySocket(socket.id);
    if (!f) return;
    const err = playCard(f.room, f.player.id, cardId);
    if (err) return socket.emit('err', err);
    broadcast(f.room);
  });

  socket.on('leave', () => leave(socket, true));
  socket.on('disconnect', () => leave(socket, false));
});

function leave(socket, intentional) {
  const f = findBySocket(socket.id);
  if (!f) return;
  const { room, player } = f;
  socket.leave(room.code);
  player.socketId = null;
  player.connected = false;

  if (room.state !== 'playing' || intentional) {
    if (room.state === 'playing' && intentional) {
      // game ke beech chhora: uske cards baaki logon mein baant do
      const others = room.players.filter(p => p !== player && !p.out);
      player.hand.forEach((c, i) => others.length && others[i % others.length].hand.push(c));
      others.forEach(p => sortHand(p.hand));
      addLog(room, `${player.name} game chhor gaya`);
      room.state = 'lobby';
      room.trick = [];
      addLog(room, 'Game ruk gaya, host dobara shuru kare');
    }
    room.players = room.players.filter(p => p !== player);
    if (room.hostId === player.id && room.players[0]) room.hostId = room.players[0].id;
  } else {
    addLog(room, `${player.name} ka connection gaya, wapas aa sakta hai`);
  }

  if (room.players.length === 0) { delete rooms[room.code]; return; }
  if (!room.players.some(p => p.connected)) {
    room.cleanup = setTimeout(() => delete rooms[room.code], 10 * 60 * 1000);
  }
  broadcast(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bhabhi Thulla chal raha hai: http://localhost:${PORT}`));
