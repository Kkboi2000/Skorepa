/* ============================================================
   Skore Party — dial.js
   The K-wave length dial, extracted and parameterized.

   createDial(mount, opts) → controller
     opts.needle        : boolean — render a draggable needle (guest view)
     opts.onNeedleSet   : fn(angle) — fires when a drag finishes on a new spot

   controller:
     setTarget(angle)          rotate the score bands to `angle`
     spinTo(landing, onDone)   3s cruise+decel spin (host only)
     setCover(show)            show/hide the mint shield over the bands
     setNeedle(angle) / getNeedle()
     setNeedleEnabled(bool)    allow/deny dragging
     setGhosts(list)           [{angle, name, color}] extra needles (reveal)
     isSpinning()
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 200, CY = 228, R_FACE = 186;
const BAND_VALUES = [2, 3, 4, 3, 2];
const BAND_WIDTH = 9;
const TOTAL_SPAN = BAND_VALUES.length * BAND_WIDTH;
const PLAY_LIMIT = 90;   // needle & target sweep the full semicircle
let uid = 0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createDial(mount, opts = {}) {
  const { needle = true, onNeedleSet = null } = opts;
  const id = `dial${++uid}`;

  /* ---------- build the SVG shell ----------
     The clip path cuts the rotating band cluster to the top
     semicircular face, so when the range lands near a horizontal
     end the outer bands roll cleanly off — never a second range. */
  const svg = el('svg', {
    class: 'dial-svg', viewBox: '0 0 400 248',
    'aria-label': 'Skore Party dial'
  });
  const defs = el('defs');
  const clip = el('clipPath', { id: `${id}-clip` });
  clip.appendChild(el('path', { d: 'M 14 228 A 186 186 0 0 1 386 228 Z' }));
  defs.appendChild(clip);

  const scallops = el('g');
  const faceTop = el('path', { class: 'dial-face-top', d: 'M 14 228 A 186 186 0 0 1 386 228 Z' });
  const faceBot = el('path', { class: 'dial-face-bottom', d: 'M 14 228 A 186 186 0 0 0 386 228 Z' });
  const stars = el('g');
  const wedges = el('g', { 'clip-path': `url(#${id}-clip)` });
  const nums = el('g', { 'clip-path': `url(#${id}-clip)` });
  // shield laps slightly OVER the face (r190 vs 186) so no band sliver leaks
  const shield = el('path', { class: 'target-shield', d: 'M 10 231 A 190 190 0 0 1 390 231 Z' });
  const baseBar = el('rect', { x: -4, y: 226, width: 408, height: 26, fill: 'var(--navy)' });
  const ghosts = el('g');
  const needleGrp = el('g', { class: 'needle-grp' });
  needleGrp.appendChild(el('line', { class: 'needle-stick', x1: 200, y1: 228, x2: 200, y2: 92 }));
  needleGrp.appendChild(el('circle', { class: 'needle-hub-outer', cx: 200, cy: 228, r: 34 }));
  needleGrp.appendChild(el('circle', { class: 'needle-hub-inner', cx: 200, cy: 228, r: 20 }));
  if (!needle) needleGrp.style.display = 'none';

  [defs, scallops, faceTop, faceBot, stars, wedges, nums, shield, baseBar, ghosts, needleGrp]
    .forEach(n => svg.appendChild(n));

  // keep any pre-existing overlay div in the mount (guest waiting screen)
  const overlay = mount.querySelector('.board-overlay');
  mount.innerHTML = '';
  mount.appendChild(svg);
  if (overlay) mount.appendChild(overlay);

  /* ---------- decorations ---------- */
  buildScallops(scallops);
  buildStars(stars);
  drawBands(wedges, nums);

  /* ---------- state ---------- */
  const state = {
    targetAngle: 0,
    needleAngle: 0,
    needleEnabled: false,
    spinning: false
  };
  applyRotation();
  applyNeedle();

  /* ---------- needle drag ---------- */
  let dragging = false, dragStart = 0;
  function toAngle(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) * (400 / r.width);
    const y = (clientY - r.top) * (248 / r.height);
    return clamp(Math.atan2(x - CX, -(y - CY)) * 180 / Math.PI, -PLAY_LIMIT, PLAY_LIMIT);
  }
  function onUpperFace(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) * (400 / r.width);
    const y = (clientY - r.top) * (248 / r.height);
    return (y <= CY + 2) && (Math.hypot(x - CX, y - CY) <= R_FACE + 12);
  }
  function startDrag(e) {
    if (!needle || !state.needleEnabled || state.spinning) return;
    const pt = e.touches ? e.touches[0] : e;
    if (!onUpperFace(pt.clientX, pt.clientY)) return;
    dragging = true;
    dragStart = state.needleAngle;
    needleGrp.classList.add('dragging');
    state.needleAngle = toAngle(pt.clientX, pt.clientY);
    applyNeedle();
    e.preventDefault();
  }
  function moveDrag(e) {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    state.needleAngle = toAngle(pt.clientX, pt.clientY);
    applyNeedle();
    e.preventDefault();
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    needleGrp.classList.remove('dragging');
    if (Math.abs(state.needleAngle - dragStart) > 0.5 && onNeedleSet) {
      onNeedleSet(state.needleAngle);
    }
  }
  svg.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag);
  svg.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('touchend', endDrag);

  /* ---------- internals ---------- */
  function applyRotation() {
    const tr = `rotate(${state.targetAngle} ${CX} ${CY})`;
    wedges.setAttribute('transform', tr);
    nums.setAttribute('transform', tr);
    // gentle rim ripple while spinning (from the original)
    const rA = Math.sin(state.targetAngle * Math.PI / 11) * 2;
    const rS = 1 + Math.sin(state.targetAngle * Math.PI / 9) * 0.008;
    scallops.setAttribute('transform',
      `translate(${CX} ${CY}) rotate(${rA}) scale(${rS}) translate(${-CX} ${-CY})`);
  }
  function applyNeedle() {
    needleGrp.setAttribute('transform', `rotate(${state.needleAngle} ${CX} ${CY})`);
  }

  /* ---------- public API ---------- */
  return {
    setTarget(a) { state.targetAngle = a ?? 0; applyRotation(); },

    /* 3-second spin: steady cruise for 2.5s, decelerate over the
       final 0.5s, landing EXACTLY on `landing`. Duration is the
       constant; speed is derived from distance. */
    spinTo(landing, onDone) {
      if (state.spinning) return;
      state.spinning = true;
      const TOTAL_MS = 3000, DECEL_MS = 500, CRUISE_MS = TOTAL_MS - DECEL_MS;
      const startAngle = state.targetAngle % 360;
      const totalDelta = 360 + (landing - startAngle);   // one full turn + landing
      const absDelta = Math.abs(totalDelta);
      const dir = totalDelta < 0 ? -1 : 1;
      const cruiseSec = CRUISE_MS / 1000, decelSec = DECEL_MS / 1000;
      const v = absDelta / (cruiseSec + decelSec / 2);
      const cruiseDeg = v * cruiseSec;
      const t0 = performance.now();
      const frame = (now) => {
        const t = now - t0;
        let deg;
        if (t < CRUISE_MS) deg = v * (t / 1000);
        else if (t < TOTAL_MS) {
          const td = (t - CRUISE_MS) / 1000;
          deg = cruiseDeg + (v * td - 0.5 * (v / decelSec) * td * td);
        } else deg = absDelta;
        state.targetAngle = startAngle + dir * Math.min(deg, absDelta);
        applyRotation();
        if (t < TOTAL_MS) requestAnimationFrame(frame);
        else {
          state.targetAngle = landing;
          applyRotation();
          state.spinning = false;
          if (onDone) onDone(landing);
        }
      };
      requestAnimationFrame(frame);
    },

    setCover(show) { shield.classList.toggle('shield-hidden', !show); },
    setNeedle(a) { state.needleAngle = clamp(a ?? 0, -PLAY_LIMIT, PLAY_LIMIT); applyNeedle(); },
    getNeedle() { return state.needleAngle; },
    setNeedleEnabled(b) {
      state.needleEnabled = !!b;
      needleGrp.classList.toggle('disabled', !b);
    },
    isSpinning() { return state.spinning; },

    /* Ghost needles for the reveal: thin colored sticks + name tags. */
    setGhosts(list) {
      ghosts.innerHTML = '';
      (list || []).forEach(g => {
        if (g.angle == null) return;
        const grp = el('g', { transform: `rotate(${g.angle} ${CX} ${CY})` });
        grp.appendChild(el('line', {
          class: 'ghost-stick', x1: 200, y1: 224, x2: 200, y2: 96,
          stroke: g.color || '#1c3a5e'
        }));
        grp.appendChild(el('circle', { cx: 200, cy: 96, r: 7, fill: g.color || '#1c3a5e' }));
        const label = el('text', { class: 'ghost-label', x: 200, y: 86, fill: g.color || '#1c3a5e' });
        label.textContent = (g.name || '').slice(0, 8);
        grp.appendChild(label);
        ghosts.appendChild(grp);
      });
    }
  };
}

