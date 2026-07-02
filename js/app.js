/* ============================================================
   Skore Party — app.js
   Screen router + game state machine.

   Data flow is one-directional and reactive:
     Supabase realtime  →  onRoom / onPlayers  →  render()
   Local clicks only ever call net.js writes; the resulting
   database change echoes back and re-renders every client.

   The one secret that never syncs: S.localTarget — the host's
   spun target angle — which only reaches the server at reveal.
   ============================================================ */
import {
  createRoom, joinRoom, watchRoom, fetchPlayer,
  startGame, deploy, reveal, scoreFor, continueRound,
  backToLobby, deleteRoom,
  offerHost, declineHost, acceptHost,
  lockAnswer, leaveRoom
} from './net.js';
import { createDial } from './dial.js';

const $ = id => document.getElementById(id);
const DECKS = window.WAVELENGTH_WORDS;
const GHOST_COLORS = ['#d6322e', '#1c3a5e', '#6bbfa6', '#e8742f',
  '#7b5cd6', '#c2306e', '#2e8bd6', '#5f8a2e'];

/* ------------------------------------------------------------
   STATE
   ------------------------------------------------------------ */
const S = {
  name: '', myId: null, code: null,
  room: null, players: [], unsub: null,

  // host-only, local memory (deliberately never synced pre-reveal)
  localTarget: null, hasSpun: false,

  // host word prefs
  wordMode: 'suggested', deckLang: 'en', deckIndex: 0,
  customLeft: '', customRight: '',

  // ui bookkeeping
  dial: null, dialRole: null,
  structKey: '', roundKey: '',
  guestHidScores: false,
  seenInvite: null, toldInviteSent: null
};

/* ------------------------------------------------------------
   SMALL UI HELPERS
   ------------------------------------------------------------ */
function showScreen(name) {
  for (const s of ['title', 'lobby', 'game']) {
    $(`screen-${s}`).hidden = (s !== name);
  }
  const inRoom = name !== 'title';
  $('roomBadge').hidden = !inRoom;
  $('meBadge').hidden = !inRoom;
  if (inRoom) {
    $('roomBadgeCode').textContent = S.code || '';
    $('meBadge').textContent = `👤 ${S.name}`;
  }
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function openModal(id, open) { $(id).classList.toggle('open', open); }

const deckPair = () => {
  const deck = DECKS[S.deckLang] || DECKS.en;
  return deck[((S.deckIndex % deck.length) + deck.length) % deck.length];
};
const shuffleDeck = () => {
  const deck = DECKS[S.deckLang] || DECKS.en;
  if (deck.length > 1) {
    let n; do { n = Math.floor(Math.random() * deck.length); } while (n === S.deckIndex);
    S.deckIndex = n;
  }
};

/* ------------------------------------------------------------
   ROOM LIFECYCLE
   ------------------------------------------------------------ */
function enterRoom(code, playerId) {
  S.code = code;
  S.myId = playerId;
  sessionStorage.setItem('skore_session',
    JSON.stringify({ code, playerId, name: S.name }));
  S.unsub = watchRoom(code, {
    onRoom(room) {
      if (!room) { cleanup(); toast('Room closed'); return; }
      S.room = room;
      render();
    },
    onPlayers(players) {
      S.players = players;
      render();
    }
  });
}

function cleanup() {
  if (S.unsub) { S.unsub(); S.unsub = null; }
  sessionStorage.removeItem('skore_session');
  Object.assign(S, {
    myId: null, code: null, room: null, players: [],
    localTarget: null, hasSpun: false,
    dial: null, dialRole: null, structKey: '', roundKey: '',
    guestHidScores: false, seenInvite: null, toldInviteSent: null
  });
  $('dialMount').querySelectorAll('svg').forEach(n => n.remove());
  showScreen('title');
}

// Refresh-proof: resume the same seat if the tab reloads mid-game.
async function tryResume() {
  const raw = sessionStorage.getItem('skore_session');
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    const me = await fetchPlayer(saved.playerId);
    if (!me) throw new Error('gone');
    S.name = saved.name || me.name;
    $('nameInput').value = S.name;
    enterRoom(saved.code, saved.playerId);
  } catch {
    sessionStorage.removeItem('skore_session');
  }
}

