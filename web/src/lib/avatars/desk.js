// Top-down "desk" avatar renderer — a flat-vector view-from-above of a person
// working at a desk: top of head/hair, shoulders, two arms reaching to a laptop,
// plus desk props (laptop w/ glowing screen, coffee, phone, notebook/papers).
//
// Canvas contract (matches pixel.js / abstract.js):
//   backing store is 240x200 (DPR=2), displayed at 120x100.
//   We clearRect the full backing store, then scale(2,2) and draw in 120x100
//   logical space, then restore. All motion is derived from the integer tick `t`
//   (deterministic — no Date.now / timers).
import { STATE_COLORS } from '../states.js';

const W = 120, H = 100, DPR = 2;
const CX = W / 2; // horizontal centre — the desk/figure are mirrored around this

// ── palettes ────────────────────────────────────────────────────────────────
const SHIRTS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4'];
const HAIRS = ['#3C2A1E', '#1F2937', '#5B3A29', '#6B4423', '#2D2D2D', '#7A4B2A', '#4A3020'];
const SKIN = '#E8B89B';

function hash(id) {
  let h = 0; const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Lighten/darken a hex color by amt in [-1,1] for simple shading.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const k = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round(r + (k - r) * p); g = Math.round(g + (k - g) * p); b = Math.round(b + (k - b) * p);
  return `rgb(${r},${g},${b})`;
}
// Rounded-rect path helper.
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── desk surface + scene tint ────────────────────────────────────────────────
function drawDesk(ctx, accent, isError) {
  // Warm desk plane filling the tile; faint accent (or red) wash overlaid.
  ctx.fillStyle = '#2B2622';
  rr(ctx, 4, 4, W - 8, H - 8, 10); ctx.fill();
  ctx.fillStyle = '#3A332D';
  rr(ctx, 4, 4, W - 8, H - 8, 10); ctx.fill();
  ctx.fillStyle = isError ? rgba('#EF4444', 0.10) : rgba(accent, 0.05);
  rr(ctx, 4, 4, W - 8, H - 8, 10); ctx.fill();
}

// ── the person, seen from above ──────────────────────────────────────────────
// dy shifts the whole figure vertically (idle leans back = sits lower in frame).
// Hand-drawn vector shapes (from assets/avatar-templates/desk-base_b.svg), authored
// on a 336x276 art board; we scale them into the 120x100 logical space. Lazily
// built so module load never needs Path2D (browser-only).
const ART_SX = 120 / 336, ART_SY = 100 / 276;
let _paths = null;
function paths() {
  if (_paths) return _paths;
  if (typeof Path2D === 'undefined') return null;
  _paths = {
    hair: new Path2D('M171.07,20.78c6.51,0,7.87,11.11,15.7,8.89,10.96-3.11,18.76,14.27,11.22,24.33-12.85,17.15-12.73,28.41-29.3,28.41s-17.78-10.41-30.7-28.41c-7.31-10.18.49-13.1,5.22-24.19,3.19-7.48,21.31-9.04,27.85-9.04Z'),
    sheen: new Path2D('M156.87,24.93c5.83-1.24,6.53,8.65,11.13,14.52,3.07,3.92,11.68.99,9.44,6.52-5.04,12.44.38,29.72-9.35,31.78s-15.41-6.09-18.51-20.67c-1.55-7.29-7.96-12.3-2.52-16.15,4.79-3.39,4.94-14.97,9.8-16Z'),
    face: new Path2D('M168,61.52c5.04,0,9.54-5.27,12.57-2.36,2.45,2.36,3.93,5.41,3.93,8.74,0,5.45-4,13.96-9.69,16.09-2.09.78-8.96,0-11.41,0-9.11,0-11.91-8.64-11.91-16.09,0-3.16,1.33-6.07,3.55-8.37,3.02-3.13,7.7,1.98,12.95,1.98Z'),
    shoulders: new Path2D('M112.7,111.74c.43-18.78.6-21.03,13.18-24.24,1.85-.47,3.79-.5,5.7-.5l36.42,6.67,36.42-6.67c1.91,0,3.83.09,5.7.5,9.69,2.16,11.03,5.75,11.03,24.53,0,6.26-4.25,24.91-7.11,29.93l-4.44,20.74c-5.01,8.77-6.56,12.72-16.59,13.93-23.23,2.8-26.59,4.55-49.48-.3-8.01-1.7-9.62-2.91-14.63-11.68l-1.37-20.61c-2.87-5.02-14.95-26.52-14.81-32.3Z'),
    collar: new Path2D('M140.63,85.79l26.74,39.73,30.22-41.48-19.09,2.96-10.5,21-10.5-21-16.87-1.21Z'),
    neck: (() => { const p = new Path2D(); p.rect(157.5, 72, 21, 33); return p; })(),
  };
  return _paths;
}

