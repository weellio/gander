// ── Agent Ops Center · NOC project control module ───────────────────────────
// Self-contained, zero-dependency. Adds multi-PROJECT filtering, a live status
// bar, and per-project mute to the existing dashboard WITHOUT touching
// index.html or any other file. It only reads /api/state and manipulates the
// DOM defensively (no-ops if anything it expects is missing).
//
// Exposes: window.AOC_PROJECTS = { current() }  -> selected project or null (All)
(function () {
  'use strict';

  var STORAGE_KEY = 'aoc-project';
  var POLL_MS = 600;
  var API_STATE = '/api/state';
  var API_MUTE = '/api/mute';

  // State colors (per the NOC spec). 'done' shares coding's green.
  var STATE_COLORS = {
    idle:     '#6B7280',
    thinking: '#6366F1',
    coding:   '#10B981',
    spawning: '#F59E0B',
    reading:  '#3B82F6',
    error:    '#EF4444',
    testing:  '#8B5CF6',
    done:     '#10B981'
  };
  // Order used when rendering per-state counts in the status bar.
  var STATE_ORDER = ['coding','thinking','reading','spawning','running',
                     'testing','error','done','idle'];
  // States considered "active" (not idle) for the dropdown active/idle counts.
  function isActiveState(s) { return s && s !== 'idle' && s !== 'done'; }

  function init() {
    var topBar = document.querySelector('.top-bar');
    if (!topBar) return; // nothing to attach to; bail silently

    injectStyle();

    // ── Build the filter UI (select + mute button) ──────────────────────────
    var select = document.createElement('select');
    select.className = 'project-select';
    select.title = 'Filter by project';

    var muteBtn = document.createElement('button');
    muteBtn.className = 'aoc-mute-btn';
    muteBtn.type = 'button';
    muteBtn.textContent = '🔇'; // 🔇
    muteBtn.title = 'Mute selected project';
    muteBtn.disabled = true;

    // Insert before .spawn-btn if present, else append to the top bar.
    var spawnBtn = topBar.querySelector('.spawn-btn');
    if (spawnBtn) {
      topBar.insertBefore(select, spawnBtn);
      topBar.insertBefore(muteBtn, spawnBtn);
    } else {
      topBar.appendChild(select);
      topBar.appendChild(muteBtn);
    }

    // ── Status bar, inserted right under the top bar ─────────────────────────
    var statusBar = document.createElement('div');
    statusBar.className = 'aoc-statusbar';
    var dashboard = topBar.parentNode;
    if (dashboard && topBar.nextSibling) {
      dashboard.insertBefore(statusBar, topBar.nextSibling);
    } else if (dashboard) {
      dashboard.appendChild(statusBar);
    }

    // ── Selection state (persisted) ─────────────────────────────────────────
    var selected = null; // null === "All projects"
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) selected = saved;
    } catch (e) { /* localStorage may be unavailable */ }

    var lastState = null;        // most recent /api/state payload
    var userPickedThisFrame = false;

    function persist() {
      try {
        if (selected) localStorage.setItem(STORAGE_KEY, selected);
        else localStorage.removeItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
    }

    select.addEventListener('change', function () {
      selected = select.value || null;
      if (select.value === '__all__') selected = null;
      persist();
      if (lastState) applyAll(lastState);
    });

    muteBtn.addEventListener('click', function () {
      if (!selected || !lastState) return;
      var muted = Array.isArray(lastState.muted) &&
                  lastState.muted.indexOf(selected) !== -1;
      postMute(selected, !muted);
    });

    // Public API.
    window.AOC_PROJECTS = { current: function () { return selected; } };

    // ── Helpers ─────────────────────────────────────────────────────────────
    function isMuted(state, name) {
      return state && Array.isArray(state.muted) &&
             state.muted.indexOf(name) !== -1;
    }

    function projectListFrom(state) {
      // Prefer the bridge-provided projects[]; otherwise derive from agents[].
      if (Array.isArray(state.projects) && state.projects.length) {
        return state.projects.map(function (p) {
          var active = 0, idle = 0;
          var st = p.states || {};
          for (var k in st) {
            if (!Object.prototype.hasOwnProperty.call(st, k)) continue;
            if (k === 'idle') idle += st[k] || 0;
            else active += st[k] || 0;
          }
          return {
            name: p.project,
            total: p.total != null ? p.total : (active + idle),
            sessions: p.sessions || 0,
            active: active,
            idle: idle,
            muted: !!p.muted || isMuted(state, p.project),
            states: st
          };
        });
      }
      // Fallback: aggregate from agents.
      var agents = Array.isArray(state.agents) ? state.agents : [];
      var map = {};
      agents.forEach(function (a) {
        var name = a.project || 'unknown';
        if (!map[name]) map[name] = { name: name, total: 0, sessions: {},
                                      active: 0, idle: 0, states: {} };
        var p = map[name];
        p.total++;
        if (a.sessionId) p.sessions[a.sessionId] = true;
        var s = a.state || 'idle';
        p.states[s] = (p.states[s] || 0) + 1;
        if (isActiveState(s)) p.active++;
        else if (s === 'idle') p.idle++;
      });
      return Object.keys(map).map(function (name) {
        var p = map[name];
        return {
          name: name, total: p.total,
          sessions: Object.keys(p.sessions).length,
          active: p.active, idle: p.idle,
          muted: isMuted(state, name), states: p.states
        };
      }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    }

    function rebuildOptions(state, projects) {
      // Don't stomp the dropdown while the user is interacting with it.
      if (document.activeElement === select) return;

      var totalAgents = Array.isArray(state.agents) ? state.agents.length : 0;
      var html = '<option value="__all__">All projects (' + totalAgents + ')</option>';
      var stillExists = (selected === null);

      projects.forEach(function (p) {
        if (p.name === selected) stillExists = true;
        var label = p.name + ' — ' + p.active + '● ' + p.idle + '◌';
        if (p.muted) label += ' (muted)';
        html += '<option value="' + escapeAttr(p.name) + '">' +
                escapeHtml(label) + '</option>';
      });

      // If the persisted project is gone, fall back to All.
      if (!stillExists) { selected = null; persist(); }

      select.innerHTML = html;
      select.value = selected == null ? '__all__' : selected;
    }

    function updateMuteBtn(state) {
      if (!selected) {
        muteBtn.disabled = true;
        muteBtn.textContent = '🔇';
        muteBtn.title = 'Select a project to mute';
        muteBtn.classList.remove('is-muted');
        return;
      }
      muteBtn.disabled = false;
      var muted = isMuted(state, selected);
      muteBtn.classList.toggle('is-muted', muted);
      muteBtn.textContent = muted ? '🔈' : '🔇'; // 🔈 unmute / 🔇 mute
      muteBtn.title = (muted ? 'Unmute ' : 'Mute ') + selected;
    }

    function applyFilter(state) {
      var agents = Array.isArray(state.agents) ? state.agents : [];
      // Build card-id -> project map for THIS frame.
      var cards = document.querySelectorAll('.agent-card');
      if (!cards.length) return;
      var proj = {};
      agents.forEach(function (a) {
        if (a && a.id != null) proj['card-' + a.id] = a.project || null;
      });
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        if (selected === null) {
          card.style.display = '';
          continue;
        }
        var p = proj[card.id];
        // If we can't resolve the card's project, leave it visible (defensive).
        card.style.display = (p === undefined || p === selected) ? '' : 'none';
      }
    }

    function renderStatusBar(state, projects) {
      var agents = Array.isArray(state.agents) ? state.agents : [];
      var scopeAgents, sessions, scopeLabel;

      if (selected === null) {
        scopeAgents = agents;
        var s = {};
        agents.forEach(function (a) { if (a.sessionId) s[a.sessionId] = true; });
        sessions = Object.keys(s).length || countSessions(projects);
        scopeLabel = 'All projects';
      } else {
        scopeAgents = agents.filter(function (a) { return a.project === selected; });
        var ss = {};
        scopeAgents.forEach(function (a) { if (a.sessionId) ss[a.sessionId] = true; });
        var match = null;
        for (var j = 0; j < projects.length; j++) {
          if (projects[j].name === selected) { match = projects[j]; break; }
        }
        sessions = Object.keys(ss).length || (match ? match.sessions : 0);
        scopeLabel = selected;
      }

      // Per-state counts within scope.
      var counts = {};
      scopeAgents.forEach(function (a) {
        var st = a.state || 'idle';
        counts[st] = (counts[st] || 0) + 1;
      });

      var parts = [];
      parts.push('<span class="aoc-scope">' + escapeHtml(scopeLabel) + '</span>');
      parts.push('<span class="aoc-sep">•</span>');
      parts.push('<span class="aoc-metric">' + sessions + ' session' +
                 (sessions === 1 ? '' : 's') + '</span>');
      parts.push('<span class="aoc-metric">' + scopeAgents.length + ' agent' +
                 (scopeAgents.length === 1 ? '' : 's') + '</span>');

      var ordered = STATE_ORDER.slice();
      // include any states not in our known order, appended at the end
      Object.keys(counts).forEach(function (k) {
        if (ordered.indexOf(k) === -1) ordered.push(k);
      });
      ordered.forEach(function (st) {
        var n = counts[st];
        if (!n) return;
        var color = STATE_COLORS[st] || '#9b9890';
        parts.push('<span class="aoc-state">' +
          '<span class="aoc-dot" style="background:' + color + '"></span>' +
          n + ' ' + escapeHtml(st) + '</span>');
      });

      statusBar.innerHTML = parts.join('');
    }

    function countSessions(projects) {
      var n = 0;
      projects.forEach(function (p) { n += p.sessions || 0; });
      return n;
    }

    function applyAll(state) {
      var projects = projectListFrom(state);
      rebuildOptions(state, projects);
      updateMuteBtn(state);
      applyFilter(state);
      renderStatusBar(state, projects);
    }

    // ── Mute POST ────────────────────────────────────────────────────────────
    function postMute(project, muted) {
      try {
        fetch(API_MUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: project, muted: muted })
        }).then(function () {
          // Optimistically reflect; next poll will confirm.
          if (lastState && Array.isArray(lastState.muted)) {
            var idx = lastState.muted.indexOf(project);
            if (muted && idx === -1) lastState.muted.push(project);
            else if (!muted && idx !== -1) lastState.muted.splice(idx, 1);
            applyAll(lastState);
          }
        })['catch'](function () { /* ignore network errors */ });
      } catch (e) { /* ignore */ }
    }

    // ── Poll loop ────────────────────────────────────────────────────────────
    function poll() {
      fetch(API_STATE, { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || typeof data !== 'object') return;
          lastState = data;
          applyAll(data);
        })['catch'](function () { /* skip this frame */ });
    }

    poll();
    setInterval(poll, POLL_MS);
  }

  // ── Tiny HTML/attr escaping (avoid breaking option markup) ─────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // ── Injected styles (match .spawn-btn / .layout-select look) ───────────────
  function injectStyle() {
    if (document.getElementById('aoc-projects-style')) return;
    var css =
      '.project-select,.aoc-mute-btn{' +
        'font-size:12px;padding:5px 10px;border-radius:var(--border-radius-md,8px);' +
        'border:0.5px solid var(--color-border-secondary,#d4d1c8);' +
        'background:var(--color-background-primary,#fff);' +
        'color:var(--color-text-primary,#1f1d1a);cursor:pointer;' +
        'transition:background .15s;margin-left:8px;}' +
      '.project-select:hover,.aoc-mute-btn:hover{' +
        'background:var(--color-background-secondary,#f5f4ef);}' +
      '.aoc-mute-btn{padding:5px 9px;line-height:1;}' +
      '.aoc-mute-btn:disabled{opacity:.45;cursor:default;}' +
      '.aoc-mute-btn.is-muted{border-color:#EF4444;}' +
      '.aoc-statusbar{' +
        'display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;' +
        'padding:8px 14px;font-size:12px;' +
        'color:var(--color-text-secondary,#595650);' +
        'background:var(--color-background-secondary,#f5f4ef);' +
        'border:0.5px solid var(--color-border-tertiary,#e7e5df);' +
        'border-radius:var(--border-radius-md,8px);}' +
      '.aoc-statusbar:empty{display:none;}' +
      '.aoc-scope{font-weight:500;color:var(--color-text-primary,#1f1d1a);}' +
      '.aoc-sep{color:var(--color-text-tertiary,#9b9890);}' +
      '.aoc-metric{color:var(--color-text-secondary,#595650);}' +
      '.aoc-state{display:inline-flex;align-items:center;gap:4px;}' +
      '.aoc-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0;' +
        'display:inline-block;}';
    var style = document.createElement('style');
    style.id = 'aoc-projects-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
