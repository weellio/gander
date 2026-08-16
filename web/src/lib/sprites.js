// Goose character sprites for the Office floor — sliced from the hand-made
// sheet in assets/ (served by the bridge at /art/). The sheet has an opaque
// paper-white background, so it's chroma-keyed to transparency once at load
// (feet shadows survive — they're darker than the key threshold).
// Slice rects were measured against the real sheet and screenshot-verified;
// AI-generated sheets don't sit on a clean grid, so don't "tidy" these numbers.

const SHEET_URL = '/art/people_sprite_1.png';
const OFFICE_URL = '/art/office_sprite_dark.png';

// Office decor (same sheet family, dark variant). Verified slices — see the
// note below about not "tidying" the numbers.
export const OFFICE = {
  cooler: [2565, 850, 120, 260],
  plant: [2718, 898, 165, 225],
  printer: [2350, 905, 195, 215],
  sofa: [2270, 1745, 390, 195],
  posters: [[2985, 270, 145, 200], [2785, 515, 145, 200], [2625, 515, 145, 200]],   // "turning it off and on" · GO AWAY · IT IS WONDERFUL
};

// [sx, sy, sw, sh] in sheet pixels (3200×2133)
export const GOOSE = {
  moss: {
    desk: [780, 1095, 190, 195], type: [2380, 1085, 185, 195],
    think: [2660, 1080, 175, 195], palm: [2925, 1080, 160, 195],
    idle: [2150, 290, 150, 185],
    walk: [[1655, 1085, 145, 190], [1800, 1085, 145, 190], [1950, 1085, 145, 190], [2100, 1085, 145, 190]],
  },
  roy: {
    desk: [780, 1290, 190, 195], type: [2380, 1295, 185, 195],
    think: [2660, 1290, 175, 200], palm: [2925, 1290, 160, 200],
    idle: [2150, 515, 150, 190],
    walk: [[1655, 1285, 145, 205], [1800, 1285, 145, 205], [1950, 1285, 145, 205], [2100, 1285, 145, 205]],
  },
  jen: {
    desk: [780, 1515, 190, 200], type: [2380, 1520, 185, 200],
    think: [2660, 1515, 175, 205], palm: [2925, 1515, 160, 205],
    idle: [2150, 705, 150, 190],
    walk: [[1655, 1525, 145, 195], [1800, 1525, 145, 195], [1950, 1525, 145, 195], [2100, 1525, 145, 195]],
  },
  shared: { celebrate: [1420, 1895, 165, 200], thumbs: [965, 1900, 145, 195], sleep: [2980, 1895, 200, 200] },
};
const CHARS = ['moss', 'roy', 'jen'];

// Droids from general_sprite_1 ("Star Wars meets IT Crowd") — one TYPE per
// process attribution, so what a robot IS reads at a glance:
const GENERAL_URL = '/art/general_sprite_1.png';
export const DROIDS = {
  plugin: [1480, 1310, 175, 190],    // Binary Beeper — chirpy plugin sidecar
  claude: [2225, 1285, 175, 215],    // Helpdesk Droid — belongs to a live session
  session: [1720, 1280, 190, 225],   // Printer Droid — queue/session work output
  project: [1720, 1280, 190, 225],
  other: [2685, 1295, 215, 205],     // Tea Droid — not Claude's, just having tea
  orphan: [2465, 1275, 180, 225],    // Security Droid — red eye, no owner
};

