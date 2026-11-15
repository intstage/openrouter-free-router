// node --test free-router.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterFree, paramSize, rankModels, workingModels, pickBatch, needProbe, judgeProbe,
} from './catalog.mjs';
import { upsertProvider } from './dsh-config.mjs';

const m = (id, extra = {}) => ({
  id, name: id, context_length: 262144, created: 1, supported_parameters: ['tools'],
  pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, ...extra,
});

test('filterFree: only free text models with tools and a long context', () => {
  const list = [
    m('a/big-550b:free'),
    m('openrouter/free'),
    m('b/paid', { pricing: { prompt: '0.000001', completion: '0' } }),
    m('c/notools:free', { supported_parameters: [] }),
    m('d/short:free', { context_length: 32000 }),
    m('e/music:free', { architecture: { input_modalities: ['text'], output_modalities: ['audio'] } }),
    m('f/zero-price'),
  ];
  assert.deepEqual(filterFree(list).map((x) => x.id), ['a/big-550b:free', 'f/zero-price']);
});

test('paramSize: size from the id', () => {
  assert.equal(paramSize('nvidia/nemotron-3-ultra-550b-a55b:free'), 550);
  assert.equal(paramSize('google/gemma-4-31b-it:free'), 31);
  assert.equal(paramSize('liquid/lfm-3-1.7b:free'), 1.7);
  assert.equal(paramSize('inclusionai/ling-3.2-flash:free'), 0);
});

test('rankModels: favorites first, then bigger, then newer; failed ones dropped', () => {
  const now = Date.now();
  const list = [m('x/small-7b:free'), m('x/huge-400b:free'), m('x/fav-31b:free'), m('x/new:free', { created: 9 }),
    m('x/old:free', { created: 2 }), m('x/bad-900b:free')];
  const probes = { 'x/bad-900b:free': { ok: false, at: now } };
  const ids = rankModels(list, ['x/fav-31b:free'], probes, now).map((x) => x.id);
  assert.deepEqual(ids, ['x/fav-31b:free', 'x/huge-400b:free', 'x/small-7b:free', 'x/new:free', 'x/old:free']);
});

test('workingModels: probed-ok models and non-failed favorites', () => {
  const list = [m('a'), m('b'), m('c'), m('fav')];
  const probes = { a: { ok: true }, b: { ok: null }, fav: { ok: null } };
  assert.deepEqual(workingModels(list, ['fav'], probes).map((x) => x.id), ['a', 'fav']);
});

test('pickBatch: three models, skipping cooling ones', () => {
  const now = 1000;
  assert.deepEqual(pickBatch(['a', 'b', 'c', 'd', 'e'], { b: 2000, c: 500 }, now), ['a', 'c', 'd']);
});

test('needProbe: new and unknown ones, not a fresh failure', () => {
  const now = Date.now();
  const list = [m('new'), m('ok'), m('unknown'), m('failed'), m('oldfail')];
  const probes = { ok: { ok: true, at: now }, unknown: { ok: null, at: now }, failed: { ok: false, at: now },
    oldfail: { ok: false, at: now - 30 * 864e5 } };
  assert.deepEqual(needProbe(list, probes, now).map((x) => x.id), ['new', 'unknown', 'oldfail']);
});

test('judgeProbe', () => {
  const call = (name, args) => ({ choices: [{ message: { tool_calls: [{ function: { name, arguments: args } }] } }] });
  assert.equal(judgeProbe(200, call('get_weather', '{"city":"Paris"}')), true);
  assert.equal(judgeProbe(200, call('get_weather', 'not json')), false);
  assert.equal(judgeProbe(200, { choices: [{ message: { content: 'The weather is nice' } }] }), false);
  assert.equal(judgeProbe(429, {}), null);
  assert.equal(judgeProbe(400, {}), false);
});

const PATCH = `- id: llm-pi-ai
  config:
    providers:
      ollama:
        displayName: Ollama
        models:
          - id: qwen
            maxTokens: 4096
- id: agent-default-model
  config:
    provider: ollama
`;

test('upsertProvider: insert, replace without duplicates, rest untouched', () => {
  const opts = { baseURL: 'http://127.0.0.1:11500/v1', apiKeyEnv: 'FREE_ROUTER_KEY' };
  const once = upsertProvider(PATCH, [m('a/x:free', { name: 'X (free)' })], opts);
  assert.match(once, /^ {6}free-auto:$/m);
  assert.match(once, /"auto"/);
  assert.match(once, /apiKeyEnv: FREE_ROUTER_KEY/);
  const twice = upsertProvider(once, [m('b/y:free', { name: 'Y' })], opts);
  assert.equal(twice.match(/free-auto:/g).length, 1);
  assert.doesNotMatch(twice, /a\/x:free/);
  assert.match(twice, /"Y \(free\)"/);
  // ollama and agent-default-model are intact
  assert.match(twice, /ollama:\n {8}displayName: Ollama/);
  assert.match(twice, /- id: agent-default-model\n {2}config:\n {4}provider: ollama/);
  assert.equal(upsertProvider(twice, [m('b/y:free', { name: 'Y' })], opts), twice);
  assert.equal(upsertProvider('- id: x\n  config: {}\n', [], opts), null);
});

test('upsertProvider: free-auto as the last block in the file', () => {
  const opts = { baseURL: 'http://h/v1' };
  const tail = `- id: llm-pi-ai\n  config:\n    providers:\n      ollama:\n        api: x\n`;
  const a = upsertProvider(tail, [m('a')], opts);
  const b = upsertProvider(a.replace('    providers:\n', '    providers:\n'), [m('b')], opts);
  assert.equal(b.match(/free-auto:/g).length, 1);
  assert.doesNotMatch(b, /"a"/);
});
