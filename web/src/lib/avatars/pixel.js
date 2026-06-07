// Pixel-art avatar renderer (ported from the original dashboard).
// drawAgent(ctx, agent, t): ctx backing store is 240x200 (DPR=2), shown 120x100.
const DPR = 2;
const SHIRTS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4'];
function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function px(ctx, x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(x * DPR, y * DPR, w * DPR, h * DPR); }

export function drawAgent(ctx, agent, t) {
  const W = 120, H = 100;
  ctx.clearRect(0, 0, W * DPR, H * DPR);

  const state = agent.state;
  const bounce = Math.sin(t * 0.08) * 1.5;
  const blink = (Math.floor(t / 40) % 8 === 0) ? 1 : 0;

  const bx = 48, by = 20 + (state === 'coding' || state === 'testing' ? 0 : Math.round(bounce));

  const shirt = agent.shirt || SHIRTS[hash(agent.id) % SHIRTS.length];
  px(ctx, bx, by + 16, 24, 18, shirt);

  if (state === 'coding' || state === 'testing') {
    const armBob = Math.floor(t / 6) % 2 === 0 ? 0 : 1;
    px(ctx, bx - 5, by + 16 + armBob, 6, 4, shirt);
    px(ctx, bx + 23, by + 16 + (1 - armBob), 6, 4, shirt);
    px(ctx, bx - 5, by + 20 + armBob, 5, 8, '#FDBCB4');
    px(ctx, bx + 24, by + 20 + (1 - armBob), 5, 8, '#FDBCB4');
  } else if (state === 'spawning') {
    px(ctx, bx - 5, by + 16, 5, 12, shirt);
    px(ctx, bx - 5, by + 28, 5, 6, '#FDBCB4');
    px(ctx, bx + 23, by + 12, 6, 14, shirt);
    px(ctx, bx + 29, by + 8, 5, 8, '#FDBCB4');
    const pf = Math.floor(t / 10) % 4;
    px(ctx, bx + 34, by + 2 + pf, 14, 20, '#1F2937');
    px(ctx, bx + 36, by + 4 + pf, 10, 16, '#0F172A');
    px(ctx, bx + 37, by + 6 + pf, 8, 12, '#38BDF8');
    const sd = Math.floor(t / 8) % 3;
    ['#38BDF8', '#10B981', '#F59E0B'].forEach((c, i) => { px(ctx, bx + 38 + i * 3, by + 7 + pf, 2, 2, i <= sd ? c : '#374151'); });
  } else if (state === 'reading') {
    px(ctx, bx - 8, by + 18, 8, 4, shirt);
    px(ctx, bx + 24, by + 18, 8, 4, shirt);
    px(ctx, bx - 8, by + 22, 6, 8, '#FDBCB4');
    px(ctx, bx + 26, by + 22, 6, 8, '#FDBCB4');
    px(ctx, bx - 2, by + 24, 28, 20, '#F3F4F6');
    px(ctx, bx - 1, by + 24, 1, 20, '#9CA3AF');
    for (let r = 0; r < 5; r++) { px(ctx, bx + 2, by + 27 + r * 3, 22, 1, '#D1D5DB'); }
    const rp = Math.floor(t / 15) % 3;
    px(ctx, bx + 2, by + 27 + rp * 3, 22, 1, '#374151');
  } else if (state === 'error') {
    const shake = Math.floor(t / 3) % 2 === 0 ? -1 : 1;
    px(ctx, bx - 5 + shake, by + 14, 5, 8, shirt);
    px(ctx, bx + 24 - shake, by + 14, 5, 8, shirt);
    px(ctx, bx - 8 + shake * 2, by + 8, 6, 8, '#FDBCB4');
    px(ctx, bx + 26 - shake * 2, by + 8, 6, 8, '#FDBCB4');
  } else {
    px(ctx, bx - 5, by + 16, 5, 12, shirt);
    px(ctx, bx + 24, by + 16, 5, 12, shirt);
    px(ctx, bx - 5, by + 28, 5, 6, '#FDBCB4');
    px(ctx, bx + 24, by + 28, 5, 6, '#FDBCB4');
  }

  // legs
  px(ctx, bx + 4, by + 34, 7, 14, '#1E3A5F');
  px(ctx, bx + 13, by + 34, 7, 14, '#1E3A5F');
  px(ctx, bx + 3, by + 46, 9, 6, '#1F2937');
  px(ctx, bx + 12, by + 46, 9, 6, '#1F2937');

  // head + hair
  px(ctx, bx + 4, by, 16, 16, '#FDBCB4');
  px(ctx, bx + 4, by, 16, 4, '#3C2A1E');
  px(ctx, bx + 4, by + 4, 3, 4, '#3C2A1E');
  px(ctx, bx + 17, by + 4, 3, 4, '#3C2A1E');
  // eyes
  if (!blink) { px(ctx, bx + 7, by + 8, 2, 2, '#1F2937'); px(ctx, bx + 15, by + 8, 2, 2, '#1F2937'); }
  else { px(ctx, bx + 7, by + 9, 3, 1, '#1F2937'); px(ctx, bx + 15, by + 9, 3, 1, '#1F2937'); }
  // mouth
  if (state === 'error') {
    px(ctx, bx + 8, by + 13, 8, 1, '#1F2937'); px(ctx, bx + 8, by + 12, 1, 1, '#1F2937'); px(ctx, bx + 15, by + 12, 1, 1, '#1F2937');
  } else if (state === 'coding' || state === 'testing') {
    px(ctx, bx + 8, by + 12, 8, 1, '#1F2937'); px(ctx, bx + 14, by + 11, 1, 1, '#1F2937'); px(ctx, bx + 15, by + 11, 1, 1, '#1F2937');
  } else {
    px(ctx, bx + 9, by + 12, 6, 1, '#1F2937'); px(ctx, bx + 8, by + 11, 1, 1, '#1F2937'); px(ctx, bx + 15, by + 11, 1, 1, '#1F2937');
  }

  // ── state overlays ──
  if (state === 'thinking') {
    const qp = 3 + Math.round(Math.sin(t * 0.1) * 2);
    px(ctx, bx + 18, by - 12 - qp, 16, 14, '#F5F3FF');
    px(ctx, bx + 18, by - 13 - qp, 14, 1, '#8B5CF6');
    px(ctx, bx + 17, by - 12 - qp, 1, 12, '#8B5CF6');
    px(ctx, bx + 33, by - 12 - qp, 1, 12, '#8B5CF6');
    px(ctx, bx + 18, by - 1 - qp, 14, 1, '#8B5CF6');
    const qx = bx + 23, qy = by - 10 - qp;
    px(ctx, qx + 1, qy, 4, 1, '#6366F1'); px(ctx, qx, qy + 1, 6, 1, '#6366F1');
    px(ctx, qx + 5, qy + 2, 1, 2, '#6366F1'); px(ctx, qx + 3, qy + 3, 3, 1, '#6366F1');
    px(ctx, qx + 2, qy + 4, 2, 1, '#6366F1'); px(ctx, qx + 2, qy + 6, 2, 1, '#6366F1');
    px(ctx, bx + 20, by - 2 - qp, 3, 2, '#F5F3FF'); px(ctx, bx + 19, by - 1 - qp, 2, 2, '#F5F3FF');
    const ef = Math.floor(t / 15) % 4;
    [0, 1, 2].forEach((i) => { px(ctx, bx + 4 + i * 4, by - 4, 2, 2, i < ef ? '#8B5CF6' : '#C4B5FD'); });
  }

  if (state === 'coding' || state === 'testing') {
    const kby = by + 52;
    px(ctx, bx - 10, kby, 44, 18, '#374151');
    px(ctx, bx - 9, kby + 1, 42, 16, '#4B5563');
    for (let r = 0; r < 2; r++) for (let c = 0; c < 7; c++) { px(ctx, bx - 8 + c * 6, kby + 2 + r * 7, 5, 5, '#6B7280'); }
    const kp = Math.floor(t / 4) % 14; const kr = Math.floor(kp / 7), kc = kp % 7;
    px(ctx, bx - 8 + kc * 6, kby + 2 + kr * 7, 5, 5, '#9CA3AF');
    const sby = by - 14;
    px(ctx, bx - 10, sby - 22, 44, 22, '#0F172A');
    px(ctx, bx - 9, sby - 21, 42, 20, '#0F172A');
    const codeColors = ['#38BDF8', '#10B981', '#F59E0B', '#A78BFA', '#F472B6', '#34D399'];
    const offset = Math.floor(t / 3) % 20;
    for (let row = 0; row < 4; row++) {
      const lineW = [18, 28, 14, 22, 16, 30][(row + offset) % 6];
      px(ctx, bx - 8, sby - 20 + row * 5, lineW, 2, codeColors[(row + Math.floor(t / 10)) % codeColors.length]);
    }
  }

  if (state === 'reading') {
    const ep = Math.floor(t / 20) % 3;
    px(ctx, bx + 7 + ep, by + 8, 2, 2, '#1F2937');
    px(ctx, bx + 15 + ep, by + 8, 2, 2, '#1F2937');
  }

  if (state === 'spawning') {
    const tf = Math.floor(t / 12) % 3; const tx = bx + 50, ty = by - 4;
    px(ctx, tx, ty, 20, 12, '#E5E7EB');
    px(ctx, tx, ty, 20, 1, '#9CA3AF'); px(ctx, tx, ty + 11, 20, 1, '#9CA3AF');
    px(ctx, tx, ty, 1, 12, '#9CA3AF'); px(ctx, tx + 19, ty, 1, 12, '#9CA3AF');
    [0, 1, 2].forEach((i) => px(ctx, tx + 4 + i * 6, ty + 4, 3, 3, i < tf ? '#374151' : '#9CA3AF'));
  }

  if (state === 'error') {
    const ef = Math.floor(t / 5) % 4; const ex = bx + 5, ey = by - 18;
    px(ctx, ex, ey, 3, 3, '#FEF2F2'); px(ctx, ex + 8, ey, 3, 3, '#FEF2F2');
    px(ctx, ex + 4, ey + 4, 3, 3, '#EF4444');
    if (ef > 0) { px(ctx, ex + 1, ey - 3, 2, 2, '#FCA5A5'); px(ctx, ex + 10, ey - 2, 2, 2, '#FCA5A5'); }
    if (ef > 1) { px(ctx, ex - 2, ey + 2, 2, 2, '#FCA5A5'); px(ctx, ex + 13, ey + 3, 2, 2, '#FCA5A5'); }
    px(ctx, bx + 6, by - 22, 3, 8, '#EF4444'); px(ctx, bx + 6, by - 12, 3, 3, '#EF4444');
    px(ctx, bx + 11, by - 22, 3, 8, '#EF4444'); px(ctx, bx + 11, by - 12, 3, 3, '#EF4444');
  }

  if (state === 'idle') {
    const zp = t % 80; const zAlpha = zp < 40 ? zp / 40 : (80 - zp) / 40;
    ctx.globalAlpha = Math.max(0, zAlpha);
    px(ctx, bx + 22 + Math.floor(zp / 10), by - 6 - Math.floor(zp / 8), 5, 4, '#9CA3AF');
    px(ctx, bx + 26 + Math.floor(zp / 12), by - 14 - Math.floor(zp / 10), 4, 3, '#D1D5DB');
    ctx.globalAlpha = 1;
  }

  if (state === 'testing') {
    const tp = Math.floor(t / 30) % 2;
    if (tp === 0) {
      px(ctx, bx + 3, by - 14, 2, 2, '#10B981'); px(ctx, bx + 5, by - 12, 2, 2, '#10B981');
      px(ctx, bx + 7, by - 10, 2, 2, '#10B981'); px(ctx, bx + 9, by - 12, 2, 2, '#10B981');
      px(ctx, bx + 11, by - 14, 2, 2, '#10B981'); px(ctx, bx + 13, by - 16, 2, 2, '#10B981');
    } else {
      px(ctx, bx + 3, by - 16, 2, 2, '#EF4444'); px(ctx, bx + 5, by - 14, 2, 2, '#EF4444');
      px(ctx, bx + 7, by - 12, 2, 2, '#EF4444'); px(ctx, bx + 9, by - 14, 2, 2, '#EF4444');
      px(ctx, bx + 11, by - 16, 2, 2, '#EF4444'); px(ctx, bx + 5, by - 16, 2, 2, '#EF4444');
    }
  }

  if (state === 'done') {
    // green check above head
    px(ctx, bx + 4, by - 12, 2, 2, '#10B981'); px(ctx, bx + 6, by - 10, 2, 2, '#10B981');
    px(ctx, bx + 8, by - 8, 2, 2, '#10B981'); px(ctx, bx + 10, by - 12, 2, 2, '#10B981');
    px(ctx, bx + 12, by - 15, 2, 2, '#10B981'); px(ctx, bx + 14, by - 18, 2, 2, '#10B981');
  }
}