// One keyed-canvas cache per sheet URL — goose characters and office decor
// share the same key-flood-erode pipeline.
const sheets = new Map();   // url -> { canvas } | { promise }
// opts per sheet: the goose sheet has a PAPER-WHITE bg (generous flood + bright
// erode to kill the light matte); the office sheet is NEAR-BLACK — a generous
// flood eats dark furniture (sofa cushions, plant pots, copier bodies), so it
// gets a tight threshold and no erosion (its fringe is dark and harmless).
function loadKeyedSheet(url, opts = {}) {
  const { flood = 110, erode = true } = opts;
  const hit = sheets.get(url);
  if (hit && hit.canvas) return Promise.resolve(hit.canvas);
  if (hit && hit.promise) return hit.promise;
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const off = document.createElement('canvas');
        off.width = img.width; off.height = img.height;
        const ox = off.getContext('2d');
        ox.drawImage(img, 0, 0);
        const d = ox.getImageData(0, 0, off.width, off.height);
        const p = d.data;
        const W = off.width, H = off.height;
        const br = p[0], bg = p[1], bb = p[2];   // top-left pixel = the paper background
        const dist = (i) => Math.abs(p[i] - br) + Math.abs(p[i + 1] - bg) + Math.abs(p[i + 2] - bb);
        // Flood-fill the key from the OUTSIDE (higher threshold is safe this way:
        // cream shirts are close to the paper colour, but they're sealed behind
        // dark outlines the flood can't cross), then defringe the anti-aliased
        // edge pixels so nothing halos on a dark floor.
        const seen = new Uint8Array(W * H);
        const stack = [];
        for (let x = 0; x < W; x++) { stack.push(x, x + (H - 1) * W); }
        for (let y = 0; y < H; y++) { stack.push(y * W, W - 1 + y * W); }
        while (stack.length) {
          const n = stack.pop();
          if (seen[n]) continue;
          seen[n] = 1;
          if (dist(n * 4) >= flood) continue;      // hit the artwork — stop
          p[n * 4 + 3] = 0;
          const x = n % W, y = (n / W) | 0;
          if (x > 0) stack.push(n - 1);
          if (x < W - 1) stack.push(n + 1);
          if (y > 0) stack.push(n - W);
          if (y < H - 1) stack.push(n + W);
        }
        // Matte-line removal: the 2–3px anti-aliased blend between the dark
        // character outline and the paper reads as an off-white "bad cutout"
        // ring on dark floors. Erode it: repeatedly delete edge-touching pixels
        // that are BRIGHT — the fringe is off-white, the outlines are near
        // black, so the erosion stops exactly at the true silhouette. (Bright
        // interiors like faces never border transparency, so they're safe.)
        const erodePass = (brightMin) => {
          const kill = [];
          for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
              const n = y * W + x, i = n * 4;
              if (p[i + 3] === 0) continue;
              if (p[i - 1] !== 0 && p[i + 7] !== 0 && p[(n - W) * 4 + 3] !== 0 && p[(n + W) * 4 + 3] !== 0) continue;
              if (p[i] + p[i + 1] + p[i + 2] > 3 * brightMin) kill.push(i);
            }
          }
          for (const i of kill) p[i + 3] = 0;
          return kill.length;
        };
        if (erode) {
          for (let pass = 0; pass < 4; pass++) if (!erodePass(150)) break;   // matte remnants, incl. darker beige blends
          erodePass(-1);                                                     // final colour-blind 1px shave — kills whatever's left
        }
        // final 1px soft feather so the new hard edge doesn't alias
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const n = y * W + x, i = n * 4;
            if (p[i + 3] === 0) continue;
            if (p[i - 1] === 0 || p[i + 7] === 0 || p[(n - W) * 4 + 3] === 0 || p[(n + W) * 4 + 3] === 0) {
              if (p[i + 3] === 255) p[i + 3] = 210;
            }
          }
        }
        ox.putImageData(d, 0, 0);
        sheets.set(url, { canvas: off });
        resolve(off);
      } catch (e) { reject(e); }
    };
    img.onerror = () => { sheets.delete(url); reject(new Error('sheet failed to load: ' + url)); };
    img.src = url;
  });
  sheets.set(url, { promise });
  return promise;
}

let keyed = null;         // goose sheet (kept as a direct ref for the hot draw path)
let officeKeyed = null;   // office decor sheet
let generalKeyed = null;  // geese & robots sheet (droids)
export function loadGooseSheet() { return loadKeyedSheet(SHEET_URL, { flood: 110, erode: true }).then((c) => (keyed = c)); }
export function loadOfficeSheet() { return loadKeyedSheet(OFFICE_URL, { flood: 34, erode: false }).then((c) => (officeKeyed = c)); }
export function loadGeneralSheet() { return loadKeyedSheet(GENERAL_URL, { flood: 110, erode: true }).then((c) => (generalKeyed = c)); }

// Draw the droid for a process attribution, bottom-anchored. False if not ready.
export function drawDroid(ctx, attribution, cx, footY, targetH) {
  const r = generalKeyed && DROIDS[attribution];
  if (!r) return false;
  const w = targetH * (r[2] / r[3]);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(generalKeyed, r[0], r[1], r[2], r[3], cx - w / 2, footY - targetH, w, targetH);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

// Draw a decor item bottom-anchored at (cx, footY), targetH tall.
export function drawItem(ctx, rect, cx, footY, targetH) {
  if (!officeKeyed || !rect) return false;
  const w = targetH * (rect[2] / rect[3]);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(officeKeyed, rect[0], rect[1], rect[2], rect[3], cx - w / 2, footY - targetH, w, targetH);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

// stable character per agent id
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function gooseFor(id) { return CHARS[hash(String(id)) % 3]; }

// pose per agent state (walking overrides with the 4-frame cycle)
export function poseFor(state, walking, t) {
  if (walking) return { kind: 'walk', frame: Math.floor(t * 6) % 4 };
  if (state === 'coding' || state === 'testing') return { kind: 'type' };
  if (state === 'reading') return { kind: 'desk' };
  if (state === 'error') return { kind: 'palm' };
  if (state === 'done') return { kind: 'celebrate', shared: true };
  if (state === 'idle') return { kind: 'idle' };
  return { kind: 'think' };   // thinking / spawning / searching / awaiting
}

// Draw a goose bottom-anchored at (cx, footY), targetH tall, aspect preserved.
export function drawGoose(ctx, agentId, state, walking, t, cx, footY, targetH) {
  if (!keyed) return false;
  const ch = GOOSE[gooseFor(agentId)];
  const pose = poseFor(state, walking, t);
  const r = pose.shared ? GOOSE.shared[pose.kind] : (pose.kind === 'walk' ? ch.walk[pose.frame] : ch[pose.kind]);
  if (!r) return false;
  const w = targetH * (r[2] / r[3]);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;    // keep the pixel-art crunch
  ctx.drawImage(keyed, r[0], r[1], r[2], r[3], cx - w / 2, footY - targetH, w, targetH);
  ctx.imageSmoothingEnabled = prev;
  return true;
}
