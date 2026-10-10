const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const BATTLE_TIME_MS = 30 * 60 * 1000;
const RECONNECT_GRACE_MS = 30 * 1000;
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, '{}');
const players = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8') || '{}');
const queue = new Map();
const matches = new Map();
function savePlayers() { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2)); }
function tier(points) {
  if (points >= 6300) return 'ETERNAL'; if (points >= 5200) return 'LEGEND'; if (points >= 4300) return 'MYTHIC';
  if (points >= 3500) return 'GRANDMASTER'; if (points >= 2700) return 'MASTER'; if (points >= 2000) return 'DIAMOND';
  if (points >= 1400) return 'PLATINUM'; if (points >= 900) return 'GOLD'; if (points >= 500) return 'SILVER';
  if (points >= 200) return 'BRONZE'; return 'IRON';
}
function ensurePlayer(id, displayName, points) {
  if (!players[id]) players[id] = { id, name: displayName || `Player-${id.slice(-4)}`, points: Math.max(0, Number(points) | 0), wins: 0, losses: 0, streak: 0, history: [] };
  players[id].name = displayName || players[id].name; return players[id];
}
function send(ws, payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function broadcastMatch(match, payload) { match.players.forEach(p => send(p.ws, payload)); }
function reward(my, opp) { return Math.max(20, Math.min(35, 25 + Math.max(-5, Math.min(10, Math.floor((opp.points - my.points) / 100))))); }
function penalty(my, opp) { return Math.max(15, Math.min(28, 20 + Math.max(-5, Math.min(8, Math.floor((my.points - opp.points) / 100))))); }
function rangeForWait(ms) { return ms < 5000 ? 50 : ms < 10000 ? 100 : ms < 20000 ? 200 : 300; }
function matchForPlayer(id) { for (const m of matches.values()) if (!m.finished && m.players.some(p => p.id === id)) return m; return null; }
function matchFoundPayload(match, player) {
  const opp = match.players.find(p => p.id !== player.id);
  return { type:'match_found', matchId:match.id, opponentName:opp.name, opponentPoints:players[opp.id]?.points ?? opp.points,
    opponentPuzzleSkin:opp.puzzleSkin || 'classic', opponentGridSkin:opp.gridSkin || 'classic', seed:match.seed,
    startAt:match.startAt || 0, endsAt:match.endsAt || 0, reconnecting:!!match.startedAt };
}
function tryMatch() {
  const waiting = [...queue.values()].sort((a,b) => a.joinedAt - b.joinedAt);
  for (let i=0; i<waiting.length; i++) {
    const a = waiting[i]; if (!queue.has(a.id)) continue;
    const range = rangeForWait(Date.now() - a.joinedAt);
    const b = waiting.slice(i+1).find(x => queue.has(x.id) && Math.abs(x.points - a.points) <= Math.max(range, rangeForWait(Date.now()-x.joinedAt)));
    if (!b) continue;
    queue.delete(a.id); queue.delete(b.id);
    const id = crypto.randomUUID();
    const seed = Number((BigInt(Date.now()) ^ (BigInt(a.points) << 17n) ^ (BigInt(b.points) << 3n)) % 9000000000000000n);
    const match = { id, players:[a,b], seed, createdAt:Date.now(), ready:new Set(), finished:false, startedAt:0, startAt:0, endsAt:0, timeout:null };
    matches.set(id, match); a.matchId = id; b.matchId = id;
    send(a.ws, matchFoundPayload(match, a)); send(b.ws, matchFoundPayload(match, b));
  }
}
function finishDraw(match) {
  if (match.finished) return;
  match.finished = true; if (match.timeout) clearTimeout(match.timeout);
  for (const p of match.players) {
    const profile = players[p.id]; profile.history.unshift({ matchId:match.id, result:'DRAW', delta:0, at:Date.now() });
    profile.history = profile.history.slice(0,50);
    send(p.ws, { type:'result', result:'DRAW', delta:0, newPoints:profile.points, rank:tier(profile.points) });
  }
  savePlayers();
}
function finishMatch(match, winnerId, reason='completed') {
  if (match.finished) return;
  match.finished = true; if (match.timeout) clearTimeout(match.timeout);
  const winner = match.players.find(p => p.id === winnerId); const loser = match.players.find(p => p.id !== winnerId);
  if (!winner || !loser) return;
  const wp = players[winner.id], lp = players[loser.id]; const gain = reward(wp, lp), loss = penalty(lp, wp);
  wp.points += gain; wp.wins++; wp.streak++; lp.points = Math.max(0, lp.points - loss); lp.losses++; lp.streak = 0;
  wp.history.unshift({ matchId:match.id, result:'WIN', delta:gain, reason, at:Date.now() });
  lp.history.unshift({ matchId:match.id, result:'LOSS', delta:-loss, reason, at:Date.now() });
  wp.history = wp.history.slice(0,50); lp.history = lp.history.slice(0,50); savePlayers();
  send(winner.ws, { type:'result', result:'WIN', delta:gain, newPoints:wp.points, rank:tier(wp.points) });
  send(loser.ws, { type:'result', result:'LOSS', delta:-loss, newPoints:lp.points, rank:tier(lp.points) });
}
function startBattle(match) {
  if (match.finished || match.startedAt) return;
  match.startAt = Date.now() + 1000; match.startedAt = match.startAt; match.endsAt = match.startAt + BATTLE_TIME_MS;
  broadcastMatch(match, { type:'battle_start', startAt:match.startAt, endsAt:match.endsAt, durationMs:BATTLE_TIME_MS });
  match.timeout = setTimeout(() => {
    if (match.finished) return;
    const [a,b] = match.players; const as = Math.max(0, Number(a.lastScore) || 0), bs = Math.max(0, Number(b.lastScore) || 0);
    if (as === bs) finishDraw(match); else finishMatch(match, as > bs ? a.id : b.id, 'timeout');
  }, Math.max(0, match.endsAt - Date.now()));
}
function sendOpponentState(match, player) {
  const opp = match.players.find(p => p.id !== player.id); if (!opp) return;
  send(player.ws, { type:'opponent_progress', percent:opp.lastPercent || 0, score:opp.lastScore || 0 });
  if (opp.lastBoard) send(player.ws, { type:'opponent_board', board:opp.lastBoard, slots:opp.lastSlots || [] });
}
const httpServer = http.createServer((req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true,service:'kel-puzzle-ranked',queue:queue.size,matches:matches.size})); }
  if (req.url === '/leaderboard') { const list=Object.values(players).sort((a,b)=>b.points-a.points).slice(0,100).map((p,i)=>({rank:i+1,name:p.name,points:p.points,tier:tier(p.points),wins:p.wins,losses:p.losses})); res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}); return res.end(JSON.stringify(list)); }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocket.Server({ server:httpServer });
