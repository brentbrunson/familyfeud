'use strict';
// Family Feud — online edition. Zero dependencies. Many games ("rooms") can run at once,
// each with its own 4-letter code, its own questions, and its own host key.
//   node server.js        then open http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAMPLE = require('./sample.js');
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUB = path.join(__dirname, 'public');

// Clock lengths (seconds). The TV only shows the last 5 seconds of these
// "answer clocks"; the extra second(s) give the host time to call the team.
const CLOCK_FIRST = 6; // after a buzz-in
const CLOCK_NEXT = 7; // next team / next player

// ---------- validating / cleaning a game setup ----------
const str = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const int = (x, lo, hi, d) => {
  const v = Math.round(Number(x));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
};
function cleanAnswers(list, maxN) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const text = str(Array.isArray(a) ? a[0] : a && a.text, 60);
    if (!text) continue;
    out.push([text, int(Array.isArray(a) ? a[1] : a && a.pts, 0, 999, 0)]);
    if (out.length >= maxN) break;
  }
  return out.map((a, i) => ({ a, i })).sort((x, y) => y.a[1] - x.a[1] || x.i - y.i).map((o) => o.a); // highest first
}
function cleanData(d) {
  if (!d || typeof d !== 'object') return { error: 'No game data.' };
  const rounds = [];
  for (const r of Array.isArray(d.rounds) ? d.rounds.slice(0, 6) : []) {
    const question = str(r && r.question, 200);
    const answers = cleanAnswers(r && r.answers, 8);
    if (!question || !answers.length) continue;
    rounds.push({ title: str(r.title, 60) || 'Round ' + (rounds.length + 1), mult: int(r.mult, 1, 5, 1), question, answers });
  }
  if (!rounds.length) return { error: 'Add at least one round with a question and one answer.' };
  const fm = d.fastMoney || {};
  const questions = [];
  if (fm.enabled !== false) {
    for (const q of Array.isArray(fm.questions) ? fm.questions.slice(0, 7) : []) {
      const text = str(q && q.q, 200);
      const answers = cleanAnswers(q && q.answers, 8);
      if (!text || !answers.length) continue;
      questions.push({ q: text, answers });
    }
  }
  let logo = '';
  if (typeof d.logo === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(d.logo) && d.logo.length < 450000) logo = d.logo;
  const teams = Array.isArray(d.teams) ? d.teams : [];
  return {
    data: {
      title: str(d.title, 40) || 'Family Feud',
      logo,
      teams: [str(teams[0], 24) || 'Team A', str(teams[1], 24) || 'Team B'],
      rounds,
      fastMoney: {
        target: int(fm.target, 1, 2000, 200),
        p1Seconds: int(fm.p1Seconds, 5, 60, 20),
        p2Seconds: int(fm.p2Seconds, 5, 60, 25),
        questions
      }
    }
  };
}

