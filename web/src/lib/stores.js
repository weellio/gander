import { writable } from 'svelte/store';

// localStorage-backed writable store
function persisted(key, initial) {
  let init = initial;
  try { const v = localStorage.getItem(key); if (v != null) init = JSON.parse(v); } catch (_) {}
  const s = writable(init);
  s.subscribe((v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} });
  return s;
}

export const avatarMode = persisted('aoc-avatar-mode', 'pixel'); // pixel | abstract | image | gif
export const layout = persisted('aoc-layout', 'mosaic');         // mosaic | solo | squad | warroom | broadcast
export const images = persisted('aoc-images', []);               // pool of imported image data URLs
export const imageMap = persisted('aoc-image-map', {});           // per-agent image: { agentKey: dataURL }
