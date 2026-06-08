import { writable } from 'svelte/store';

// Theme presets: each sets the dashboard's CSS design tokens.
export const PRESETS = {
  warm:     { label: 'Warm Light', vars: { '--color-background-primary': '#ffffff', '--color-background-secondary': '#f5f4ef', '--color-border-tertiary': '#e7e5df', '--color-border-secondary': '#d4d1c8', '--color-text-primary': '#1f1d1a', '--color-text-secondary': '#595650', '--color-text-tertiary': '#9b9890' } },
  paper:    { label: 'Paper',      vars: { '--color-background-primary': '#fbfaf6', '--color-background-secondary': '#efece2', '--color-border-tertiary': '#ddd8c9', '--color-border-secondary': '#c8c2ae', '--color-text-primary': '#2b2720', '--color-text-secondary': '#5f5a4e', '--color-text-tertiary': '#9a9483' } },
  midnight: { label: 'Midnight',   vars: { '--color-background-primary': '#1b2030', '--color-background-secondary': '#141826', '--color-border-tertiary': '#2a3550', '--color-border-secondary': '#3d4d72', '--color-text-primary': '#e9eefb', '--color-text-secondary': '#a7b2cc', '--color-text-tertiary': '#697493' } },
  slate:    { label: 'Slate',      vars: { '--color-background-primary': '#23262b', '--color-background-secondary': '#1a1d22', '--color-border-tertiary': '#343941', '--color-border-secondary': '#4a515c', '--color-text-primary': '#eceef2', '--color-text-secondary': '#aeb4bf', '--color-text-tertiary': '#777e8a' } },
  forest:   { label: 'Forest',     vars: { '--color-background-primary': '#18241e', '--color-background-secondary': '#111a15', '--color-border-tertiary': '#27392f', '--color-border-secondary': '#3a5446', '--color-text-primary': '#e6f1ea', '--color-text-secondary': '#a3c2b1', '--color-text-tertiary': '#6c8a79' } },
};

// Background presets (CSS background-image + size). Sit behind the cards.
export const BACKGROUNDS = {
  none:      { label: 'None', css: '', size: 'auto' },
  aurora:    { label: 'Aurora', css: 'radial-gradient(at 18% 12%, rgba(99,102,241,0.28), transparent 45%), radial-gradient(at 82% 8%, rgba(16,185,129,0.20), transparent 45%), radial-gradient(at 50% 92%, rgba(245,158,11,0.18), transparent 50%)', size: 'cover' },
  dusk:      { label: 'Dusk', css: 'linear-gradient(160deg, rgba(139,92,246,0.20), transparent 55%), radial-gradient(at 90% 90%, rgba(59,130,246,0.22), transparent 45%)', size: 'cover' },
  blueprint: { label: 'Blueprint', css: 'linear-gradient(rgba(120,130,150,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(120,130,150,0.10) 1px, transparent 1px)', size: '26px 26px' },
};

function persisted(key, initial) {
  let init = initial;
  try { const v = localStorage.getItem(key); if (v != null) init = { ...initial, ...JSON.parse(v) }; } catch (_) {}
  const s = writable(init);
  s.subscribe((v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} });
  return s;
}

export const theme = persisted('aoc-theme', { preset: 'warm', accent: '#6366F1', bg: 'none', bgImage: '' });

export function applyTheme(t) {
  if (typeof document === 'undefined') return;
  const p = PRESETS[t.preset] || PRESETS.warm;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(p.vars)) root.style.setProperty(k, v);
  root.style.setProperty('--accent', t.accent || '#6366F1');
  let css = '', size = 'cover';
  if (t.bgImage) { css = `url("${t.bgImage}")`; size = 'cover'; }
  else if (t.bg && BACKGROUNDS[t.bg]) { css = BACKGROUNDS[t.bg].css; size = BACKGROUNDS[t.bg].size; }
  document.body.style.backgroundImage = css;
  document.body.style.backgroundSize = size;
  document.body.style.backgroundAttachment = 'fixed';
  document.body.style.backgroundPosition = 'center';
}
