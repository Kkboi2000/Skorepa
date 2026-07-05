/* ============================================================
   Skore Party — app.js
   Screen router + game state machine.

   Data flow is one-directional and reactive:
     Supabase realtime  →  onRoom / onPlayers  →  render()
   Local clicks only ever call net.js writes; the resulting
   database change echoes back and re-renders every client.

   The one secret that never syncs: S.localTarget — the host's
   spun/dragged target angle — which only reaches the server at reveal.
   ============================================================ */
import {
  createRoom, joinRoom, watchRoom, fetchPlayer,
  startGame, deploy, setTopic, broadcastTopic, reveal, scoreFor, continueRound,
  backToLobby, deleteRoom, resetScores,
  offerHost, declineHost, acceptHost,
  lockAnswer, leaveRoom
} from './net.js';
import { createDial } from './dial.js';
import {
  prefs, mainLang, setLangPref, setSoundPref, playSound,
  LANGS, LANG_MODES
} from './prefs.js';
import { t, applyI18n } from './i18n.js';

const $ = id => document.getElementById(id);
const DECKS = window.WAVELENGTH_WORDS;

// Every player owns a distinct needle hue. Colours are assigned by the
// player's position in the (joined_at-ordered) roster, so every client
// computes the SAME colour for the SAME player without any extra sync.
const NEEDLE_RED = '#d6322e';
const NEEDLE_COLORS = [
  '#d81e3f', // red
  '#1f6dd6', // blue
  '#17a34a', // green
  '#8e2bd0', // violet
  '#e23ba0', // pink
  '#0d8f8f', // teal
  '#7a4a1e', // brown
  '#2b3350', // near-black slate
  '#b81365', // berry
  '#00517a'  // deep petrol
];
function guestColorMap(guests) {
  const m = {};
  guests.forEach((g, i) => { m[g.id] = NEEDLE_COLORS[i % NEEDLE_COLORS.length]; });
  return m;
}

/* ------------------------------------------------------------
   STATE
   ------------------------------------------------------------ */
const S = {
  name: '', myId: null, code: null,
  room: null, players: [], unsub: null,

  // host-only, local memory (deliberately never synced pre-reveal)
  localTarget: null, hasSpun: false,

  // host word prefs (language is per-device now — see prefs.js)
  wordMode: 'suggested', deckIndex: 0,
  customLeft: '', customRight: '',

  // host topic box (synced via rooms.topic + a realtime broadcast mirror)
  topicOn: false, topicDraft: '', topicMode: '', topicLive: null,

  // ui bookkeeping
  dial: null, dialRole: null,
  structKey: '', roundKey: '', lastPhase: null, prefsRev: 0,
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
  $('exitBtn').hidden = (name !== 'game');   // quick-exit on every game stage
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

/* Decks are PARALLEL translations: index i is the same pair in every
   language. The pair index is the identity that syncs between players;
   which language(s) you see it in is your own device's business. */
const deckLen = () => (DECKS[mainLang()] || DECKS.en).length;
const normIndex = i => ((i % deckLen()) + deckLen()) % deckLen();
const deckPair = () => (DECKS[mainLang()] || DECKS.en)[normIndex(S.deckIndex)];
const shuffleDeck = () => {
  if (deckLen() > 1) {
    let n; do { n = Math.floor(Math.random() * deckLen()); } while (n === S.deckIndex);
    S.deckIndex = n;
  }
};
/* Reverse lookup: recover the pair index from deployed words so every
   client can render the SAME problem in its own languages. Custom
   words return null and render as fixed text. */
function findPairIndex(leftWord, rightWord) {
  if (!leftWord || !rightWord) return null;
  for (const lang of Object.keys(DECKS)) {
    const i = DECKS[lang].findIndex(p => p.left === leftWord && p.right === rightWord);
    if (i !== -1) return i;
  }
  return null;
}

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
      if (!room) { cleanup(); toast(t('room_closed')); return; }
      S.room = room;
      render();
    },
    onPlayers(players) {
      S.players = players;
      render();
    },
    onTopic(topic) {              // live mirror (used when the DB column is absent)
      S.topicLive = topic;
      render();
    }
  });
}