/* ------------------------------------------------------------
   MASTER RENDER — called on every realtime echo
   ------------------------------------------------------------ */
function render() {
  const room = S.room;
  if (!room || !S.myId) return;

  const me = S.players.find(p => p.id === S.myId);
  if (S.players.length && !me) { cleanup(); toast('You left the room'); return; }

  const isHost = room.host_id === S.myId;
  const guests = S.players.filter(p => p.id !== room.host_id);

  handleInvites(room, isHost);

  if (room.phase === 'lobby') {
    renderLobby(isHost);
    showScreen('lobby');
    return;
  }

  showScreen('game');
  renderGame(room, me, isHost, guests);
}

/* ------------------------------------------------------------
   LOBBY
   ------------------------------------------------------------ */
function renderLobby(isHost) {
  $('lobbyCode').textContent = S.code;
  const row = $('lobbyPlayers');
  row.innerHTML = '';
  for (const p of S.players) {
    const chip = document.createElement('span');
    chip.className = 'chip'
      + (p.id === S.room.host_id ? ' host' : '')
      + (p.id === S.myId ? ' me' : '');
    chip.textContent = (p.id === S.room.host_id ? '🎙️ ' : '') + p.name;
    row.appendChild(chip);
  }
  $('startBtn').hidden = !isHost;
  $('startBtn').disabled = S.players.length < 2;
  $('lobbyWaiting').hidden = isHost;
}

/* ------------------------------------------------------------
   GAME
   ------------------------------------------------------------ */
function renderGame(room, me, isHost, guests) {
  // (re)build the dial when my role changes (host: no needle)
  const role = isHost ? 'host' : 'guest';
  if (S.dialRole !== role || !S.dial) {
    S.dialRole = role;
    S.dial = createDial($('dialMount'), {
      needle: !isHost,
      onNeedleSet: () => { /* position is read at lock time */ }
    });
    S.structKey = ''; // force a structural pass
  }

  // per-round resets when a fresh prep phase begins
  const roundKey = `${room.phase === 'prep' ? 'prep' : 'live'}|${room.round}|${room.host_id}`;
  if (room.phase === 'prep' && S.roundKey !== roundKey) {
    S.hasSpun = false;
    S.localTarget = null;
    S.guestHidScores = false;
    shuffleDeck();               // fresh suggested pair each round
    S.dial.setGhosts([]);
    S.dial.setTarget(0);
  }
  S.roundKey = roundKey;

  // structural pass: panels + clue card, only when the shape changes
  const structKey = [role, room.phase, room.round, S.wordMode, S.deckLang].join('|');
  if (S.structKey !== structKey) {
    S.structKey = structKey;
    renderStructure(room, isHost);
  }

  // live pass: things that change with every player update
  renderLive(room, me, isHost, guests);
}

/* ---------- structural pass ---------- */
function renderStructure(room, isHost) {
  const phase = room.phase;

  $('hostPrepPanel').hidden = !(isHost && phase === 'prep');
  $('hostAimPanel').hidden = !(isHost && phase === 'aiming');
  $('guestAimPanel').hidden = !(!isHost && phase === 'aiming');
  $('scorePanel').hidden = (phase !== 'revealed');
  $('hostEndButtons').hidden = !isHost;
  $('guestEndButtons').hidden = isHost;

  // board overlay: guests wait while the host prepares
  $('boardOverlay').hidden = !(!isHost && phase === 'prep');

  // dial cover & target visibility per role/phase
  if (isHost) {
    S.dial.setCover(false);                          // host always sees the bands
    S.dial.setTarget(phase === 'revealed' ? room.target_angle : (S.localTarget ?? 0));
  } else {
    if (phase === 'revealed') {
      S.dial.setCover(false);
      S.dial.setTarget(room.target_angle ?? 0);
    } else {
      S.dial.setCover(true);                         // hidden until reveal
      S.dial.setTarget(0);
      if (phase === 'prep') {
        S.dial.setNeedleEnabled(false);
        S.dial.setNeedle(0);
      }
    }
  }

  renderClueCard(room, isHost);

  // segmented controls reflect host prefs
  document.querySelectorAll('#modeSeg button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === S.wordMode));
  document.querySelectorAll('#langSeg button').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === S.deckLang));
  $('langSeg').style.visibility = (S.wordMode === 'suggested') ? 'visible' : 'hidden';

  if (isHost && phase === 'prep') updateDeployEnabled();
}

