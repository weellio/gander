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
function drawBody(ctx, shirt, dy) {
  const neckY = 30 + dy;
  // Shoulders: a rounded trapezoid-ish blob below the head.
  ctx.fillStyle = shirt;
  rr(ctx, CX - 26, neckY + 6, 52, 30, 14); ctx.fill();
  // Subtle shoulder highlight (light comes from the screen, "above" the head).
  ctx.fillStyle = rgba('#FFFFFF', 0.08);
  rr(ctx, CX - 24, neckY + 6, 48, 8, 7); ctx.fill();
}

function drawHead(ctx, hair, turn, dy) {
  // turn (in px) nudges the head left/right for reading/searching glances.
  const hx = CX + turn, hy = 22 + dy;
  // Hair = the dominant top-down shape (an oval); a small skin "forehead" peeks
  // at the front edge so the head reads as a head from above.
  ctx.fillStyle = hair;
  ctx.beginPath(); ctx.ellipse(hx, hy, 13, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade(hair, 0.15);
  ctx.beginPath(); ctx.ellipse(hx, hy - 2, 11, 8, 0, 0, Math.PI * 2); ctx.fill();
  // Forehead sliver toward the laptop (front of the figure).
  ctx.fillStyle = SKIN;
  ctx.beginPath(); ctx.ellipse(hx, hy + 8, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
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
  const shoulderY = 40 + dyIdle;
  const lShoulder = { x: CX - 18, y: shoulderY };
  const rShoulder = { x: CX + 18, y: shoulderY };

  // Always-present props (coffee only steams when idle; phone-state varies).
  drawNotebook(ctx);

  // ── per-state scene composition ────────────────────────────────────────────
  if (state === 'coding' || state === 'running') {
    // Both hands on the laptop with a subtle typing bob; bright scrolling code.
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const bob = Math.floor(t / 5) % 2; // 0/1 px alternating per hand
    const scr = drawLaptop(ctx, accent, '#0B1220');
    drawScreenCode(ctx, scr, t);
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 12, 64 + bob);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 12, 64 + (1 - bob));

  } else if (state === 'reading' || state === 'searching') {
    // One hand holds a sheet of paper out to the side; head turned slightly.
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 5, 0); // glance toward the held paper
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 2)); // faint idle content
    // Left hand rests near laptop; right hand holds a paper to the right.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 12, 64);
    const px2 = CX + 36, py2 = 50;
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, px2, py2);
    // The held sheet (with scanning lines for searching).
    ctx.save(); ctx.translate(px2 + 8, py2); ctx.rotate(-0.12);
    ctx.fillStyle = '#F9FAFB'; rr(ctx, -2, -14, 22, 28, 2); ctx.fill();
    ctx.fillStyle = '#9CA3AF';
    for (let r = 0; r < 6; r++) { rr(ctx, 1, -10 + r * 4, 16 - (r % 2) * 4, 1.5, 1); ctx.fill(); }
    if (state === 'searching') { // moving highlight bar
      const hp = Math.floor(t / 12) % 6;
      ctx.fillStyle = rgba(accent, 0.5); rr(ctx, 0, -11 + hp * 4, 18, 3, 1); ctx.fill();
    }
    ctx.restore();

  } else if (state === 'spawning') {
    // One arm raised holding a phone up; small chat bubbles near it.
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 2));
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 12, 64);
    // Right arm raised up/right holding the phone.
    const phX = CX + 34, phY = 26;
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, phX, phY);
    ctx.fillStyle = '#1F2937'; rr(ctx, phX - 5, phY - 9, 10, 18, 2); ctx.fill();
    ctx.fillStyle = rgba(accent, 0.9); rr(ctx, phX - 3.5, phY - 7, 7, 14, 1); ctx.fill();
    // Chat bubbles popping in/out over time.
    const nb = Math.floor(t / 12) % 3 + 1;
    for (let i = 0; i < nb; i++) {
      ctx.fillStyle = rgba('#FFFFFF', 0.85);
      ctx.beginPath(); ctx.arc(phX + 8 + i * 7, phY - 14 - i * 5, 3, 0, Math.PI * 2); ctx.fill();
    }

  } else if (state === 'thinking') {
    // A hand up near the head; a "?" bubble floats above.
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, -3, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenCode(ctx, scr, Math.floor(t / 3));
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 12, 64);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 10, 30); // hand near head
    // "?" bubble, gently bobbing.
    const qy = 14 + Math.sin(t * 0.08) * 2, qx = CX + 24;
    ctx.fillStyle = '#F5F3FF';
    rr(ctx, qx - 9, qy - 9, 18, 18, 6); ctx.fill();
    ctx.beginPath(); ctx.moveTo(qx - 8, qy + 7); ctx.lineTo(qx - 12, qy + 12); ctx.lineTo(qx - 4, qy + 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = accent; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', qx, qy + 1);

  } else if (state === 'testing') {
    // Laptop screen shows an alternating ✓ / ✗; both hands resting on deck.
    drawCoffee(ctx, accent, false, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0B1220');
    drawScreenTest(ctx, scr, t);
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 12, 65);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 12, 65);

  } else if (state === 'error') {
    // Arms thrown up, papers scattered, red "!" — reddish tint applied in desk.
    const shake = Math.floor(t / 3) % 2 === 0 ? -1.5 : 1.5;
    // Scattered papers behind the figure.
    [[24, 70, -0.3], [40, 78, 0.2], [80, 72, 0.35]].forEach(([px2, py2, rot], i) => {
      ctx.save(); ctx.translate(px2 + shake * (i % 2), py2); ctx.rotate(rot);
      ctx.fillStyle = '#E5E7EB'; rr(ctx, -8, -10, 16, 20, 2); ctx.fill(); ctx.restore();
    });
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, shake * 0.6, 0);
    drawLaptop(ctx, '#EF4444', '#1A0B0B');
    // Both arms flung up and outward.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 34 + shake, 22);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 34 - shake, 22);
    // Red "!" above.
    ctx.fillStyle = '#EF4444'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', CX + shake, 16);

  } else if (state === 'done') {
    // Relaxed: hands off the keyboard, a small ✓ above.
    drawCoffee(ctx, accent, true, t);
    drawBody(ctx, shirt, 0);
    drawHead(ctx, hair, 0, 0);
    const scr = drawLaptop(ctx, accent, '#0F172A');
    drawScreenTest(ctx, { ...scr }, 0); // static ✓
    // Hands relaxed at the sides, off the deck.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 30, 52);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 30, 52);
    // Floating ✓ badge.
    const by = 16 + Math.sin(t * 0.1) * 1.5;
    ctx.strokeStyle = '#10B981'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(CX - 7, by); ctx.lineTo(CX - 2, by + 5); ctx.lineTo(CX + 8, by - 7); ctx.stroke();

  } else {
    // idle (default): leaned back (figure shifted down), hands off the keyboard,
    // coffee cup with rising steam.
    drawCoffee(ctx, accent, true, t);
    drawBody(ctx, shirt, dyIdle);
    drawHead(ctx, hair, 0, dyIdle);
    drawLaptop(ctx, accent, '#0F172A');
    // Relaxed hands resting wide, away from the laptop.
    drawArm(ctx, shirt, lShoulder.x, lShoulder.y, CX - 32, 58);
    drawArm(ctx, shirt, rShoulder.x, rShoulder.y, CX + 32, 58);
    // Z's drifting up (idle cue), looping via t.
    const zp = t % 90, za = zp < 45 ? zp / 45 : (90 - zp) / 45;
    ctx.globalAlpha = Math.max(0, za);
    ctx.fillStyle = '#9CA3AF'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('z', CX + 18 + zp * 0.1, 24 - zp * 0.18);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
