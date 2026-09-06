'use strict';
// bridge/teams.js — tolerant readers for Claude Code Agent Teams files.
// Points the module at fresh temp dirs so nothing touches ~/.claude.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TEAMS = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-teams-'));
const TASKS = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-tasks-'));
process.env.GANDER_TEAMS_DIR = TEAMS;
process.env.GANDER_TASKS_DIR = TASKS;

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const teams = require('../bridge/teams.js');

const write = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
};
const wipe = (dir) => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); };
const find = (name) => teams.readTeams(0).find((t) => t.name === name);

describe('teams', () => {
  beforeEach(() => { wipe(TEAMS); wipe(TASKS); teams._reset(); });

  test('reads a full team: lead, members, inbox messages and tasks in three file shapes', () => {
    write(path.join(TEAMS, 'alpha', 'config.json'), { members: [
      { name: 'lead', agentId: 'a1', agentType: 'team-lead' },
      { name: 'coder', agentId: 'a2', agentType: 'general-purpose' },
      { name: 'tester', agentId: 'a3', agentType: 'general-purpose' },
    ] });
    write(path.join(TEAMS, 'alpha', 'inboxes', 'coder.json'), [
      { from: 'lead', text: 'start on parser', timestamp: 1700000000000 },
      { sender: 'tester', content: 'tests are red' },
    ]);
    write(path.join(TASKS, 'alpha', 'task-1.json'), { id: 't1', subject: 'Write parser', status: 'in_progress', owner: 'coder' });
    write(path.join(TASKS, 'alpha', 'batch.json'), [
      { id: 't2', subject: 'Write tests', status: 'pending' },
      { id: 't3', subject: 'Scaffold', status: 'completed' },
    ]);
    write(path.join(TASKS, 'alpha', 'wrapped.json'), { tasks: [{ id: 't4', title: 'Docs', status: 'pending' }] });

    const t = find('alpha');
    assert.equal(t.name, 'alpha');
    assert.equal(t.lead, 'lead');
    assert.equal(t.ended, undefined);
    assert.equal(t.unparsed, false);
    assert.deepEqual(t.members.map((m) => [m.name, m.lead]), [['lead', true], ['coder', false], ['tester', false]]);

    const msgs = t.inboxes.coder;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].from, 'lead');
    assert.equal(msgs[0].text, 'start on parser');
    assert.equal(msgs[0].ts, 1700000000000);
    assert.equal(msgs[1].from, 'tester');
    assert.equal(msgs[1].text, 'tests are red');
    assert.equal(msgs[1].ts, 0);
    assert.equal(t.messages, 2);

    assert.equal(t.tasks.length, 4);
    assert.equal(t.open, 3);
    assert.equal(t.done, 1);
    const t1 = t.tasks.find((x) => x.id === 't1');
    assert.equal(t1.status, 'in_progress');
    assert.equal(t1.owner, 'coder');
    assert.equal(t.tasks.find((x) => x.id === 't4').subject, 'Docs');
  });

  test('tolerates odd config shapes, invalid JSON, junk inboxes and empty dirs', () => {
    write(path.join(TEAMS, 'strings', 'config.json'), ['lead', 'worker']);
    write(path.join(TEAMS, 'broken', 'config.json'), '{ not json');
    write(path.join(TEAMS, 'broken', 'inboxes', 'x.json'), 'junk!!');
    fs.mkdirSync(path.join(TEAMS, 'empty', 'inboxes'), { recursive: true });
    fs.mkdirSync(path.join(TASKS, 'empty'), { recursive: true });

    const strings = find('strings');
    assert.deepEqual(strings.members.map((m) => m.name), ['lead', 'worker']);
    assert.equal(strings.lead, undefined);
    assert.equal(strings.unparsed, false);

    const broken = find('broken');
    assert.equal(broken.unparsed, false);
    assert.deepEqual(broken.members, []);
    assert.deepEqual(broken.inboxes.x, []);
    assert.equal(broken.messages, 0);

    const empty = find('empty');
    assert.deepEqual(empty.members, []);
    assert.deepEqual(empty.tasks, []);
    assert.equal(empty.open, 0);
    assert.equal(empty.done, 0);
    assert.equal(teams.readTeams(0).length, 3);
  });

  test('a tasks dir without a team dir shows up as an ended team', () => {
    write(path.join(TASKS, 'ghost', '1.json'), { subject: 'leftover', status: 'done' });
    write(path.join(TASKS, 'ghost', '2.json'), { subject: 'still open' });
    const g = find('ghost');
    assert.equal(g.ended, true);
    assert.deepEqual(g.members, []);
    assert.equal(g.tasks.length, 2);
    assert.equal(g.done, 1);
    assert.equal(g.open, 1);
    assert.equal(g.tasks.find((x) => x.id === '2').status, 'pending');
  });

  test('parseTask normalises status aliases and keeps unknown ones', () => {
    assert.equal(teams.parseTask({ status: 'done' }, 'a').status, 'completed');
    assert.equal(teams.parseTask({ status: 'claimed' }, 'a').status, 'in_progress');
    assert.equal(teams.parseTask({ state: 'ACTIVE' }, 'a').status, 'in_progress');
    assert.equal(teams.parseTask({ status: 'blocked' }, 'a').status, 'blocked');
    assert.equal(teams.parseTask({}, 'fallback').id, 'fallback');
    assert.equal(teams.parseTask(null, 'a'), null);
  });

  test('parseMembers marks the lead via agentType or lead:true', () => {
    const m = teams.parseMembers({ members: [
      { name: 'boss', agentType: 'team-lead' },
      { name: 'chief', lead: true },
      { name: 'grunt', agentType: 'worker' },
    ] });
    assert.deepEqual(m.map((x) => x.lead), [true, true, false]);
    assert.deepEqual(teams.parseMembers(null), []);
  });
});