// ---------- one game ----------
function makeRoom(code, key, data0) {
  let DATA = data0;
  let R = DATA.rounds;
  let FM = DATA.fastMoney;
  let NQ = FM.questions.length;
  // ---------- game state ----------
  let S;
  let timerTO = null;
  let awardTO = null;
  const clients = new Set();

  const blankEnts = () => Array.from({ length: NQ }, () => ({ pick: null, text: '' }));
  const falses = () => Array(NQ).fill(false);

  function fresh(prev) {
    return {
      screen: 'title', // title | round | fm | winner
      teams: {
        A: { name: (prev && prev.A) || 'Team A', score: 0 },
        B: { name: (prev && prev.B) || 'Team B', score: 0 }
      },
      roundIdx: -1,
      revealed: [],
      strikes: 0,
      control: null,
      phase: 'faceoff', // faceoff | play | steal | done
      buzzerOpen: false,
      buzz: null, // {team, name, cid, t}
      fo: { step: 0, first: null }, // face-off progress: 0 none, 1 first answered?, 2, 3 done
      timer: null, // {end, dur, team, vis}
      undo: null, // snapshot taken before the last strike
      awarded: null,
      fm: {
        q: 0,
        player: 1,
        ent: { 1: blankEnts(), 2: blankEnts() },
        shown: { 1: falses(), 2: falses() },
        masked: { 1: falses(), 2: falses() },
        finished: false
      }
    };
  }
  S = fresh({ A: DATA.teams[0], B: DATA.teams[1] });

  const other = (t) => (t === 'A' ? 'B' : 'A');
  const allRevealed = () => S.revealed.length > 0 && S.revealed.every(Boolean);

  function bank() {
    if (S.roundIdx < 0) return 0;
    const r = R[S.roundIdx];
    return r.answers.reduce((s, a, i) => s + (S.revealed[i] ? a[1] : 0), 0) * r.mult;
  }

  // ---- fast money helpers ----
  function fmInfo(p, i) {
    const e = S.fm.ent[p][i];
    if (e.pick !== null && e.pick >= 0) {
      const a = FM.questions[i].answers[e.pick];
      return { kind: 'ans', text: a[0], pts: a[1] };
    }
    const t = e.text.trim();
    return { kind: t ? 'typed' : 'blank', text: t, pts: 0 };
  }
  function fmCell(p, i, host) {
    const info = fmInfo(p, i);
    const shown = S.fm.shown[p][i];
    const masked = S.fm.masked[p][i];
    const o = { shown, masked, kind: info.kind };
    if (shown) {
      o.pts = info.pts;
      if (!masked) o.text = info.text;
    }
    if (host) {
      o.pick = S.fm.ent[p][i].pick;
      o.raw = S.fm.ent[p][i].text;
    }
    return o;
  }
  function fmTotal(p) {
    let t = 0;
    for (let i = 0; i < NQ; i++) if (S.fm.shown[p][i]) t += fmInfo(p, i).pts;
    return t;
  }
  function conns() {
    const c = { A: 0, B: 0 };
    for (const cl of clients) if (cl.role === 'buzz' && cl.team) c[cl.team]++;
    return c;
  }

  function build(host) {
    const st = {
      type: 'state',
      title: DATA.title,
      logo: DATA.logo || '',
      code,
      fmEnabled: NQ > 0,
      screen: S.screen,
      teams: S.teams,
      canUndo: !!S.undo,
      roundIdx: S.roundIdx,
      rounds: R.map((r) => r.title),
      strikes: S.strikes,
      control: S.control,
      phase: S.phase,
      buzzerOpen: S.buzzerOpen,
      buzz: S.buzz,
      timer: S.timer,
      awarded: S.awarded,
      now: Date.now(),
      conns: conns()
    };
    if (S.roundIdx >= 0) {
      const r = R[S.roundIdx];
      st.round = {
        title: r.title,
        mult: r.mult,
        label: r.mult === 1 ? 'Single points' : r.mult === 2 ? 'Double points' : r.mult === 3 ? 'Triple points' : r.mult + 'x points',
        question: r.question,
        bank: S.phase === 'done' && S.awarded ? S.awarded.pts : bank(),
        answers: r.answers.map((a, i) => {
          const rv = !!S.revealed[i];
          return rv || host ? { revealed: rv, text: a[0], pts: a[1] } : { revealed: false };
        })
      };
    }
    st.fm = {
      q: S.fm.q,
      player: S.fm.player,
      target: FM.target,
      secs: { 1: FM.p1Seconds, 2: FM.p2Seconds },
      question: NQ ? FM.questions[S.fm.q].q : '',
      rows: FM.questions.map((_, i) => ({ p1: fmCell(1, i, host), p2: fmCell(2, i, host) })),
      totals: { 1: fmTotal(1), 2: fmTotal(2) },
      finished: S.fm.finished
    };
    if (host) {
      st.fm.questions = FM.questions.map((qq) => ({
        q: qq.q,
        options: qq.answers.map((a) => ({ text: a[0], pts: a[1] }))
      }));
    }
    return st;
  }

  function send(c, obj) {
    try {
      c.res.write('data: ' + JSON.stringify(obj) + '\n\n');
    } catch (e) {}
  }
  function broadcast() {
    for (const c of clients) send(c, build(c.host));
  }
  function fx(name, extra) {
    const m = Object.assign({ type: 'fx', name }, extra || {});
    for (const c of clients) send(c, m);
  }

  // ---------- timer ----------
  // vis = how many of the last seconds the TV shows as a number.
  function startTimer(sec, team, vis, endFx) {
    stopTimer();
    sec = Math.max(1, Math.min(120, sec | 0));
    const t = { end: Date.now() + sec * 1000, dur: sec, team: team || null, vis: Math.min(vis || sec, sec) };
    S.timer = t;
    timerTO = setTimeout(() => {
      // A round answer clock that runs out = a strike (host can Undo it).
      if (!endFx && S.screen === 'round' && S.phase !== 'done') {
        doStrike();
        broadcast();
        return;
      }
      fx(endFx || 'timeup');
      timerTO = setTimeout(() => {
        if (S.timer === t) {
          S.timer = null;
          broadcast();
        }
      }, 2500);
    }, sec * 1000);
  }
  function stopTimer() {
    clearTimeout(timerTO);
    timerTO = null;
    S.timer = null;
  }
  const clockFor = (team, sec) => startTimer(sec, team, 5);

  // Called when the host reveals an answer or gives a strike.
  function afterAnswer() {
    stopTimer();
    if (S.screen !== 'round') return;
    if (S.phase === 'faceoff') {
      if (S.fo.step === 1) {
        S.fo.step = 2;
        if (S.fo.first) clockFor(other(S.fo.first), CLOCK_NEXT);
      } else if (S.fo.step === 2) {
        S.fo.step = 3;
      }
    }
  }

  function snap() {
    return {
      strikes: S.strikes,
      phase: S.phase,
      control: S.control,
      fo: { step: S.fo.step, first: S.fo.first },
      buzz: S.buzz,
      scores: { A: S.teams.A.score, B: S.teams.B.score },
      awarded: S.awarded
    };
  }
  function restore(sn) {
    clearTimeout(awardTO);
    stopTimer();
    S.strikes = sn.strikes;
    S.phase = sn.phase;
    S.control = sn.control;
    S.fo = sn.fo;
    S.buzz = sn.buzz;
    S.teams.A.score = sn.scores.A;
    S.teams.B.score = sn.scores.B;
    S.awarded = sn.awarded;
    S.undo = null;
  }
  function doStrike() {
    S.undo = snap();
    const was = S.phase;
    let n = 1;
    if (S.phase === 'play') {
      S.strikes = Math.min(3, S.strikes + 1);
      n = S.strikes;
      if (S.strikes >= 3) S.phase = 'steal';
    }
    fx('strike', { n });
    afterAnswer();
    if (was === 'steal' && S.control) resolveRound(S.control, 1600); // failed steal: original team keeps the points
  }

  // Give the round's bank to a team and close the round.
  function resolveRound(team, delay) {
    const pts = bank();
    S.teams[team].score += pts;
    S.awarded = { team, pts, prev: S.phase };
    S.phase = 'done';
    S.buzzerOpen = false;
    stopTimer();
    clearTimeout(awardTO);
    if (delay) awardTO = setTimeout(() => fx('award', { team, pts }), delay);
    else fx('award', { team, pts });
  }

  // ---------- round / FM helpers ----------
  function startRound(i) {
    if (i < 0 || i >= R.length) return;
    stopTimer();
    S.screen = 'round';
    S.roundIdx = i;
    S.revealed = Array(R[i].answers.length).fill(false);
    S.strikes = 0;
    S.control = null;
    S.phase = 'faceoff';
    S.buzzerOpen = false;
    S.buzz = null;
    S.fo = { step: 0, first: null };
    S.awarded = null;
  }
  function fmShowOne(p, q, v) {
    const was = S.fm.shown[p][q];
    S.fm.shown[p][q] = v;
    if (v) S.fm.masked[p][q] = false;
    if (v && !was) {
      S.fm.q = q;
      fx(fmInfo(p, q).kind === 'ans' ? 'ding' : 'strike', { n: 1 });
    }
  }

  // ---------- host actions ----------
  function act(a) {
    const team = a.team === 'A' || a.team === 'B' ? a.team : null;
    switch (a.action) {
      case 'goto':
        S.undo = null;
        if (a.to === 'title') {
          stopTimer();
          S.screen = 'title';
        } else if (a.to === 'fm' && NQ) {
          stopTimer();
          S.screen = 'fm';
        } else if (a.to === 'winner') {
          stopTimer();
          S.buzzerOpen = false;
          S.screen = 'winner';
          fx('winner');
        } else if (typeof a.to === 'number') startRound(a.to);
        break;
      case 'openBuzz':
        S.undo = null;
        stopTimer();
        S.buzz = null;
        S.fo = { step: 0, first: null };
        S.buzzerOpen = true;
        fx('ready');
        break;
      case 'clearBuzz':
        S.undo = null;
        stopTimer();
        S.buzz = null;
        S.buzzerOpen = false;
        S.fo = { step: 0, first: null };
        break;
      case 'control':
        S.undo = null;
        stopTimer();
        S.control = team;
        S.phase = team ? 'play' : 'faceoff';
        S.strikes = 0;
        S.buzz = null;
        S.buzzerOpen = false;
        break;
      case 'reveal': {
        if (S.roundIdx < 0) break;
        const i = a.i | 0;
        if (i < 0 || i >= S.revealed.length) break;
        const v = a.value === undefined ? !S.revealed[i] : !!a.value;
        const was = S.revealed[i];
        S.revealed[i] = v;
        if (v && !was) {
          S.undo = null;
          fx('ding');
          const ph = S.phase;
          afterAnswer();
          // Smart round flow
          if (ph === 'steal' && S.control) resolveRound(other(S.control), 1600); // successful steal
          else if (ph === 'play' && S.control && allRevealed()) resolveRound(S.control, 1600); // cleared the board
        }
        break;
      }
      case 'revealAll':
        if (S.roundIdx >= 0) {
          S.revealed = S.revealed.map(() => true);
          stopTimer();
        }
        break;
      case 'strike':
        doStrike();
        break;
      case 'strikeUndo':
        if (S.undo) restore(S.undo);
        else if (S.strikes > 0) {
          S.strikes--;
          if (S.phase === 'steal') S.phase = 'play';
          stopTimer();
        }
        break;
      case 'award':
        if (S.screen === 'round' && S.phase !== 'done' && team) {
          S.undo = null;
          resolveRound(team, 0);
        }
        break;
      case 'undoAward':
        if (S.phase === 'done' && S.awarded) {
          clearTimeout(awardTO);
          S.undo = null;
          S.teams[S.awarded.team].score -= S.awarded.pts;
          S.phase = S.awarded.prev || 'play';
          S.awarded = null;
        }
        break;
      case 'adjust':
        if (team) S.teams[team].score += a.delta | 0;
        S.undo = null;
        break;
      case 'rename':
        if (team) S.teams[team].name = String(a.name || '').slice(0, 24) || 'Team ' + team;
        break;
      case 'timer':
        startTimer(a.seconds, null, a.vis || a.seconds, a.end === 'long' ? 'timeupLong' : undefined);
        break;
      case 'timerStop':
        stopTimer();
        break;
      case 'fmPlayer':
        S.fm.player = a.p === 2 ? 2 : 1;
        break;
      case 'fmQ': {
        const q = a.q | 0;
        if (q >= 0 && q < NQ) S.fm.q = q;
        break;
      }
      case 'fmEntry': {
        const p = a.p === 2 ? 2 : 1;
        const q = a.q | 0;
        if (q < 0 || q >= NQ) break;
        const idx = a.pick;
        const ok = idx === null || (Number.isInteger(idx) && idx >= 0 && idx < FM.questions[q].answers.length);
        if (!ok) break;
        S.fm.ent[p][q] = { pick: idx, text: String(a.text || '').slice(0, 60) };
        break;
      }
      case 'fmShow': {
        const p = a.p === 2 ? 2 : 1;
        const q = a.q | 0;
        if (q < 0 || q >= NQ) break;
        fmShowOne(p, q, a.value === undefined ? !S.fm.shown[p][q] : !!a.value);
        break;
      }
      case 'fmShowAll': {
        const p = a.p === 2 ? 2 : 1;
        let d = 0;
        for (let q = 0; q < NQ; q++) {
          if (S.fm.shown[p][q] && !S.fm.masked[p][q]) continue;
          setTimeout(() => {
            fmShowOne(p, q, true);
            broadcast();
          }, d);
          d += 1000;
        }
        break;
      }
      case 'fmHide': {
        // hide the answer text (keep points + total) for every revealed row of a player
        const p = a.p === 2 ? 2 : 1;
        S.fm.masked[p] = S.fm.masked[p].map((m, i) => (S.fm.shown[p][i] ? true : m));
        break;
      }
      case 'fmDup':
        fx('dup'); // sound only; the clock is untouched
        break;
      case 'fmClear': {
        const p = a.p === 2 ? 2 : 1;
        S.fm.ent[p] = blankEnts();
        S.fm.shown[p] = falses();
        S.fm.masked[p] = falses();
        break;
      }
      case 'fmFinish': {
        S.fm.finished = true;
        const t = fmTotal(1) + fmTotal(2);
        fx(t >= FM.target ? 'win' : 'lose', { total: t });
        break;
      }
      case 'fmUnfinish':
        S.fm.finished = false;
        break;
      case 'reset':
        stopTimer();
        S = fresh({ A: S.teams.A.name, B: S.teams.B.name });
        break;
      default:
        return false;
    }
    broadcast();
    return true;
  }


  function buzz(b) {
    const team = b.team === 'B' ? 'B' : b.team === 'A' ? 'A' : null;
    if (!team) return false;
    if (S.buzzerOpen && !S.buzz && S.screen === 'round') {
      S.buzz = {
        team,
        name: String(b.name || '').trim().slice(0, 24) || 'Captain',
        cid: String(b.cid || '').slice(0, 40),
        t: Date.now()
      };
      S.buzzerOpen = false;
      fx('buzz', { team, who: S.buzz.name });
      if (S.phase === 'faceoff') {
        S.fo = { step: 1, first: team };
        clockFor(team, CLOCK_FIRST);
      }
      broadcast();
      return true;
    }
    return false;
  }

  // Replace the whole setup (restarts the game; names come from the setup).
  function setData(d) {
    stopTimer();
    clearTimeout(awardTO);
    DATA = d;
    R = d.rounds;
    FM = d.fastMoney;
    NQ = FM.questions.length;
    S = fresh({ A: d.teams[0], B: d.teams[1] });
    broadcast();
  }
  function destroy() {
    stopTimer();
    clearTimeout(awardTO);
    for (const c of clients) {
      try {
        c.res.end();
      } catch (e) {}
    }
    clients.clear();
  }

  return {
    code,
    key,
    last: Date.now(),
    clients,
    act,
    buzz,
    build,
    broadcast,
    setData,
    destroy,
    data: () => DATA,
    names: () => ({ title: DATA.title, A: S.teams.A.name, B: S.teams.B.name })
  };
}