wss.on('connection', ws => {
  let player = null; let attachedMatch = null;
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'queue') {
        player = ensurePlayer(String(m.playerId || ''), String(m.displayName || ''), Number(m.points || 0));
        const active = matchForPlayer(player.id);
        if (active) {
          attachedMatch = active; const entry = active.players.find(p => p.id === player.id);
          if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null; entry.ws = ws; entry.disconnectedAt = 0;
          send(ws, matchFoundPayload(active, entry));
          if (active.startedAt) send(ws, { type:'battle_start', startAt:active.startAt, endsAt:active.endsAt, durationMs:BATTLE_TIME_MS });
          sendOpponentState(active, entry);
          return;
        }
        if (queue.has(player.id)) { const previous = queue.get(player.id); if (previous.ws !== ws) send(previous.ws,{type:'error',message:'Signed in on another connection.'}); }
        const entry = { id:player.id, name:player.name, points:player.points, puzzleSkin:String(m.puzzleSkin||'classic'), gridSkin:String(m.gridSkin||'classic'), ws, joinedAt:Date.now(), matchId:null };
        queue.set(player.id, entry); player = entry;
        send(ws,{type:'queue',status:'FINDING OPPONENT...'}); tryMatch(); return;
      }
      const match = attachedMatch || (player ? matchForPlayer(player.id) : null);
      if (!match || match.finished) return send(ws,{type:'error',message:'No active match.'});
      const entry = match.players.find(p => p.id === player.id); if (!entry) return;
      if (m.type === 'ready') { match.ready.add(player.id); if (match.ready.size === 2) startBattle(match); }
      else if (m.type === 'progress') {
        const percent = Math.max(0,Math.min(99,Number(m.percent)||0)); const score = Math.max(0,Math.floor(Number(m.score)||0));
        if (!Number.isFinite(score) || score < (entry.lastScore || 0) || percent < (entry.lastPercent || 0)) return;
        entry.lastPercent = percent; entry.lastScore = score;
        if (Array.isArray(m.board) && m.board.length >= 64) { entry.lastBoard=m.board.slice(0,64).map(v=>Number(v)||0); if (Array.isArray(m.slots)&&m.slots.length>=64) entry.lastSlots=m.slots.slice(0,64).map(v=>Number(v)||-1); }
        const opp=match.players.find(p=>p.id!==player.id); send(opp.ws,{type:'opponent_progress',percent,score});
        if (entry.lastBoard) send(opp.ws,{type:'opponent_board',board:entry.lastBoard,slots:entry.lastSlots||[]});
      } else if (m.type === 'finished') {
        const reason = String(m.reason || 'completed');
        if (reason === 'no_moves') finishMatch(match, match.players.find(p=>p.id!==player.id).id, 'no_moves');
        else if (reason === 'timeout') {
          entry.lastScore = Math.max(entry.lastScore || 0, Math.floor(Number(m.score)||0));
          const other = match.players.find(p=>p.id!==player.id); const ownScore=entry.lastScore||0, otherScore=other.lastScore||0;
          if (ownScore === otherScore) finishDraw(match); else finishMatch(match, ownScore > otherScore ? player.id : other.id, 'timeout');
        } else {
          // Finishing early is not a win condition in score-based ranked matches.
          send(ws,{type:'error',message:'Ranked match ends when no moves remain or the 30-minute timer expires.'});
        }
      }
    } catch (_) { send(ws,{type:'error',message:'Invalid message.'}); }
  });
  ws.on('close', () => {
    if (!player) return;
    queue.delete(player.id);
    const match = attachedMatch || matchForPlayer(player.id);
    if (match && !match.finished) {
      const entry=match.players.find(p=>p.id===player.id); if (!entry) return;
      if (entry.ws === ws) {
        entry.ws = null; entry.disconnectedAt = Date.now();
        if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = setTimeout(() => { if (!match.finished && !entry.ws) finishMatch(match, match.players.find(p=>p.id!==player.id).id, 'disconnect_forfeit'); }, RECONNECT_GRACE_MS);
        const opp=match.players.find(p=>p.id!==player.id); send(opp.ws,{type:'opponent_disconnected',graceMs:RECONNECT_GRACE_MS});
      }
    }
  });
});
setInterval(tryMatch,1000);
setInterval(()=>{ for (const [id,m] of matches) if (m.finished && Date.now()-m.createdAt>60*60*1000) matches.delete(id); },60*1000);
httpServer.listen(PORT,()=>console.log(`Kel Puzzle Ranked server listening on :${PORT}`));
