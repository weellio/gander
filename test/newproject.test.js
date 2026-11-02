'use strict';
// ＋ New project from the New-task dialog: bridge/projects.js createProject + parentFolders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./_tmp.js');

// projects.js persists its config next to itself; point it at scratch before requiring
const scratch = tmpdir('gander-newproj-');
process.env.AOC_PROJECTS_FILE = path.join(scratch, 'aoc-projects.json');
const projects = require('../bridge/projects.js');

const calls = [];
const fakeGit = (argv, cwd) => { calls.push({ argv, cwd }); return true; };

test('createProject(): makes the folder, a README, runs git init, and registers it', () => {
  const parent = tmpdir('gander-parent-');
  const r = projects.createProject({ parent, name: 'invoice-bot' }, fakeGit);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.equal(r.name, 'invoice-bot');
  assert.equal(r.cwd, path.join(parent, 'invoice-bot'));
  assert.ok(fs.existsSync(r.cwd));
  assert.equal(fs.readFileSync(path.join(r.cwd, 'README.md'), 'utf8'), '# invoice-bot\n');
  assert.deepEqual(calls.at(-1), { argv: ['git', 'init', '-q'], cwd: r.cwd });
  assert.equal(r.git, true);
  assert.ok(projects.getConfig().known.some((k) => path.resolve(k) === r.cwd), 'registered as a known project');
  assert.ok(projects.discover().some((p) => p.path === r.cwd), 'shows in the project list at once');
});

test('createProject(): refuses bad names, a missing parent, and an existing folder', () => {
  const parent = tmpdir('gander-parent-');
  assert.match(projects.createProject({ parent, name: '' }, fakeGit).error, /name required/);
  assert.match(projects.createProject({ parent, name: '../escape' }, fakeGit).error, /letters, digits/);
  assert.match(projects.createProject({ parent, name: 'a/b' }, fakeGit).error, /letters, digits/);
  assert.match(projects.createProject({ parent: path.join(parent, 'nope'), name: 'x' }, fakeGit).error, /does not exist/);
  assert.equal(projects.createProject({ parent, name: 'dup' }, fakeGit).ok, true);
  assert.match(projects.createProject({ parent, name: 'dup' }, fakeGit).error, /already exists/);
  assert.match(projects.createProject({ parent: '', name: 'x' }, fakeGit).error, /parent folder required/);
});

test('createProject(): git and README are optional', () => {
  const parent = tmpdir('gander-parent-');
  const before = calls.length;
  const r = projects.createProject({ parent, name: 'plain', git: false, readme: false }, fakeGit);
  assert.equal(r.ok, true);
  assert.equal(r.git, false);
  assert.equal(calls.length, before, 'git was not run');
  assert.equal(fs.existsSync(path.join(r.cwd, 'README.md')), false);
});

test('parentFolders(): the parents of known projects, configured roots first', () => {
  const root = tmpdir('gander-root-');
  fs.mkdirSync(path.join(root, 'p1', '.claude'), { recursive: true });
  projects.addRoot(root);
  const parent = tmpdir('gander-parent-');
  projects.createProject({ parent, name: 'q1' }, fakeGit);
  projects.createProject({ parent, name: 'q2' }, fakeGit);
  const list = projects.parentFolders();
  assert.equal(list[0], path.resolve(root), 'a configured root comes first: ' + JSON.stringify(list.slice(0, 3)));
  assert.ok(list.includes(path.resolve(parent)), 'a parent of created projects is offered');
});