function drawBody(ctx, shirt, dy) {
  const p = paths();
  if (!p) return;
  ctx.save();
  ctx.translate(0, dy);
  ctx.scale(ART_SX, ART_SY);
  ctx.fillStyle = SKIN; ctx.fill(p.neck);
  ctx.fillStyle = shirt; ctx.fill(p.shoulders);           // recolored per-agent (was flat #ff0)
  ctx.fillStyle = shade(shirt, -0.28); ctx.fill(p.collar);
  ctx.restore();
}

function drawHead(ctx, hair, turn, dy) {
  // turn (px, 120-space) nudges the head for reading/searching glances; dy leans idle down.
  const p = paths();
  if (!p) return;
  ctx.save();
  ctx.translate(turn, dy);
  ctx.scale(ART_SX, ART_SY);
  ctx.fillStyle = hair; ctx.fill(p.hair);
  ctx.fillStyle = shade(hair, 0.18); ctx.fill(p.sheen);
  ctx.fillStyle = SKIN; ctx.fill(p.face);
  ctx.restore();
}

// One arm reaching from a shoulder to a target point (top-down "tube").
function drawArm(ctx, shirt, fromX, fromY, toX, toY) {
  ctx.strokeStyle = shirt;
  ctx.lineWidth = 9; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
  // Hand at the end.
  ctx.fillStyle = SKIN;
  ctx.beginPath(); ctx.arc(toX, toY, 4.5, 0, Math.PI * 2); ctx.fill();
}

// ── laptop (the centrepiece, slightly toward the front/bottom) ───────────────
// Returns the screen rect so callers can paint state-specific screen contents.
function drawLaptop(ctx, accent, screenFill) {
  const lw = 50, lh = 30, lx = CX - lw / 2, ly = 56;
  // Body / keyboard deck.
  ctx.fillStyle = '#3F3F46'; rr(ctx, lx - 3, ly + lh - 6, lw + 6, 12, 4); ctx.fill();
  ctx.fillStyle = '#52525B'; rr(ctx, lx - 1, ly + lh - 4, lw + 2, 8, 3); ctx.fill();
  // Screen bezel.
  ctx.fillStyle = '#18181B'; rr(ctx, lx, ly, lw, lh, 4); ctx.fill();
  // Screen.
  const sx = lx + 4, sy = ly + 4, sw = lw - 8, sh = lh - 8;
  ctx.fillStyle = screenFill || '#0F172A'; rr(ctx, sx, sy, sw, sh, 2); ctx.fill();
  // Accent glow spilling off the top edge of the screen toward the head.
  const g = ctx.createLinearGradient(0, sy, 0, sy - 14);
  g.addColorStop(0, rgba(accent, 0.5)); g.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = g; ctx.fillRect(sx - 2, sy - 14, sw + 4, 16);
  return { sx, sy, sw, sh };
}

// Scrolling code lines on the screen (coding / running).
function drawScreenCode(ctx, scr, t) {
  const cols = ['#38BDF8', '#10B981', '#F59E0B', '#A78BFA', '#F472B6', '#34D399'];
  const widths = [18, 28, 14, 22, 16, 30, 12, 24];
  const off = Math.floor(t / 3) % 8;
  ctx.save();
  rr(ctx, scr.sx, scr.sy, scr.sw, scr.sh, 2); ctx.clip();
  for (let r = 0; r < 5; r++) {
    const i = (r + off) % widths.length;
    ctx.fillStyle = cols[(r + Math.floor(t / 10)) % cols.length];
    rr(ctx, scr.sx + 3, scr.sy + 2 + r * 4, Math.min(widths[i], scr.sw - 6), 2, 1); ctx.fill();
  }
  ctx.restore();
}