/* ---------- decoration builders (from the original) ---------- */
function el(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function polar(deg, r) {
  const rad = deg * Math.PI / 180;
  return { x: CX + Math.sin(rad) * r, y: CY - Math.cos(rad) * r };
}
function wedgePath(a0, a1, r) {
  const p0 = polar(a0, r), p1 = polar(a1, r), large = (a1 - a0) > 180 ? 1 : 0;
  return `M ${CX} ${CY} L ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y} Z`;
}
function buildScallops(group) {
  const teeth = 44, rOut = R_FACE + 14;
  const disc = el('path', {
    d: `M ${CX - rOut} ${CY} A ${rOut} ${rOut} 0 0 1 ${CX + rOut} ${CY} Z`,
    class: 'scallop'
  });
  group.appendChild(disc);
  for (let i = 0; i <= teeth; i++) {
    const ang = Math.PI * (i / teeth);
    group.appendChild(el('circle', {
      cx: CX + Math.cos(Math.PI - ang) * rOut,
      cy: CY - Math.sin(Math.PI - ang) * rOut,
      r: 8, class: 'scallop'
    }));
  }
}
function buildStars(group) {
  for (let i = 0; i < 70; i++) {
    const ang = Math.random() * Math.PI, rr = Math.random() * R_FACE * 0.95;
    const x = CX + Math.cos(ang) * rr, y = CY + Math.sin(ang) * rr * 0.98;
    if (y < CY + 4) continue;
    group.appendChild(el('circle', {
      cx: x, cy: y, r: Math.random() * 1.3 + 0.4, class: 'star'
    }));
  }
}
function drawBands(wedges, nums) {
  const fill = ['#f3b50a', '#e8642a', '#9cc3dd', '#e8642a', '#f3b50a'];
  const start = -TOTAL_SPAN / 2;   // single cluster centered on top
  for (let i = 0; i < BAND_VALUES.length; i++) {
    const a0 = start + i * BAND_WIDTH, a1 = a0 + BAND_WIDTH;
    wedges.appendChild(el('path', { d: wedgePath(a0, a1, R_FACE - 2), fill: fill[i] }));
    const mid = (a0 + a1) / 2, np = polar(mid, R_FACE - 22);
    const t = el('text', { x: np.x, y: np.y, class: 'band-num' });
    t.textContent = BAND_VALUES[i];
    nums.appendChild(t);
  }
}