/* ---------- clue card ---------- */
function renderClueCard(room, isHost) {
  const left = $('leftStack'), right = $('rightStack');
  left.innerHTML = ''; right.innerHTML = '';
  const editable = isHost && room.phase === 'prep' && S.wordMode === 'custom';
  const suggested = isHost && room.phase === 'prep' && S.wordMode === 'suggested';

  $('shuffleBtn').hidden = !suggested;

  if (editable) {
    left.appendChild(makeWordInput('left'));
    right.appendChild(makeWordInput('right'));
    return;
  }

  let lw, rw;
  if (suggested) {
    const pair = deckPair();
    lw = pair.left; rw = pair.right;
  } else {
    lw = room.left_word || '· · ·';
    rw = room.right_word || '· · ·';
  }
  left.appendChild(makeWordDiv(lw));
  right.appendChild(makeWordDiv(rw));
}

function makeWordDiv(text) {
  const d = document.createElement('div');
  d.className = 'w-main';
  d.setAttribute('dir', 'auto');
  d.textContent = text;
  return d;
}
function makeWordInput(side) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'w-edit';
  inp.setAttribute('dir', 'auto');
  inp.placeholder = '…';
  inp.value = side === 'left' ? S.customLeft : S.customRight;
  inp.addEventListener('input', () => {
    if (side === 'left') S.customLeft = inp.value;
    else S.customRight = inp.value;
    updateDeployEnabled();
  });
  return inp;
}

/* ---------- live pass ---------- */
function renderLive(room, me, isHost, guests) {
  const phase = room.phase;

  if (isHost && phase === 'aiming') {
    // lock status list
    const list = $('lockList');
    list.innerHTML = '';
    for (const g of guests) {
      const row = document.createElement('div');
      row.className = 'lock-row' + (g.locked ? ' locked' : '');
      row.innerHTML = `<span>${escapeHtml(g.name)}</span>
        <span class="status">${g.locked
          ? '🔒 Locked in'
          : '<span class="mini-spinner"></span> thinking…'}</span>`;
      list.appendChild(row);
    }
    const allLocked = guests.length > 0 && guests.every(g => g.locked);
    const canReveal = allLocked && S.localTarget != null;
    $('revealBtn').disabled = !canReveal;
    $('revealHint').textContent =
      S.localTarget == null
        ? '⚠️ Target was lost after a page reload — restart the round below.'
        : allLocked
          ? 'Everyone is in — reveal when ready!'
          : `Waiting for every guest to lock in… (${guests.filter(g => g.locked).length}/${guests.length})`;
    ensureRestartButton(S.localTarget == null, room);
  }

  if (!isHost && phase === 'aiming') {
    const locked = !!(me && me.locked);
    S.dial.setNeedleEnabled(!locked);
    if (locked && me.needle != null) S.dial.setNeedle(me.needle);
    $('lockBtn').disabled = locked;
    $('lockBtn').querySelector('span:last-child').textContent =
      locked ? 'Locked ✓' : 'Lock answer';
    const done = guests.filter(g => g.locked).length;
    $('guestAimHint').textContent = locked
      ? `Locked in! Waiting for the others… (${done}/${guests.length})`
      : 'Drag the needle to where you think the target hides, then lock it in.';
  }

  if (phase === 'revealed') {
    // everyone sees every guest's needle at the reveal moment
    const withColor = guests.map((g, i) => ({ ...g, color: GHOST_COLORS[i % GHOST_COLORS.length] }));
    const ghosts = withColor
      .filter(g => isHost || g.id !== S.myId)   // guests keep their own real needle
      .map(g => ({ angle: g.needle, name: g.name, color: g.color }));
    S.dial.setGhosts(ghosts);
    if (!isHost && me && me.needle != null) {
      S.dial.setNeedle(me.needle);
      S.dial.setNeedleEnabled(false);
    }
    renderScores(room, withColor);
    $('scorePanel').hidden = (!isHost && S.guestHidScores);
    $('boardOverlay').hidden = !( !isHost && S.guestHidScores );
    $('boardOverlayText').textContent = 'waiting… for host';
  }
}

