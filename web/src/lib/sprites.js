// Goose character sprites for the Office floor — sliced from the hand-made
// sheet in assets/ (served by the bridge at /art/). The sheet has an opaque
// paper-white background, so it's chroma-keyed to transparency once at load
// (feet shadows survive — they're darker than the key threshold).
// Slice rects were measured against the real sheet and screenshot-verified;
// AI-generated sheets don't sit on a clean grid, so don't "tidy" these numbers.

const SHEET_URL = '/art/people_sprite_1.png';

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

let keyed = null;        // chroma-keyed offscreen canvas
let loading = null;
export function loadGooseSheet() {
  if (keyed) return Promise.resolve(keyed);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const off = document.createElement('canvas');
        off.width = img.width; off.height = img.height;
        const ox = off.getContext('2d');
        ox.drawImage(img, 0, 0);
        const d = ox.getImageData(0, 0, off.width, off.height);
        const p = d.data;
        const br = p[0], bg = p[1], bb = p[2];   // top-left pixel = the paper background
        for (let i = 0; i < p.length; i += 4) {
          if (Math.abs(p[i] - br) + Math.abs(p[i + 1] - bg) + Math.abs(p[i + 2] - bb) < 48) p[i + 3] = 0;
        }
        ox.putImageData(d, 0, 0);
        keyed = off;
        resolve(off);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('goose sheet failed to load'));
    img.src = SHEET_URL;
  });
  return loading;
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
