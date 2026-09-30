'use strict';
// bridge/gpu.js parsers + local-model detection. Fixtures are real output
// captured from an RTX 3060 / Ollama 0.34 machine.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../bridge/gpu.js');

describe('nvidia-smi', () => {
  test('parses the GPU line', () => {
    const [x] = g.parseSmi('0, NVIDIA GeForce RTX 3060, 40, 11, 7527, 12288, 53, 73.33, 170.00, 33, 610.88\n');
    assert.equal(x.name, 'NVIDIA GeForce RTX 3060');
    assert.equal(x.util, 40);
    assert.equal(x.vramUsedMB, 7527);
    assert.equal(x.vramTotalMB, 12288);
    assert.equal(x.powerW, 73.33);
    assert.equal(x.driver, '610.88');
  });

  test('a field the driver reports as [N/A] is unknown, not zero', () => {
    const [x] = g.parseSmi('0, Some GPU, 5, 1, 100, 8192, 40, [N/A], [N/A], [N/A], 550.1');
    assert.equal(x.powerW, null);
    assert.equal(x.fanPct, null);
  });

  test('Windows per-process VRAM "[N/A]" is null (regression: it read as 0 MB)', () => {
    const apps = g.parseApps('10720, C:\\Windows\\explorer.exe, [N/A]\n27376, F:\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe, [N/A]\n');
    assert.equal(apps.length, 2);
    assert.equal(apps[1].name, 'FortniteClient-Win64-Shipping.exe');
    assert.equal(apps[0].vramMB, null);
  });

  test('Linux per-process VRAM is read', () => {
    const [a] = g.parseApps('4242, /usr/bin/ollama, 5012 MiB');
    assert.equal(a.name, 'ollama');
    assert.equal(a.vramMB, 5012);
  });

  test('processes it cannot see are dropped, not listed as "[Insufficient Permissions]"', () => {
    assert.equal(g.parseApps('2028, [Insufficient Permissions], [N/A]').length, 0);
  });

  test('no GPU / garbage → empty', () => {
    assert.deepEqual(g.parseSmi(''), []);
    assert.deepEqual(g.parseSmi('NVIDIA-SMI has failed because it could not communicate with the driver'), []);
  });
});

describe('Ollama / LM Studio', () => {
  test('/api/ps: size, VRAM, keep-alive expiry', () => {
    const [m] = g.parseOllamaPs({ models: [{ name: 'qwen2.5:7b-instruct', size: 5133943438, size_vram: 5133943438,
      details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, expires_at: '2026-09-29T22:57:42.0630117-05:00', context_length: 8192 }] });
    assert.equal(m.name, 'qwen2.5:7b-instruct');
    assert.equal(m.vramMB, 4896);
    assert.equal(m.params, '7.6B');
    assert.equal(m.expiresAt, Date.parse('2026-09-29T22:57:42.063-05:00'));
  });

  test('LM Studio lists only loaded models', () => {
    const r = g.parseLmStudio({ data: [{ id: 'a', state: 'loaded', arch: 'llama' }, { id: 'b', state: 'not-loaded' }] });
    assert.deepEqual(r.map((x) => x.name), ['a']);
  });

  test('nothing running → empty lists, never a throw', () => {
    assert.deepEqual(g.parseOllamaPs(null), []);
    assert.deepEqual(g.parseLmStudio(undefined), []);
  });
});

describe('is this agent running on a local model?', () => {
  const installed = ['qwen2.5:7b-instruct', 'llama3.2:latest', 'gemma3:27b'];
  test('claude-code-router style "provider,model"', () => assert.equal(g.isLocalModel('ollama,qwen2.5:7b-instruct', installed), true));
  test('provider prefix alone is enough', () => assert.equal(g.isLocalModel('ollama/some-new-model', []), true));
  test('bare tag matches an installed model, ":latest" optional', () => assert.equal(g.isLocalModel('llama3.2', installed), true));
  test('cloud models are not local', () => {
    assert.equal(g.isLocalModel('claude-opus-5-5', installed), false);
    assert.equal(g.isLocalModel('gpt-6', installed), false);
    assert.equal(g.isLocalModel('', installed), false);
  });
});