function renderScores(room, guests) {
  const tbody = $('scoreTable').querySelector('tbody');
  tbody.innerHTML = '';
  const sorted = [...guests].sort((a, b) => b.score - a.score);
  for (const g of sorted) {
    const round = scoreFor(g.needle, room.target_angle);
    const tr = document.createElement('tr');
    if (g.id === S.myId) tr.className = 'me';
    tr.innerHTML = `
      <td><span class="dot" style="background:${g.color}"></span>${escapeHtml(g.name)}</td>
      <td class="pts ${round >= 3 ? 'big' : ''}">${round > 0 ? '+' + round : '0'}</td>
      <td class="pts">${g.score}</td>`;
    tbody.appendChild(tr);
  }
}

/* Emergency exit if the host reloaded mid-round and lost the local target. */
function ensureRestartButton(show, room) {
  let btn = $('restartRoundBtn');
  if (show && !btn) {
    btn = document.createElement('button');
    btn.id = 'restartRoundBtn';
    btn.className = 'btn btn-ghost';
    btn.innerHTML = '<span>♻️</span><span>Restart round</span>';
    btn.addEventListener('click', () => continueRound(S.code, room.round));
    $('hostAimPanel').appendChild(btn);
  } else if (!show && btn) {
    btn.remove();
  }
}

/* ------------------------------------------------------------
   SWITCH-HOST INVITATIONS
   ------------------------------------------------------------ */
function handleInvites(room, isHost) {
  const pending = room.pending_host;

  // I'm being invited
  const invitedMe = pending === S.myId && !isHost;
  if (invitedMe && S.seenInvite !== pending) {
    S.seenInvite = pending;
    openModal('inviteOverlay', true);
  }
  if (!invitedMe) {
    S.seenInvite = null;
    openModal('inviteOverlay', false);
  }

  // I'm the host who sent it
  if (isHost && pending && S.toldInviteSent !== pending) {
    S.toldInviteSent = pending;
    const target = S.players.find(p => p.id === pending);
    toast(`Invitation sent to ${target ? target.name : 'player'}…`);
  }
  if (!pending) S.toldInviteSent = null;
}

/* ------------------------------------------------------------
   EVENT WIRING
   ------------------------------------------------------------ */
function requireName() {
  const name = $('nameInput').value.trim();
  if (!name) { showEntryError('Give yourself a name first!'); return null; }
  S.name = name;
  return name;
}
function showEntryError(msg) {
  const e = $('entryError');
  e.textContent = msg;
  e.hidden = false;
  setTimeout(() => { e.hidden = true; }, 3500);
}

$('newGameBtn').addEventListener('click', async () => {
  const name = requireName(); if (!name) return;
  $('newGameBtn').disabled = true;
  try {
    const { code, playerId } = await createRoom(name);
    enterRoom(code, playerId);
  } catch (err) {
    showEntryError(err.message || 'Could not create room');
  } finally {
    $('newGameBtn').disabled = false;
  }
});