// Big alternating ✓ / ✗ on the screen (testing).
function drawScreenTest(ctx, scr, t) {
  const pass = Math.floor(t / 30) % 2 === 0;
  const cx = scr.sx + scr.sw / 2, cy = scr.sy + scr.sh / 2;
  ctx.strokeStyle = pass ? '#10B981' : '#EF4444';
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pass) { ctx.moveTo(cx - 6, cy + 1); ctx.lineTo(cx - 1, cy + 6); ctx.lineTo(cx + 7, cy - 5); }
  else { ctx.moveTo(cx - 5, cy - 5); ctx.lineTo(cx + 5, cy + 5); ctx.moveTo(cx + 5, cy - 5); ctx.lineTo(cx - 5, cy + 5); }
  ctx.stroke();
}

// ── small static desk props (coffee / phone / notebook) ──────────────────────
function drawCoffee(ctx, accent, steam, t) {
  const cx = 26, cy = 30;
  ctx.fillStyle = '#E5E7EB'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6B3F1E'; ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2); ctx.fill();
  if (steam) {
    // Rising, wobbling steam wisps driven by t.
    ctx.strokeStyle = rgba('#FFFFFF', 0.35); ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const base = cx - 2 + i * 4, ph = t * 0.08 + i * 1.5;
      ctx.beginPath();
      for (let s = 0; s <= 8; s++) {
        const yy = cy - 6 - s * 1.6, xx = base + Math.sin(ph + s * 0.6) * 2.5;
        s === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
  }
}
function drawNotebook(ctx) {
  const nx = 90, ny = 24;
  ctx.save(); ctx.translate(nx, ny); ctx.rotate(0.18);
  ctx.fillStyle = '#F3F4F6'; rr(ctx, -10, -13, 20, 26, 2); ctx.fill();
  ctx.strokeStyle = '#D1D5DB'; ctx.lineWidth = 1;
  for (let r = 0; r < 5; r++) { ctx.beginPath(); ctx.moveTo(-7, -8 + r * 4); ctx.lineTo(7, -8 + r * 4); ctx.stroke(); }
  ctx.restore();
}

// ── main entry ───────────────────────────────────────────────────────────────
export function draw(ctx, agent, t) {
  ctx.clearRect(0, 0, W * DPR, H * DPR);
  ctx.imageSmoothingEnabled = true;

  const state = (agent && agent.state) || 'idle';
  const accent = STATE_COLORS[state] || STATE_COLORS.idle;
  const id = (agent && agent.id) || 'a';
  const shirt = (agent && agent.shirt) || SHIRTS[hash(id) % SHIRTS.length];
  const hair = HAIRS[hash(id + 'h') % HAIRS.length];

  ctx.save();
  ctx.scale(DPR, DPR);

  const isError = state === 'error';
  drawDesk(ctx, accent, isError);

  // Shoulder anchor points for the arms.
  const dyIdle = state === 'idle' ? 6 : 0; // idle leans back → figure sits lower
  // Anchors tuned to the hand-drawn shoulder origins (≈43,36 / 76,37 in 120-space).
  const shoulderY = 36 + dyIdle;
  const lShoulder = { x: CX - 16.5, y: shoulderY };
  const rShoulder = { x: CX + 16, y: shoulderY };

  // ── per-state scene composition ────────────────────────────────────────────
  // Each branch chooses a DISTINCT arm/hand pose (plus props) so states read
  // apart at a glance. Order of drawing: props behind → body → head → laptop →
  // arms (so hands sit on top of the laptop) → overlays/badges.
  if (state === 'coding' || state === 'running') {
    // Both forearms angled IN to the keyboard, hands on the deck, typing bob.
    drawNotebook(ctx);
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0B1220');
    drawScreenCode(ctx, scr, t);
    const bob = Math.floor(t / 5) % 2; // 0/1 px alternating per hand
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 11, 64 + bob);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 11, 64 + (1 - bob));

  } else if (state === 'reading') {
    // BOTH hands hold a sheet raised in front; head tilted down; laptop pushed
    // back (drawn small/dim behind the paper).
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, -2); // head dipped toward the page
    const scr = drawLaptop(ctx, accent, '#0B1018');
    ctx.fillStyle = rgba('#000000', 0.35); rr(ctx, scr.sx, scr.sy, scr.sw, scr.sh, 2); ctx.fill(); // dim, pushed-back
    // Both hands come together at the paper, held in front of the chest.
    const pX = CX, pY = 44;
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, pX - 11, pY + 2);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, pX + 11, pY + 2);
    // The raised sheet, faintly bobbing as if held/read.
    ctx.save(); ctx.translate(pX, pY + Math.sin(t * 0.05));
    ctx.fillStyle = '#F9FAFB'; rr(ctx, -16, -12, 32, 28, 2); ctx.fill();
    ctx.fillStyle = '#9CA3AF';
    for (let r = 0; r < 6; r++) { rr(ctx, -12, -8 + r * 4, 24 - (r % 3) * 5, 1.6, 1); ctx.fill(); }
    ctx.restore();

  } else if (state === 'searching') {
    // One hand forward on a MOUSE, the other flat on the desk; a couple of
    // loose papers; head scanning left↔right.
    drawCoffee(ctx, accent, false, t);
    // Loose papers fanned beside the keyboard.
    [[34, 40, -0.22], [30, 52, 0.16]].forEach(([px2, py2, rot]) => {
      ctx.save(); ctx.translate(px2, py2); ctx.rotate(rot);
      ctx.fillStyle = '#F3F4F6'; rr(ctx, -9, -11, 18, 22, 2); ctx.fill();
      ctx.fillStyle = '#CBD5E1';
      for (let r = 0; r < 4; r++) { rr(ctx, -6, -7 + r * 4, 12, 1.4, 1); ctx.fill(); }
      ctx.restore();
    });
    const scanT = Math.sin(t * 0.06) * 4; // scanning glance
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, scanT, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 4)); // slow idle content
    // moving highlight bar on screen = "scanning"
    const hp = Math.floor(t / 10) % 5;
    ctx.fillStyle = rgba(accent, 0.45); rr(ctx, scr.sx + 2, scr.sy + 2 + hp * 4, scr.sw - 4, 3, 1); ctx.fill();
    // Left hand flat on the desk; right hand forward on a mouse (slides a touch).
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 26, 56);
    const mX = CX + 30 + Math.sin(t * 0.08) * 2, mY = 62;
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, mX, mY);
    ctx.fillStyle = '#D1D5DB'; ctx.beginPath(); ctx.ellipse(mX, mY, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#9CA3AF'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(mX, mY - 7); ctx.lineTo(mX, mY); ctx.stroke();

  } else if (state === 'spawning') {
    // One arm raised holding a PHONE up by the head; other hand GESTURES out;
    // small chat bubbles rising near the phone.
    drawNotebook(ctx);
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 4, 0); // leaning toward the phone
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 3));
    // Left hand gesturing out to the side (open, away from desk).
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 34, 36);
    // Right arm raised, phone held up beside the head.
    const phX = CX + 22, phY = 24;
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, phX, phY);
    ctx.save(); ctx.translate(phX, phY); ctx.rotate(0.12);
    ctx.fillStyle = '#1F2937'; rr(ctx, -5, -10, 10, 20, 2); ctx.fill();
    ctx.fillStyle = rgba(accent, 0.9); rr(ctx, -3.5, -8, 7, 16, 1); ctx.fill();
    ctx.restore();
    // Chat bubbles popping in/out over time.
    const nb = Math.floor(t / 10) % 3 + 1;
    for (let i = 0; i < nb; i++) {
      ctx.fillStyle = rgba('#FFFFFF', 0.85);
      ctx.beginPath(); ctx.arc(phX + 8 + i * 7, phY - 12 - i * 5, 3, 0, Math.PI * 2); ctx.fill();
    }

  } else if (state === 'thinking') {
    // ONE hand raised to the temple/chin; the other resting on the desk; a "?"
    // bubble floats and bobs above.
    drawNotebook(ctx);
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, -3, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 6)); // slow, contemplative
    // Left hand rests low on the desk; right hand up at the temple.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 22, 58);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 12, 26); // hand at temple
    // "?" bubble, gently bobbing.
    const qy = 14 + Math.sin(t * 0.08) * 2, qx = CX + 26;
    ctx.fillStyle = '#F5F3FF';
    rr(ctx, qx - 9, qy - 9, 18, 18, 6); ctx.fill();
    ctx.beginPath(); ctx.moveTo(qx - 8, qy + 7); ctx.lineTo(qx - 12, qy + 12); ctx.lineTo(qx - 4, qy + 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = accent; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', qx, qy + 1);

  } else if (state === 'testing') {
    // Both hands on the laptop; screen alternates ✓ / ✗.
    drawNotebook(ctx);
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0B1220');
    drawScreenTest(ctx, scr, t);
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 11, 65);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 11, 65);

  } else if (state === 'error') {
    // BOTH arms thrown up/out (startled); papers scattered; red "!".
    const shake = Math.floor(t / 3) % 2 === 0 ? -1.5 : 1.5;
    // Scattered papers strewn around the desk.
    [[22, 66, -0.35], [38, 80, 0.25], [82, 72, 0.4], [70, 40, -0.2]].forEach(([px2, py2, rot], i) => {
      ctx.save(); ctx.translate(px2 + shake * (i % 2), py2); ctx.rotate(rot);
      ctx.fillStyle = '#E5E7EB'; rr(ctx, -8, -10, 16, 20, 2); ctx.fill(); ctx.restore();
    });
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, shake * 0.6, 0);
    drawLaptop(ctx, '#EF4444', '#1A0B0B');
    // Both arms flung up and outward (startled).
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 36 + shake, 20);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 36 - shake, 20);
    // Red "!" above.
    ctx.fillStyle = '#EF4444'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', CX + shake, 14);

  } else if (state === 'done') {
    // Relaxed — a clear THUMBS-UP raised; the other hand back; green ✓ above.
    drawCoffee(ctx, accent, true, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenTest(ctx, { ...scr }, 0); // static ✓ on screen
    // Left arm relaxed back; right arm gives a thumbs-up out to the side.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 30, 50);
    const tuX = CX + 30, tuY = 38;
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, tuX, tuY);
    // Thumbs-up: fist + thumb sticking up.
    ctx.fillStyle = SKIN;
    ctx.beginPath(); ctx.arc(tuX, tuY, 4.5, 0, Math.PI * 2); ctx.fill();
    rr(ctx, tuX - 1.6, tuY - 11, 3.2, 8, 1.5); ctx.fill(); // thumb up
    // Floating ✓ badge, gently bobbing.
    const by = 16 + Math.sin(t * 0.1) * 1.5;
    ctx.strokeStyle = '#10B981'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(CX - 7, by); ctx.lineTo(CX - 2, by + 5); ctx.lineTo(CX + 8, by - 7); ctx.stroke();

  } else {
    // idle (default): leaned back, BOTH hands behind the head (elbows out),
    // coffee with rising steam; no typing.
    drawCoffee(ctx, accent, true, t);
    drawBody(ctx, shirt, dyIdle);
    drawHead(ctx, hair, 0, dyIdle);
    drawLaptop(ctx, accent, '#0F172A');
    const hy = 22 + dyIdle; // head centre (matches drawHead)
    // Both arms sweep UP and OUT to the sides, hands meeting behind the head.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 22, hy - 2);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 22, hy - 2);
    // Hands tucked behind the head (drawn over the hair, near the top corners).
    ctx.fillStyle = SKIN;
    ctx.beginPath(); ctx.arc(CX - 13, hy - 6, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(CX + 13, hy - 6, 4, 0, Math.PI * 2); ctx.fill();
    // Z's drifting up (idle cue), looping via t.
    const zp = t % 90, za = zp < 45 ? zp / 45 : (90 - zp) / 45;
    ctx.globalAlpha = Math.max(0, za);
    ctx.fillStyle = '#9CA3AF'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('z', CX + 20 + zp * 0.1, 20 - zp * 0.18);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
