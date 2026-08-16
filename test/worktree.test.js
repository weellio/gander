'use strict';
// test/worktree.test.js — bridge/git.js worktree helpers against a REAL temp
// git repo (git is a hard dependency of the feature; these are integration
// tests by design).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const git = require('../bridge/git.js');

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true }).toString();

describe('worktree lifecycle', () => {
  let repo;
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-wt-'));
    execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true });
    g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-m', 'init');
  });
  after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {} try { fs.rmSync(repo + '__wt1', { recursive: true, force: true }); } catch (_) {} });

  test('start creates a sibling worktree on its own branch', () => {
    const r = git.worktreeStart(repo, 1);
    assert.ok(r.ok, r.error);
    assert.equal(r.branch, 'gander/task-1');
    assert.ok(fs.existsSync(path.join(r.wtPath, 'a.txt')), 'worktree has the files');
    assert.ok(!r.wtPath.startsWith(repo + path.sep), 'sibling, not inside the repo');
  });

  test('finish commits leftovers, merges into a clean main tree, cleans up', () => {
    const wtPath = repo + '__wt1';
    fs.writeFileSync(path.join(wtPath, 'b.txt'), 'work from the task\n');   // uncommitted leftovers
    const msg = git.worktreeFinish(repo, wtPath, 'gander/task-1', 'test task #1');
    assert.equal(msg, 'merged');
    assert.ok(fs.existsSync(path.join(repo, 'b.txt')), 'work landed in the main tree');
    assert.ok(!fs.existsSync(wtPath), 'worktree removed');
    assert.ok(!g(repo, 'branch', '--list', 'gander/task-1').trim(), 'branch deleted after merge');
  });

  test('finish with a DIRTY main tree keeps the branch and does not merge', () => {
    const r = git.worktreeStart(repo, 2);
    assert.ok(r.ok, r.error);
    fs.writeFileSync(path.join(r.wtPath, 'c.txt'), 'task work\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'human edit in main tree\n');   // dirty main
    const msg = git.worktreeFinish(repo, r.wtPath, r.branch, 'test task #2');
    assert.match(msg, /branch gander\/task-2 kept — main tree has uncommitted/);
    assert.ok(!fs.existsSync(path.join(repo, 'c.txt')), 'nothing force-merged');
    assert.ok(g(repo, 'branch', '--list', 'gander/task-2').trim(), 'branch preserved');
    g(repo, 'checkout', '--', 'a.txt');                                        // clean up for next test
    g(repo, 'branch', '-D', 'gander/task-2');
  });

  test('finish reports a conflict, aborts the merge, keeps the branch', () => {
    const r = git.worktreeStart(repo, 3);
    fs.writeFileSync(path.join(r.wtPath, 'a.txt'), 'task version\n');
    g(r.wtPath, 'add', '-A'); g(r.wtPath, 'commit', '-m', 'task edit');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main version\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-m', 'main edit');                // diverging commit -> conflict
    const msg = git.worktreeFinish(repo, r.wtPath, r.branch, 'test task #3');
    assert.match(msg, /CONFLICT — branch gander\/task-3 kept/);
    assert.equal(g(repo, 'status', '--porcelain').trim(), '', 'merge aborted, main tree clean');
  });

  test('a branch with no changes cleans up as "no changes"', () => {
    const r = git.worktreeStart(repo, 4);
    const msg = git.worktreeFinish(repo, r.wtPath, r.branch, 'test task #4');
    assert.equal(msg, 'no changes');
    assert.ok(!fs.existsSync(r.wtPath));
  });

  test('non-repo dir returns a clean error', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-plain-'));
    const r = git.worktreeStart(plain, 9);
    assert.ok(r.error, 'should not create worktrees outside repos');
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