function cleanup() {
  if (S.unsub) { S.unsub(); S.unsub = null; }
  sessionStorage.removeItem('skore_session');
  clearTimeout(topicTimer);
  Object.assign(S, {
    myId: null, code: null, room: null, players: [],
    localTarget: null, hasSpun: false,
    topicOn: false, topicDraft: '', topicMode: '', topicLive: null,
    dial: null, dialRole: null, structKey: '', roundKey: '', lastPhase: null,
    guestHidScores: false, seenInvite: null, toldInviteSent: null
  });
  const tm = $('topicMount'); if (tm) tm.innerHTML = '';
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
  if (S.players.length && !me) { cleanup(); toast(t('left_room')); return; }

  const isHost = room.host_id === S.myId;
  const guests = S.players.filter(p => p.id !== room.host_id);

  // phase-transition sounds (fire once per transition, on every client)
  if (room.phase === 'revealed' && S.lastPhase !== 'revealed' && S.lastPhase !== null) {
    playSound('reveal');
  }
  if (room.phase === 'prep' && S.lastPhase === 'lobby') playSound('start');   // game starts
  if (room.phase === 'aiming' && S.lastPhase === 'prep') playSound('deploy'); // host deploys
  S.lastPhase = room.phase;

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
  $('resetScoreBtn').hidden = !isHost;   // host can wipe totals from the lobby
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
      onNeedleSet: () => playSound('point'),   // position is read at lock time
      onTargetSet: (a) => {                     // host dragged the score-range
        S.localTarget = a;
        S.hasSpun = true;
        playSound('point');
        updateDeployEnabled();
      }
    });
    if (!isHost) S.dial.setNeedleColor(guestColorMap(guests)[S.myId] || NEEDLE_RED);
    S.structKey = ''; // force a structural pass
  }

  // per-round resets when a fresh prep phase begins
  const roundKey = `${room.phase === 'prep' ? 'prep' : 'live'}|${room.round}|${room.host_id}`;
  if (room.phase === 'prep' && S.roundKey !== roundKey) {
    S.hasSpun = false;
    S.localTarget = null;
    S.guestHidScores = false;
    S.topicOn = false;           // each round starts with no topic set
    S.topicDraft = '';
    shuffleDeck();               // fresh suggested pair each round
    S.dial.setGhosts([]);
    S.dial.setTarget(0);
    S.dial.setNeedleLabel('');
  }
  S.roundKey = roundKey;

  // structural pass: panels + clue card, only when the shape changes
  const structKey = [role, room.phase, room.round, S.wordMode, S.prefsRev].join('|');
  if (S.structKey !== structKey) {
    S.structKey = structKey;
    renderStructure(room, isHost);
  }

  // live pass: things that change with every player update
  renderLive(room, me, isHost, guests);

  // topic box (below the board) — recomputed every render, cheap
  renderTopic();
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
    S.dial.setTargetDraggable(phase === 'prep');     // drag the range to place the target
  } else {
    S.dial.setTargetDraggable(false);
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

  /* The pair index — not the text — is the problem's identity.
     Language prefs change how it's DISPLAYED on this device only;
     the deployed problem itself never changes. */
  let pairIndex, lw, rw;
  if (suggested) {
    pairIndex = normIndex(S.deckIndex);
  } else {
    pairIndex = findPairIndex(room.left_word, room.right_word);
    lw = room.left_word || '· · ·';
    rw = room.right_word || '· · ·';
  }

  if (pairIndex == null) {           // custom words: fixed text, main only
    left.appendChild(makeWordDiv(lw));
    right.appendChild(makeWordDiv(rw));
    return;
  }
  fillWordStack(left, pairIndex, 'left');
  fillWordStack(right, pairIndex, 'right');
}

/* Stack order: Sub ▲ (small) → Main (big) → Sub ▼ (small). */
function fillWordStack(container, pairIndex, side) {
  const wordIn = lang => (DECKS[lang] && DECKS[lang][pairIndex])
    ? DECKS[lang][pairIndex][side] : null;
  for (const l of LANGS) {
    if (prefs.langs[l.key] === 'up') {
      const w = wordIn(l.key); if (w) container.appendChild(makeWordDiv(w, 'w-sub'));
    }
  }
  const mw = wordIn(mainLang()); if (mw) container.appendChild(makeWordDiv(mw));
  for (const l of LANGS) {
    if (prefs.langs[l.key] === 'down') {
      const w = wordIn(l.key); if (w) container.appendChild(makeWordDiv(w, 'w-sub'));
    }
  }
}

