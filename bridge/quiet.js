'use strict';
// bridge/quiet.js — quiet hours for the noisy channels.
//
// The user works late evenings and sleeps into the morning. A Telegram ping or
// a lamp flashing at 3am because a session finished a refactor is unwelcome;
// it is never urgent. But two things ARE worth waking up for: a runaway session
// burning through the budget, and a destructive command the guard blocked.
// So quiet hours mute by channel, and a short `critical` list of kinds always
// gets through.
//
// Pure: every call takes the config and the Date to judge. No timers, no I/O.

const CHANNELS = ['telegram', 'slack', 'desktop', 'ambient'];
const KINDS = ['awaiting', 'permission', 'error', 'runaway', 'done', 'limit', 'briefing', 'collision', 'danger'];

const DEFAULT_START = '23:00';
const DEFAULT_END = '08:00';
const DEFAULT_CRITICAL = ['runaway', 'danger'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// "7:30" and "07:30" are both fine (a Settings field gets typed by hand);
// "25:00", "7pm" and "" are not, and fall back to the default rather than to
// "never quiet", which would silently undo the feature.
function parseTime(v, dflt) {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(v == null ? '' : v));
  if (!m) return dflt;
  return m[1].padStart(2, '0') + ':' + m[2];
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// A missing list means the default. An explicit list is taken as given, after
// dropping unknown entries; an empty `days` therefore means "no quiet days",
// which is what unticking every box in Settings says.
function pickList(v, allowed, dflt) {
  if (!Array.isArray(v)) return dflt.slice();
  return [...new Set(v.filter((x) => allowed.includes(x)))];
}

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const days = Array.isArray(c.days)
    ? [...new Set(c.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : ALL_DAYS.slice();
  return {
    enabled: c.enabled === true,
    start: parseTime(c.start, DEFAULT_START),
    end: parseTime(c.end, DEFAULT_END),
    days,
    critical: pickList(c.critical, KINDS, DEFAULT_CRITICAL),
    channels: pickList(c.channels, CHANNELS, CHANNELS),
  };
}

function toDate(d) {
  if (d instanceof Date) return d;
  if (d === undefined || d === null) return new Date();
  return new Date(typeof d === 'string' && /^\d+$/.test(d) ? Number(d) : d);
}

// Local wall-clock time on purpose: "23:00" means 23:00 where the user sleeps.
//
// A window that wraps midnight belongs to the day it STARTS on: "Friday
// 23:00-08:00" is Friday night, so Saturday 02:00 is quiet only if Friday is
// ticked. That is how people think about "weeknights only" (Sun-Thu ticked:
// Friday night and Saturday night stay loud for the weekend).
//
// Returns false when disabled, so callers can ask one question.
function isQuiet(cfg, date) {
  const c = normalize(cfg);
  if (!c.enabled) return false;
  const d = toDate(date);
  if (!Number.isFinite(d.getTime())) return false;
  const s = minutesOf(c.start), e = minutesOf(c.end);
  if (s === e) return false;                                  // a zero-length window is not "all day"
  const t = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  if (s < e) return t >= s && t < e && c.days.includes(today);
  if (t >= s) return c.days.includes(today);                  // evening part: started today
  if (t < e) return c.days.includes((today + 6) % 7);         // morning part: started yesterday
  return false;
}

// Should this notification go out on this channel right now?
// A kind in `critical` always goes. A channel not in `channels` was never muted
// (e.g. the user mutes the phone and the lamp but keeps desktop toasts).
function shouldDeliver(channel, kind, cfg, date) {
  const c = normalize(cfg);
  if (!isQuiet(c, date)) return true;
  if (c.critical.includes(kind)) return true;
  if (!c.channels.includes(channel)) return true;
  return false;
}

module.exports = { isQuiet, shouldDeliver, normalize, KINDS, CHANNELS };