// ---------- rooms ----------
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKMNPQRTUVWXY';
function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const newKey = () => crypto.randomBytes(6).toString('hex');
const getRoom = (u) => rooms.get(String(u.searchParams.get('r') || '').toUpperCase());
const okKey = (room, k) => {
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(room.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const createLog = new Map(); // ip -> [timestamps]
function createAllowed(ip) {
  const now = Date.now();
  const list = (createLog.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 30) return false;
  list.push(now);
  createLog.set(ip, list);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (r.clients.size === 0 && now - r.last > 12 * 3600e3) {
      r.destroy();
      rooms.delete(c);
    }
  }
  for (const [ip, l] of createLog) if (!l.some((t) => now - t < 3600e3)) createLog.delete(ip);
}, 10 * 60e3);

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4'
};

function body(req, limit) {
  return new Promise((resolve) => {
    let b = '';
    let dead = false;
    req.on('data', (d) => {
      b += d;
      if (b.length > limit && !dead) {
        dead = true;
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      if (dead) return;
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function file(res, name) {
  const fp = path.join(PUB, name);
  if (!fp.startsWith(PUB + path.sep) || path.basename(fp).startsWith('.')) return json(res, 404, { error: 'not found' });
  fs.readFile(fp, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/events') {
    const room = getRoom(u);
    if (!room) return json(res, 404, { error: 'no such game' });
    const role = u.searchParams.get('role') || 'display';
    const t = (u.searchParams.get('team') || '').toUpperCase();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1000\n\n');
    const c = { res, role, host: role === 'host' && okKey(room, u.searchParams.get('k')), team: role === 'buzz' && (t === 'A' || t === 'B') ? t : null };
    room.clients.add(c);
    room.last = Date.now();
    req.on('close', () => {
      room.clients.delete(c);
      room.last = Date.now();
      room.broadcast();
    });
    room.broadcast();
    return;
  }

  if (p === '/api/create' && req.method === 'POST') {
    if (rooms.size >= 300) return json(res, 503, { error: 'The server is busy. Try again later.' });
    if (!createAllowed(ipOf(req))) return json(res, 429, { error: 'Too many new games from this device. Try again later.' });
    const b = await body(req, 700000);
    const r = cleanData(b.data || SAMPLE);
    if (r.error) return json(res, 400, { error: r.error });
    const code = newCode();
    if (!code) return json(res, 503, { error: 'No free game codes right now.' });
    const room = makeRoom(code, newKey(), r.data);
    rooms.set(code, room);
    return json(res, 200, { code, key: room.key });
  }

  if (p === '/api/room') {
    const room = getRoom(u);
    if (!room) return json(res, 404, { exists: false });
    return json(res, 200, Object.assign({ exists: true }, room.names()));
  }

  if (p === '/api/sample') return json(res, 200, SAMPLE);

  if (p === '/api/data') {
    const room = getRoom(u);
    if (!room) return json(res, 404, { error: 'This game has ended. Start a new one from the home page.' });
    if (!okKey(room, u.searchParams.get('k'))) return json(res, 403, { error: 'Not authorized.' });
    room.last = Date.now();
    if (req.method === 'GET') return json(res, 200, room.data());
    if (req.method === 'POST') {
      const b = await body(req, 700000);
      const r = cleanData(b.data);
      if (r.error) return json(res, 400, { error: r.error });
      room.setData(r.data);
      return json(res, 200, { ok: true, data: r.data });
    }
  }

  if (p === '/api/buzz' && req.method === 'POST') {
    const room = getRoom(u);
    if (!room) return json(res, 404, { error: 'no such game' });
    room.last = Date.now();
    const b = await body(req, 2000);
    return json(res, 200, { first: room.buzz(b) });
  }

  if (p === '/api/act' && req.method === 'POST') {
    const room = getRoom(u);
    if (!room) return json(res, 404, { error: 'no such game' });
    if (!okKey(room, u.searchParams.get('k'))) return json(res, 403, { error: 'not authorized' });
    room.last = Date.now();
    const ok = room.act(await body(req, 5000));
    return json(res, ok ? 200 : 400, { ok });
  }

  if (p === '/') return file(res, 'home.html');
  if (p === '/tv') return file(res, 'display.html');
  if (p === '/host') return file(res, 'host.html');
  if (p === '/setup') return file(res, 'setup.html');
  if (p === '/b') return file(res, 'buzzer.html');
  if (p.startsWith('/j/')) return file(res, 'join.html');
  return file(res, p.replace(/^\/+/, ''));
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      try {
        c.res.write(':\n\n');
      } catch (e) {}
    }
  }
}, 15000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('\n  The game server is already running (port ' + PORT + ' is in use).');
    console.log('  Close the other window running it, then start again.\n');
  } else console.log(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Family Feud is running.  Open  http://localhost:' + PORT + '  to start a game.\n');
});
