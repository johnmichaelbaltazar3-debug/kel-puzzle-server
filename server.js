'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const BATTLE_TIME_MS = 30 * 60 * 1000;
const INTRO_DURATION_MS = 8200;
const RECONNECT_GRACE_MS = 30 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 100;
const MAX_SCORE = 100000000;
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, '{}');
let players = {};
try {
  const parsed = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8') || '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) players = parsed;
} catch (error) {
  console.error('players.json is invalid; starting with an empty in-memory profile map:', error.message);
}
const queue = new Map(); // playerId -> one live queue entry
const matches = new Map();

function savePlayers() {
  const temp = `${PLAYERS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(players, null, 2));
  fs.renameSync(temp, PLAYERS_FILE);
}
function tier(points) {
  if (points >= 6300) return 'ETERNAL'; if (points >= 5200) return 'LEGEND'; if (points >= 4300) return 'MYTHIC';
  if (points >= 3500) return 'GRANDMASTER'; if (points >= 2700) return 'MASTER'; if (points >= 2000) return 'DIAMOND';
  if (points >= 1400) return 'PLATINUM'; if (points >= 900) return 'GOLD'; if (points >= 500) return 'SILVER';
  if (points >= 200) return 'BRONZE'; return 'IRON';
}
function validPlayerId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validName(value) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 32) : '';
}
function ensurePlayer(id, displayName, points) {
  if (!players[id] || typeof players[id] !== 'object' || Array.isArray(players[id])) {
    players[id] = { id, name: displayName || `Player-${id.slice(-4)}`, points: Math.max(0, Math.min(10000000, Math.floor(Number(points) || 0))), wins: 0, losses: 0, streak: 0, history: [] };
  }
  const profile = players[id];
  profile.id = id;
  profile.name = displayName || validName(profile.name) || `Player-${id.slice(-4)}`;
  profile.points = Math.max(0, Math.min(10000000, Math.floor(Number(profile.points) || 0)));
  profile.wins = Math.max(0, Math.floor(Number(profile.wins) || 0));
  profile.losses = Math.max(0, Math.floor(Number(profile.losses) || 0));
  profile.streak = Math.max(0, Math.floor(Number(profile.streak) || 0));
  if (!Array.isArray(profile.history)) profile.history = [];
  return profile;
}
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch (_) { /* close/heartbeat handles dead sockets */ }
  }
}
function isOpen(ws) { return !!ws && ws.readyState === WebSocket.OPEN; }
function broadcastMatch(match, payload) { for (const p of match.players) send(p.ws, payload); }
function reward(my, opp) { return Math.max(20, Math.min(35, 25 + Math.max(-5, Math.min(10, Math.floor((opp.points - my.points) / 100))))); }
function penalty(my, opp) { return Math.max(15, Math.min(28, 20 + Math.max(-5, Math.min(8, Math.floor((my.points - opp.points) / 100))))); }
function matchForPlayer(id) { for (const m of matches.values()) if (!m.finished && m.players.some(p => p.id === id)) return m; return null; }
function recentFinishedMatchForPlayer(id, matchId) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const match of matches.values()) {
    if (match.finished && (match.finishedAt || match.createdAt) >= cutoff && (!matchId || match.id === String(matchId)) && match.players.some(p => p.id === id) && match.results && match.results[id]) return match;
  }
  return null;
}
function sendStoredResult(match, playerId, ws) {
  const payload = match && match.results ? match.results[playerId] : null;
  if (payload) send(ws, payload);
  return !!payload;
}
function matchFoundPayload(match, player) {
  const opp = match.players.find(p => p.id !== player.id);
  return {
    type: 'match_found', matchId: match.id, opponentName: opp.name,
    opponentPoints: players[opp.id]?.points ?? opp.points,
    opponentPuzzleSkin: opp.puzzleSkin || 'classic', opponentGridSkin: opp.gridSkin || 'classic',
    seed: match.seed, startAt: match.startAt || 0, endsAt: match.endsAt || 0, nextProgressSeq: (player.lastProgressSeq || 0) + 1, serverNow: Date.now(),
    reconnecting: !!match.startedAt
  };
}
function cleanupQueue() {
  for (const [id, entry] of queue) {
    if (!isOpen(entry.ws)) queue.delete(id);
  }
}
function startIntro(match) {
  if (!match || match.finished || match.startedAt || match.introAt) return;
  if (match.players.length !== 2 || match.players[0].id === match.players[1].id) return;
  // Do not lose the intro if one client's intro_ready packet is delayed or missed.
  // Retry while a matched player's socket is temporarily unavailable.
  if (!match.players.every(p => isOpen(p.ws))) {
    match.introFallbackTimer = setTimeout(() => startIntro(match), 1000);
    return;
  }
  if (match.introFallbackTimer) {
    clearTimeout(match.introFallbackTimer);
    match.introFallbackTimer = null;
  }
  match.introAt = Date.now() + 1200;
  broadcastMatch(match, { type: 'intro_start', matchId: match.id, introAt: match.introAt, serverNow: Date.now() });
}

function tryMatch() {
  cleanupQueue();
  const waiting = [...queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  for (let i = 0; i < waiting.length; i++) {
    const a = waiting[i];
    if (queue.get(a.id) !== a || !isOpen(a.ws)) continue;
    const b = waiting.slice(i + 1).find(x => queue.get(x.id) === x && x.id !== a.id && isOpen(x.ws));
    if (!b || a.id === b.id) continue;
    // Both unique player identities must still have live sockets at the exact pairing point.
    if (!isOpen(a.ws) || !isOpen(b.ws) || a.ws === b.ws) continue;
    queue.delete(a.id); queue.delete(b.id);
    const id = crypto.randomUUID();
    const seed = Number((BigInt(Date.now()) ^ (BigInt(a.points) << 17n) ^ (BigInt(b.points) << 3n) ^ BigInt(Math.floor(Math.random() * 0x7fffffff))) % 9000000000000000n);
    const match = {
      id, players: [a, b], seed, createdAt: Date.now(), introReady: new Set(), introAt: 0, ready: new Set(), finished: false,
      startedAt: 0, startAt: 0, endsAt: 0, timeout: null, introStartTimer: null, introFallbackTimer: null, results: null
    };
    matches.set(id, match); a.matchId = id; b.matchId = id;
    send(a.ws, matchFoundPayload(match, a)); send(b.ws, matchFoundPayload(match, b));
    // Normally both clients send intro_ready as soon as their VS overlay is attached.
    // If either packet is lost, start the synchronized intro anyway instead of freezing both phones.
    match.introFallbackTimer = setTimeout(() => startIntro(match), 5000);
  }
}
function finishDraw(match) {
  if (!match || match.finished) return false;
  match.finished = true; match.finishedAt = Date.now();
  if (match.timeout) clearTimeout(match.timeout);
  if (match.introStartTimer) clearTimeout(match.introStartTimer);
  if (match.introFallbackTimer) clearTimeout(match.introFallbackTimer);
  for (const p of match.players) if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  match.results = {};
  for (const p of match.players) {
    const profile = players[p.id];
    profile.history.unshift({ matchId: match.id, result: 'DRAW', delta: 0, at: match.finishedAt });
    profile.history = profile.history.slice(0, 50);
    match.results[p.id] = { type: 'result', matchId: match.id, result: 'DRAW', delta: 0, newPoints: profile.points, rank: tier(profile.points) };
  }
  savePlayers(); broadcastMatch(match, { type: 'match_finished', matchId: match.id });
  for (const p of match.players) send(p.ws, match.results[p.id]);
  return true;
}
function finishMatch(match, winnerId, reason = 'completed') {
  if (!match || match.finished) return false;
  const winner = match.players.find(p => p.id === winnerId);
  const loser = match.players.find(p => p.id !== winnerId);
  if (!winner || !loser || winner.id === loser.id) return false;
  match.finished = true; match.finishedAt = Date.now();
  if (match.timeout) clearTimeout(match.timeout);
  if (match.introStartTimer) clearTimeout(match.introStartTimer);
  if (match.introFallbackTimer) clearTimeout(match.introFallbackTimer);
  for (const p of match.players) if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  const wp = players[winner.id], lp = players[loser.id];
  const gain = reward(wp, lp), loss = penalty(lp, wp);
  wp.points += gain; wp.wins++; wp.streak++;
  lp.points = Math.max(0, lp.points - loss); lp.losses++; lp.streak = 0;
  wp.history.unshift({ matchId: match.id, result: 'WIN', delta: gain, reason, at: match.finishedAt });
  lp.history.unshift({ matchId: match.id, result: 'LOSS', delta: -loss, reason, at: match.finishedAt });
  wp.history = wp.history.slice(0, 50); lp.history = lp.history.slice(0, 50);
  match.results = {
    [winner.id]: { type: 'result', matchId: match.id, result: 'WIN', delta: gain, newPoints: wp.points, rank: tier(wp.points), reason },
    [loser.id]: { type: 'result', matchId: match.id, result: 'LOSS', delta: -loss, newPoints: lp.points, rank: tier(lp.points), reason }
  };
  savePlayers(); broadcastMatch(match, { type: 'match_finished', matchId: match.id });
  send(winner.ws, match.results[winner.id]); send(loser.ws, match.results[loser.id]);
  return true;
}
function startBattle(match) {
  if (!match || match.finished || match.startedAt || match.ready.size !== 2) return;
  // The cinematic currently lasts about 8.2 seconds. Never start before the
  // shared intro window has ended, even if a client's ready packet arrives early.
  const introRemaining = (match.introAt || 0) + INTRO_DURATION_MS - Date.now();
  if (introRemaining > 0) {
    if (!match.introStartTimer) {
      match.introStartTimer = setTimeout(() => {
        match.introStartTimer = null;
        startBattle(match);
      }, introRemaining);
    }
    return;
  }
  if (match.players.length !== 2 || match.players[0].id === match.players[1].id || !match.players.every(p => isOpen(p.ws))) {
    return;
  }
  match.startAt = Date.now() + 1200;
  match.startedAt = match.startAt;
  match.endsAt = match.startAt + BATTLE_TIME_MS;
  broadcastMatch(match, { type: 'battle_start', matchId: match.id, startAt: match.startAt, endsAt: match.endsAt, serverNow: Date.now(), durationMs: BATTLE_TIME_MS });
  match.timeout = setTimeout(() => {
    if (match.finished) return;
    const [a, b] = match.players;
    const as = Math.max(0, Number(a.lastScore) || 0), bs = Math.max(0, Number(b.lastScore) || 0);
    if (as === bs) finishDraw(match);
    else finishMatch(match, as > bs ? a.id : b.id, 'timeout');
  }, Math.max(0, match.endsAt - Date.now()));
}
function sendOpponentState(match, player) {
  const opp = match.players.find(p => p.id !== player.id); if (!opp) return;
  send(player.ws, { type: 'opponent_progress', percent: opp.lastPercent || 0, score: opp.lastScore || 0, seq: opp.lastProgressSeq || 0 });
  if (opp.lastBoard) send(player.ws, { type: 'opponent_board', board: opp.lastBoard, slots: opp.lastSlots || Array(64).fill(-1), seq: opp.lastProgressSeq || 0 });
}
function safeClose(ws, code, reason) { try { if (ws && ws.readyState < WebSocket.CLOSING) ws.close(code, reason); } catch (_) {} }

const httpServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, service: 'kel-puzzle-ranked', queue: queue.size, matches: [...matches.values()].filter(m => !m.finished).length }));
  }
  if (pathname === '/leaderboard') {
    const list = Object.values(players).sort((a, b) => b.points - a.points).slice(0, 100).map((p, i) => ({ rank: i + 1, name: p.name, points: p.points, tier: tier(p.points), wins: p.wins, losses: p.losses }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocket.Server({ server: httpServer, maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  let playerId = null;
  let attachedMatch = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return send(ws, { type: 'error', message: 'Invalid message.' });

      if (m.type === 'queue') {
        const requestedId = typeof m.playerId === 'string' ? m.playerId.trim() : '';
        if (!validPlayerId(requestedId)) return send(ws, { type: 'error', message: 'Invalid player ID. Please reopen the app and try again.' });
        if (playerId && playerId !== requestedId) return send(ws, { type: 'error', message: 'This connection is already registered to another player ID.' });
        playerId = requestedId;
        const resumeMatch = m.resumeMatchId ? recentFinishedMatchForPlayer(playerId, m.resumeMatchId) : null;
        if (resumeMatch) { sendStoredResult(resumeMatch, playerId, ws); return; }
        const active = matchForPlayer(playerId);
        if (active) {
          const entry = active.players.find(p => p.id === playerId);
          if (entry.ws && entry.ws !== ws && isOpen(entry.ws)) {
            send(ws, { type: 'error', message: 'This player ID is already connected on another device. Use a different account/player ID for a separate PvP test.' });
            safeClose(ws, 4001, 'Player ID already connected'); return;
          }
          attachedMatch = active;
          if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null; entry.ws = ws; entry.disconnectedAt = 0;
          const other = active.players.find(p => p.id !== playerId);
          send(other.ws, { type: 'opponent_reconnected', matchId: active.id });
          send(ws, matchFoundPayload(active, entry));
          if (active.introAt && !active.startedAt) send(ws, { type: 'intro_start', matchId: active.id, introAt: active.introAt, serverNow: Date.now() });
          if (active.startedAt) send(ws, { type: 'battle_start', matchId: active.id, startAt: active.startAt, endsAt: active.endsAt, serverNow: Date.now(), durationMs: BATTLE_TIME_MS });
          sendOpponentState(active, entry);
          return;
        }
        const previous = queue.get(playerId);
        if (previous && previous.ws !== ws && isOpen(previous.ws)) {
          send(ws, { type: 'error', message: 'This player ID is already queued on another device. Use a different account/player ID for separate PvP testing.' });
          safeClose(ws, 4001, 'Player ID already queued'); return;
        }
        if (previous && previous.ws === ws) {
          send(ws, { type: 'queue', status: 'ALREADY SEARCHING FOR OPPONENT...' });
          tryMatch(); return;
        }
        const profile = ensurePlayer(playerId, validName(m.displayName), m.points);
        attachedMatch = null;
        const entry = {
          id: playerId, name: profile.name, points: profile.points,
          puzzleSkin: typeof m.puzzleSkin === 'string' ? m.puzzleSkin.slice(0, 40) : 'classic',
          gridSkin: typeof m.gridSkin === 'string' ? m.gridSkin.slice(0, 40) : 'classic',
          ws, joinedAt: Date.now(), matchId: null, lastScore: 0, lastPercent: 0,
          lastProgressSeq: 0, lastProgressAt: 0, lastBoard: null, lastSlots: null,
          disconnectedAt: 0, disconnectTimer: null
        };
        queue.set(playerId, entry);
        send(ws, { type: 'queue', status: 'FINDING OPPONENT...', matchmaking: 'any-rank' });
        tryMatch(); return;
      }

      if (m.type === 'cancel_queue') {
        if (!playerId) return;
        const queued = queue.get(playerId);
        if (queued && queued.ws === ws) {
          queue.delete(playerId);
          send(ws, { type: 'queue_cancelled', status: 'SEARCH CANCELLED' });
        }
        return;
      }

      if (!playerId) return send(ws, { type: 'error', message: 'Queue before sending battle messages.' });
      const match = attachedMatch && !attachedMatch.finished ? attachedMatch : matchForPlayer(playerId);
      if (!match || match.finished) {
        if (recentFinishedMatchForPlayer(playerId, m.matchId || null)) return;
        // A queue socket can cancel/leave before pairing; late packets are ignored rather than treated as a match.
        if (m.type === 'progress' || m.type === 'finished' || m.type === 'ready') return;
        return send(ws, { type: 'error', message: 'No active match.' });
      }
      if (['intro_ready', 'ready', 'progress', 'finished'].includes(m.type) && String(m.matchId || '') !== match.id) return;
      if (m.matchId && String(m.matchId) !== match.id) return;
      const entry = match.players.find(p => p.id === playerId);
      if (!entry || entry.ws !== ws) return; // Reject stale/replaced sockets.

      if (m.type === 'intro_ready') {
        if (!match.startedAt && match.players.length === 2 && match.players[0].id !== match.players[1].id && match.players.every(p => isOpen(p.ws))) {
          match.introReady.add(playerId);
          if (match.introReady.size === 2 && !match.introAt) startIntro(match);
        }
      } else if (m.type === 'ready') {
        // Record readiness even if the packet arrives a little before the server's
        // intro deadline. Previously that packet was discarded, but the client sent
        // ready only once, leaving both players stuck on the VS/countdown overlay.
        if (match.introAt > 0 && !match.startedAt && match.players.length === 2 &&
            match.players[0].id !== match.players[1].id && match.players.every(p => isOpen(p.ws))) {
          match.ready.add(playerId);
          send(ws, { type: 'ready_ack', matchId: match.id, readyCount: match.ready.size });
          if (match.ready.size === 2) startBattle(match);
        }
      } else if (m.type === 'progress') {
        if (!match.startedAt || Date.now() < match.startAt || Date.now() >= match.endsAt) return;
        const scoreNum = m.score, percentNum = m.percent, seq = m.seq;
        if (typeof scoreNum !== 'number' || !Number.isSafeInteger(scoreNum) || scoreNum < 0 || scoreNum > MAX_SCORE) return;
        if (typeof percentNum !== 'number' || !Number.isFinite(percentNum) || percentNum < 0 || percentNum > 99) return;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return;
        if (seq <= entry.lastProgressSeq || scoreNum < (entry.lastScore || 0)) return;
        const board = m.board;
        const slots = m.slots;
        // Validate the entire snapshot before mutating any authoritative progress fields.
        if (board !== undefined && (!Array.isArray(board) || board.length !== 64 || !board.every(v => Number.isInteger(v) && v >= -2147483648 && v <= 4294967295))) return;
        if (slots !== undefined && (!Array.isArray(slots) || slots.length !== 64 || !slots.every(v => Number.isInteger(v) && v >= -1 && v <= 8))) return;
        const now = Date.now();
        if (entry.lastProgressAt && now - entry.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        entry.lastProgressAt = now; entry.lastProgressSeq = seq;
        entry.lastPercent = Math.max(entry.lastPercent || 0, Math.floor(percentNum));
        entry.lastScore = scoreNum;
        if (board !== undefined) {
          entry.lastBoard = board.map(Number);
          entry.lastSlots = slots !== undefined ? slots.map(Number) : Array(64).fill(-1);
        }
        const opp = match.players.find(p => p.id !== playerId);
        send(opp.ws, { type: 'opponent_progress', percent: entry.lastPercent, score: entry.lastScore, seq });
        if (entry.lastBoard) send(opp.ws, { type: 'opponent_board', board: entry.lastBoard, slots: entry.lastSlots || [], seq });
      } else if (m.type === 'finished') {
        const reason = String(m.reason || 'completed');
        if (!match.startedAt || Date.now() < match.startAt || Date.now() >= match.endsAt) return;
        const finalScore = m.score;
        if (typeof finalScore !== 'number' || !Number.isSafeInteger(finalScore) || finalScore < (entry.lastScore || 0) || finalScore > MAX_SCORE) return;
        entry.lastScore = finalScore;
        if (reason === 'no_moves') {
          // This is a loss declaration, never a self-awarded win. Full move legality still needs server replay to be cheat-proof.
          finishMatch(match, match.players.find(p => p.id !== playerId).id, 'no_moves');
        } else if (reason === 'timeout') {
          // Server timer owns timeout settlement; a client cannot claim timeout early.
          return;
        } else {
          send(ws, { type: 'error', message: 'Early finish is not a win condition. Ranked matches end on no moves or server timeout.' });
        }
      }
    } catch (error) {
      send(ws, { type: 'error', message: 'Invalid message.' });
    }
  });
  ws.on('close', () => {
    if (!playerId) return;
    if (queue.get(playerId)?.ws === ws) queue.delete(playerId);
    const match = attachedMatch && !attachedMatch.finished ? attachedMatch : matchForPlayer(playerId);
    if (match && !match.finished) {
      const entry = match.players.find(p => p.id === playerId); if (!entry || entry.ws !== ws) return;
      entry.ws = null; entry.disconnectedAt = Date.now();
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = setTimeout(() => {
        if (!match.finished && !entry.ws) finishMatch(match, match.players.find(p => p.id !== playerId).id, 'disconnect_forfeit');
      }, RECONNECT_GRACE_MS);
      const opp = match.players.find(p => p.id !== playerId);
      send(opp.ws, { type: 'opponent_disconnected', matchId: match.id, graceMs: RECONNECT_GRACE_MS });
    }
  });
  ws.on('error', () => { /* close event performs queue and reconnect cleanup */ });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }
  cleanupQueue();
  tryMatch();
}, 15000);
heartbeat.unref();
const statusTicker = setInterval(() => {
  const now = Date.now();
  for (const entry of queue.values()) {
    const waitedSeconds = Math.max(0, Math.floor((now - entry.joinedAt) / 1000));
    send(entry.ws, { type: 'queue', status: `WAITING FOR OPPONENT... (${waitedSeconds}s)`, queuedPlayers: queue.size, waitedSeconds, matchmaking: 'any-rank', serverNow: now });
  }
  for (const [id, match] of matches) if (match.finished && now - match.finishedAt > 60 * 60 * 1000) matches.delete(id);
}, 5000);
statusTicker.unref();
httpServer.listen(PORT, () => console.log(`Kel Puzzle Ranked server listening on :${PORT}`));
