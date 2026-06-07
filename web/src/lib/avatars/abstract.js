// Abstract avatar renderer (geometry/waveforms). draw(ctx, agent, t):
// ctx backing store 240x200 (DPR=2); we scale(2,2) and draw in 120x100 logical.
const W = 120, H = 100, DPR = 2;
const CX = W / 2, CY = H / 2;

const COLORS = {
  idle: '#6B7280', thinking: '#6366F1', coding: '#10B981', spawning: '#F59E0B',
  reading: '#3B82F6', error: '#EF4444', testing: '#8B5CF6', done: '#10B981',
  running: '#10B981', searching: '#3B82F6',
};

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function rand(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

function drawIdle(ctx, color, t) {
  const p = (Math.sin(t * 0.04) + 1) / 2;
  ctx.lineWidth = 3; ctx.strokeStyle = rgba(color, 0.25 + p * 0.35);
  ctx.beginPath(); ctx.arc(CX, CY, 22 + p * 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = rgba(color, (0.25 + p * 0.35) * 0.6);
  ctx.beginPath(); ctx.arc(CX, CY, 3, 0, Math.PI * 2); ctx.fill();
}
function drawThinking(ctx, color, t) {
  const DOTS = 5, orbit = 24, base = t * 0.06;
  ctx.fillStyle = rgba(color, 0.5); ctx.beginPath(); ctx.arc(CX, CY, 2.5, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < DOTS; i++) {
    const ang = base + (i / DOTS) * Math.PI * 2;
    ctx.fillStyle = rgba(color, 0.3 + 0.6 * (i / (DOTS - 1)));
    ctx.beginPath(); ctx.arc(CX + Math.cos(ang) * orbit, CY + Math.sin(ang) * orbit, 2 + 1.5 * (i / (DOTS - 1)), 0, Math.PI * 2); ctx.fill();
  }
}
function drawCoding(ctx, color, t) {
  const BARS = 7, barW = 8, gap = 4, maxH = 50;
  const x0 = CX - (BARS * barW + (BARS - 1) * gap) / 2, baseY = CY + maxH / 2;
  for (let i = 0; i < BARS; i++) {
    const h = 8 + ((Math.sin(t * (0.22 + (i % 3) * 0.05) + i * 1.7) + 1) / 2) * maxH;
    const x = x0 + i * (barW + gap);
    ctx.fillStyle = rgba(color, 0.85); ctx.fillRect(x, baseY - h, barW, h);
    ctx.fillStyle = rgba(color, 1); ctx.fillRect(x, baseY - h, barW, 3);
  }
}
function drawReading(ctx, color, t) {
  const left = CX - 38, right = CX + 38, top = CY - 28, lineGap = 9, lines = 6;
  ctx.fillStyle = rgba(color, 0.22);
  for (let r = 0; r < lines; r++) {
    const y = top + r * lineGap; let x = left, seed = r * 3 + 1;
    while (x < right) { const w = 3 + Math.floor(rand(seed) * 9); if (x + w > right) break; ctx.fillRect(x, y, w, 2); x += w + 3 + Math.floor(rand(seed + 100) * 4); seed++; }
  }
  const span = right - left, tri = Math.abs(((t * 0.03) % 2) - 1), sx = left + tri * span;
  ctx.fillStyle = rgba(color, 0.9); ctx.fillRect(sx - 1, top - 4, 2, lines * lineGap + 6);
  ctx.fillStyle = rgba(color, 0.25); ctx.fillRect(sx - 5, top - 4, 4, lines * lineGap + 6);
}
function drawSpawning(ctx, color, t) {
  const RINGS = 3, period = 60, maxR = 40;
  for (let i = 0; i < RINGS; i++) {
    const phase = ((t + i * (period / RINGS)) % period) / period;
    ctx.lineWidth = 3; ctx.strokeStyle = rgba(color, (1 - phase) * 0.8);
    ctx.beginPath(); ctx.arc(CX, CY, phase * maxR, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = rgba(color, 0.95); ctx.beginPath(); ctx.arc(CX, CY, 5, 0, Math.PI * 2); ctx.fill();
}
function drawError(ctx, color, t) {
  const SLICES = 5, sliceH = 10, baseW = 44, top = CY - (SLICES * sliceH) / 2;
  for (let i = 0; i < SLICES; i++) {
    const seed = i + Math.floor(t / 2), dx = (rand(seed) - 0.5) * 22, a = 0.6 + rand(seed + 9) * 0.4;
    ctx.fillStyle = rgba(color, a); ctx.fillRect(CX - baseW / 2 + dx, top + i * sliceH, baseW, sliceH - 2);
  }
  if (Math.floor(t / 4) % 3 === 0) { ctx.fillStyle = rgba('#FFFFFF', 0.7); ctx.fillRect(CX - baseW / 2, top + Math.floor(rand(t) * SLICES) * sliceH, baseW, 2); }
}
function drawTesting(ctx, color, t) {
  const phase = (t % 30) / 30, scaleX = Math.cos(phase * Math.PI * 2), side = 44, front = scaleX >= 0;
  ctx.save(); ctx.translate(CX, CY); ctx.scale(Math.max(Math.abs(scaleX), 0.05), 1);
  ctx.fillStyle = rgba(front ? '#10B981' : '#EF4444', 0.9); ctx.fillRect(-side / 2, -side / 2, side, side);
  ctx.strokeStyle = '#FFF'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath();
  if (front) { ctx.moveTo(-11, 2); ctx.lineTo(-3, 11); ctx.lineTo(12, -9); }
  else { ctx.moveTo(-10, -10); ctx.lineTo(10, 10); ctx.moveTo(10, -10); ctx.lineTo(-10, 10); }
  ctx.stroke(); ctx.restore();
  ctx.strokeStyle = rgba(color, 0.4); ctx.lineWidth = 2; ctx.strokeRect(CX - side / 2 - 5, CY - side / 2 - 5, side + 10, side + 10);
}
function drawDone(ctx, color, t) {
  const p = (Math.sin(t * 0.12) + 1) / 2, radius = 24 + p * 4;
  ctx.fillStyle = rgba(color, 0.18 + p * 0.15); ctx.beginPath(); ctx.arc(CX, CY, radius, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = rgba(color, 0.8 + p * 0.2); ctx.beginPath(); ctx.arc(CX, CY, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#FFF'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(CX - 12, CY + 2); ctx.lineTo(CX - 3, CY + 11); ctx.lineTo(CX + 13, CY - 10); ctx.stroke();
}

const RENDERERS = {
  idle: drawIdle, thinking: drawThinking, coding: drawCoding, spawning: drawSpawning,
  reading: drawReading, error: drawError, testing: drawTesting, done: drawDone,
  running: drawCoding, searching: drawReading,
};

export function draw(ctx, agent, t) {
  ctx.clearRect(0, 0, W * DPR, H * DPR);
  const state = (agent && agent.state) || 'idle';
  const color = COLORS[state] || COLORS.idle;
  const render = RENDERERS[state] || drawIdle;
  ctx.save();
  ctx.scale(DPR, DPR);
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  render(ctx, color, t);
  ctx.restore();
}