$('joinToggleBtn').addEventListener('click', () => {
  const row = $('joinRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('codeInput').focus();
});

$('joinBtn').addEventListener('click', doJoin);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
async function doJoin() {
  const name = requireName(); if (!name) return;
  const code = $('codeInput').value.trim();
  if (!/^\d{5}$/.test(code)) { showEntryError('Room codes are 5 digits.'); return; }
  $('joinBtn').disabled = true;
  try {
    const { playerId } = await joinRoom(code, name);
    enterRoom(code, playerId);
  } catch (err) {
    showEntryError(err.message || 'Could not join room');
  } finally {
    $('joinBtn').disabled = false;
  }
}

/* ----- lobby ----- */
$('startBtn').addEventListener('click', () => startGame(S.code));
$('lobbyLeaveBtn').addEventListener('click', async () => {
  const isHost = S.room && S.room.host_id === S.myId;
  if (isHost) {
    if (!confirm('Leaving as host closes the room for everyone. Close it?')) return;
    await deleteRoom(S.code);
  } else {
    await leaveRoom(S.myId);
  }
  cleanup();
});

/* ----- host prep ----- */
document.querySelectorAll('#modeSeg button').forEach(b =>
  b.addEventListener('click', () => {
    S.wordMode = b.dataset.mode;
    S.structKey = '';           // force clue card rebuild
    render();
  }));
document.querySelectorAll('#langSeg button').forEach(b =>
  b.addEventListener('click', () => {
    S.deckLang = b.dataset.lang;
    shuffleDeck();
    S.structKey = '';
    render();
  }));
$('shuffleBtn').addEventListener('click', () => {
  shuffleDeck();
  renderClueCard(S.room, true);
});

$('spinBtn').addEventListener('click', () => {
  if (!S.dial || S.dial.isSpinning()) return;
  $('spinBtn').disabled = true;
  $('deployBtn').disabled = true;
  const landing = (Math.random() * 2 - 1) * 90;
  S.dial.spinTo(landing, (a) => {
    S.localTarget = a;          // ← the secret, kept local until reveal
    S.hasSpun = true;
    $('spinBtn').disabled = false;
    updateDeployEnabled();
  });
});

function currentWords() {
  if (S.wordMode === 'custom') {
    return { left: S.customLeft.trim(), right: S.customRight.trim() };
  }
  const p = deckPair();
  return { left: p.left, right: p.right };
}
function updateDeployEnabled() {
  const { left, right } = currentWords();
  $('deployBtn').disabled = !(S.hasSpun && left && right);
  $('hostHint').textContent = !S.hasSpun
    ? 'Pick the words, spin the target, give your one-word clue out loud, then deploy.'
    : (!left || !right)
      ? 'Type both ends of the spectrum, then deploy.'
      : 'Target set! Say your clue, then deploy to the guests.';
}

$('deployBtn').addEventListener('click', async () => {
  const { left, right } = currentWords();
  if (!left || !right || S.localTarget == null) return;
  $('deployBtn').disabled = true;
  await deploy(S.code, left, right, S.wordMode);
});

/* ----- host aiming ----- */
$('revealBtn').addEventListener('click', async () => {
  const guests = S.players.filter(p => p.id !== S.room.host_id);
  if (S.localTarget == null) return;
  $('revealBtn').disabled = true;
  await reveal(S.code, S.localTarget, guests);
});

/* ----- guest aiming ----- */
$('lockBtn').addEventListener('click', async () => {
  if (!S.dial) return;
  $('lockBtn').disabled = true;
  await lockAnswer(S.myId, S.dial.getNeedle());
});

/* ----- round end ----- */
$('continueBtn').addEventListener('click', () =>
  continueRound(S.code, S.room.round));

$('switchHostBtn').addEventListener('click', () => {
  const list = $('pickHostList');
  list.innerHTML = '';
  const guests = S.players.filter(p => p.id !== S.room.host_id);
  for (const g of guests) {
    const b = document.createElement('button');
    b.textContent = g.name;
    b.addEventListener('click', async () => {
      openModal('pickHostOverlay', false);
      await offerHost(S.code, g.id);
    });
    list.appendChild(b);
  }
  openModal('pickHostOverlay', true);
});
$('pickHostCancel').addEventListener('click', () =>
  openModal('pickHostOverlay', false));

$('hostExitBtn').addEventListener('click', () => backToLobby(S.code));

$('guestContinueBtn').addEventListener('click', () => {
  S.guestHidScores = true;      // dismiss scores, wait for the host
  render();
});
$('guestExitBtn').addEventListener('click', async () => {
  await leaveRoom(S.myId);
  cleanup();
});

/* ----- host invitation ----- */
$('inviteAcceptBtn').addEventListener('click', async () => {
  openModal('inviteOverlay', false);
  await acceptHost(S.code, S.myId, S.room.host_id);
  toast('You are the host now! 🎙️');
});
$('inviteDeclineBtn').addEventListener('click', async () => {
  openModal('inviteOverlay', false);
  await declineHost(S.code);
});

/* ------------------------------------------------------------
   MISC
   ------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// best-effort seat release when a guest closes the tab
window.addEventListener('pagehide', () => {
  if (S.myId && S.room && S.room.host_id !== S.myId) {
    // fire-and-forget; the sweep trigger cleans up anything missed
    leaveRoom(S.myId);
  }
});

showScreen('title');
tryResume();