function makeWordDiv(text, cls = 'w-main') {
  const d = document.createElement('div');
  d.className = cls;
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

/* ------------------------------------------------------------
   TOPIC BOX (below the board)
   Host: add (+ dashed box), edit, remove (✕). Guests: read-only.
   Synced through the rooms.topic column (see net.js setTopic).
     null → box removed;  '' → present but empty;  text → shown.
   ------------------------------------------------------------ */
let topicTimer = null;

function pushTopic(topic) {
  broadcastTopic(topic);                 // instant live mirror to every guest
  if (!S.code) return Promise.resolve();
  return setTopic(S.code, topic).catch(() => { /* column is optional — broadcast covers live sync */ });
}
function debouncePushTopic(v) {
  clearTimeout(topicTimer);
  topicTimer = setTimeout(() => pushTopic(v), 350);
}
function autoGrowTopic(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}

function renderTopic() {
  const room = S.room;
  const mount = $('topicMount');
  if (!room || !mount) return;
  const isHost = room.host_id === S.myId;
  const phase = room.phase;

  // when the DB column exists it is authoritative; otherwise use the live mirror
  const colPresent = Object.prototype.hasOwnProperty.call(room, 'topic');
  const liveTopic = colPresent ? room.topic : S.topicLive;

  let mode;
  if (phase === 'lobby') mode = 'hidden';
  else if (isHost) mode = S.topicOn ? 'host-edit' : 'host-add';
  else mode = ((phase === 'aiming' || phase === 'revealed') && liveTopic) ? 'guest-show' : 'hidden';

  if (mode !== S.topicMode) {
    S.topicMode = mode;
    mount.innerHTML = '';

    if (mode === 'host-add') {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'topic-add';
      add.innerHTML = '<span class="plus">+</span><span>' + t('topic_add') + '</span>';
      add.addEventListener('click', () => {
        S.topicOn = true;
        S.topicDraft = '';
        pushTopic('');
        renderTopic();
        const inp = $('topicInput');
        if (inp) inp.focus();
      });
      mount.appendChild(add);

    } else if (mode === 'host-edit') {
      const box = document.createElement('div');
      box.className = 'topic-box';
      const label = document.createElement('div');
      label.className = 'topic-label';
      label.textContent = t('topic_label');
      const inp = document.createElement('textarea');
      inp.id = 'topicInput';
      inp.className = 'topic-input';
      inp.rows = 1;
      inp.maxLength = 90;
      inp.setAttribute('dir', 'auto');
      inp.placeholder = t('topic_ph');
      inp.value = S.topicDraft;
      inp.addEventListener('input', () => {
        S.topicDraft = inp.value;
        autoGrowTopic(inp);
        debouncePushTopic(inp.value);
      });
      inp.addEventListener('blur', () => { clearTimeout(topicTimer); pushTopic(S.topicDraft); });
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'topic-remove';
      rm.setAttribute('aria-label', 'Remove topic');
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        S.topicOn = false;
        S.topicDraft = '';
        clearTimeout(topicTimer);
        pushTopic(null);
        renderTopic();
      });
      box.appendChild(label);
      box.appendChild(inp);
      box.appendChild(rm);
      mount.appendChild(box);
      autoGrowTopic(inp);

    } else if (mode === 'guest-show') {
      const box = document.createElement('div');
      box.className = 'topic-box readonly';
      const label = document.createElement('div');
      label.className = 'topic-label';
      label.textContent = t('topic_label');
      const text = document.createElement('div');
      text.className = 'topic-text';
      text.id = 'topicText';
      text.setAttribute('dir', 'auto');
      box.appendChild(label);
      box.appendChild(text);
      mount.appendChild(box);
    }
  }

  if (mode === 'guest-show') {
    const t = $('topicText');
    if (t) t.textContent = liveTopic || '';
  }
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
          ? t('lock_locked')
          : '<span class="mini-spinner"></span> ' + t('lock_thinking')}</span>`;
      list.appendChild(row);
    }
    const allLocked = guests.length > 0 && guests.every(g => g.locked);
    const canReveal = allLocked && S.localTarget != null;
    $('revealBtn').disabled = !canReveal;
    $('revealHint').textContent =
      S.localTarget == null
        ? t('hint_reveal_lost')
        : allLocked
          ? t('hint_reveal_all')
          : t('hint_reveal_wait').replace('{done}', guests.filter(g => g.locked).length).replace('{total}', guests.length);
    ensureRestartButton(S.localTarget == null, room);
  }

  if (!isHost && phase === 'aiming') {
    S.dial.setNeedleColor(guestColorMap(guests)[S.myId] || NEEDLE_RED);
    const locked = !!(me && me.locked);
    S.dial.setNeedleEnabled(!locked);
    if (locked && me.needle != null) S.dial.setNeedle(me.needle);
    $('lockBtn').disabled = locked;
    $('lockBtn').querySelector('span:last-child').textContent =
      locked ? t('locked') : t('lock_answer');
    const done = guests.filter(g => g.locked).length;
    $('guestAimHint').textContent = locked
      ? t('hint_guest_locked').replace('{done}', done).replace('{total}', guests.length)
      : t('hint_guest_aim');
  }

  if (phase === 'revealed') {
    // everyone sees every player's needle at the reveal moment,
    // each in its owner's colour with a name tag.
    const cmap = guestColorMap(guests);
    const withColor = guests.map(g => ({ ...g, color: cmap[g.id] || NEEDLE_RED }));
    const ghosts = withColor
      .filter(g => g.id !== S.myId)             // your own needle stays the main one
      .map(g => ({ angle: g.needle, name: g.name, color: g.color }));
    S.dial.setGhosts(ghosts);
    if (!isHost && me && me.needle != null) {
      S.dial.setNeedle(me.needle);
      S.dial.setNeedleEnabled(false);
      S.dial.setNeedleColor(cmap[S.myId] || NEEDLE_RED);
      S.dial.setNeedleLabel(me.name);           // your name rides your needle
    }
    renderScores(room, withColor);
    $('scorePanel').hidden = (!isHost && S.guestHidScores);
    $('boardOverlay').hidden = !( !isHost && S.guestHidScores );
    $('boardOverlayText').textContent = t('overlay_waiting');
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
    btn.innerHTML = '<span>♻️</span><span>' + t('restart_round') + '</span>';
    btn.addEventListener('click', () =>
      continueRound(S.code, room.round)
        .catch(() => toast(t('err_restart'))));
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
    toast(t('invite_sent').replace('{name}', target ? target.name : 'player'));
  }
  if (!pending) S.toldInviteSent = null;
}

/* ------------------------------------------------------------
   EVENT WIRING
   ------------------------------------------------------------ */
function requireName() {
  const name = $('nameInput').value.trim();
  if (!name) { showEntryError(t('err_name')); return null; }
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
    showEntryError(err.message || t('err_create'));
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
  if (!/^\d{5}$/.test(code)) { showEntryError(t('err_code_digits')); return; }
  $('joinBtn').disabled = true;
  try {
    const { playerId } = await joinRoom(code, name);
    enterRoom(code, playerId);
  } catch (err) {
    showEntryError(err.message || t('err_join'));
  } finally {
    $('joinBtn').disabled = false;
  }
}

/* ----- lobby ----- */
$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    await startGame(S.code);
  } catch (err) {
    toast(err.message || t('err_start'));
    $('startBtn').disabled = false;
  }
  // on success the realtime echo flips phase → render() re-enables UI
});
async function leaveGame() {
  const isHost = S.room && S.room.host_id === S.myId;
  if (isHost) {
    if (!confirm(t('confirm_close_room'))) return;   // host leaving closes the room
    await deleteRoom(S.code);
  } else {
    await leaveRoom(S.myId);
  }
  cleanup();
}
$('lobbyLeaveBtn').addEventListener('click', leaveGame);
$('exitBtn').addEventListener('click', leaveGame);

/* ----- host prep ----- */
document.querySelectorAll('#modeSeg button').forEach(b =>
  b.addEventListener('click', () => {
    S.wordMode = b.dataset.mode;
    S.structKey = '';           // force clue card rebuild
    render();
  }));
$('shuffleBtn').addEventListener('click', () => {
  playSound('next');
  shuffleDeck();
  renderClueCard(S.room, true);
});

$('spinLever').addEventListener('click', () => {
  if (!S.dial || S.dial.isSpinning()) return;
  playSound('gear');
  const lever = $('spinLever');
  lever.classList.add('pulled');
  setTimeout(() => lever.classList.remove('pulled'), 340);
  lever.classList.add('disabled');            // no double-pull mid-spin
  $('deployBtn').disabled = true;
  const landing = (Math.random() * 2 - 1) * 90;
  S.dial.spinTo(landing, (a) => {
    S.localTarget = a;          // ← the secret, kept local until reveal
    S.hasSpun = true;
    lever.classList.remove('disabled');
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
    ? t('hint_prep_start')
    : (!left || !right)
      ? t('hint_prep_words')
      : t('hint_prep_ready');
}

$('deployBtn').addEventListener('click', async () => {
  const { left, right } = currentWords();
  if (!left || !right || S.localTarget == null) return;
  $('deployBtn').disabled = true;
  clearTimeout(topicTimer);
  await pushTopic(S.topicOn ? S.topicDraft.trim() : null);   // publish final topic (or clear it) BEFORE phase flips
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
  playSound('lock');
  $('lockBtn').disabled = true;
  await lockAnswer(S.myId, S.dial.getNeedle());
});

/* ----- round end ----- */
$('continueBtn').addEventListener('click', () =>
  continueRound(S.code, S.room.round)
    .catch(() => toast(t('err_next'))));

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

$('hostExitBtn').addEventListener('click', () =>
  backToLobby(S.code)
    .catch(() => toast(t('err_lobby'))));

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
  toast(t('now_host'));
});
$('inviteDeclineBtn').addEventListener('click', async () => {
  openModal('inviteOverlay', false);
  await declineHost(S.code);
});

/* ----- reset scores (host) ----- */
$('resetScoreBtn').addEventListener('click', () => openModal('resetScoreOverlay', true));
$('resetScoreNo').addEventListener('click', () => openModal('resetScoreOverlay', false));
$('resetScoreOverlay').addEventListener('click', e => {
  if (e.target === $('resetScoreOverlay')) openModal('resetScoreOverlay', false);
});
$('resetScoreYes').addEventListener('click', async () => {
  openModal('resetScoreOverlay', false);
  try { await resetScores(S.code); toast(t('scores_reset')); }
  catch { toast(t('err_reset')); }
});

/* ------------------------------------------------------------
   SETTINGS (⚙️ per-device: language display + sound)
   Changing these NEVER touches room state — only how this
   device renders the same shared problem.
   ------------------------------------------------------------ */
function renderSettings() {
  // language matrix
  const grid = $('langGrid');
  grid.innerHTML = '';
  for (const l of LANGS) {
    const row = document.createElement('div');
    row.className = 'lang-row';
    const name = document.createElement('span');
    name.className = 'lang-name';
    name.textContent = l.label;
    row.appendChild(name);
    const opts = document.createElement('div');
    opts.className = 'lang-opts';
    for (const m of LANG_MODES) {
      const b = document.createElement('button');
      b.className = 'lang-opt' + (prefs.langs[l.key] === m.value ? ' active' : '');
      b.textContent = t({ main: 'mode_main', up: 'mode_sub_up', down: 'mode_sub_down', none: 'mode_none' }[m.value]);
      // the one Main can't be demoted directly — pick a new Main instead
      b.disabled = prefs.langs[l.key] === 'main' && m.value !== 'main';
      b.addEventListener('click', () => {
        if (setLangPref(l.key, m.value)) onPrefsChanged();
      });
      opts.appendChild(b);
    }
    row.appendChild(opts);
    grid.appendChild(row);
  }
  // sound toggle
  document.querySelectorAll('#soundSeg button').forEach(b =>
    b.classList.toggle('active', (b.dataset.sound === 'on') === prefs.sound));
}

function onPrefsChanged() {
  S.prefsRev++;                 // invalidates the structural render key
  applyI18n();                  // the Main language may have changed the whole UI
  renderSettings();
  if (S.room) render();         // live re-render of the clue card
}

$('settingsBtn').addEventListener('click', () => {
  renderSettings();
  openModal('settingsOverlay', true);
});
$('settingsCloseBtn').addEventListener('click', () =>
  openModal('settingsOverlay', false));
$('settingsOverlay').addEventListener('click', e => {
  if (e.target === $('settingsOverlay')) openModal('settingsOverlay', false);
});
document.querySelectorAll('#soundSeg button').forEach(b =>
  b.addEventListener('click', () => {
    setSoundPref(b.dataset.sound === 'on');   // plays 'ping' on off → on
    renderSettings();
  }));

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
    leaveRoom(S.myId).catch(() => {});
  }
});

applyI18n();          // paint the UI in the saved Main language
showScreen('title');
tryResume();
