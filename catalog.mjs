// Catalog of free OpenRouter models: filtering, ranking and a tool-call probe.
// Pure functions (filterFree, rankModels, pickBatch, ...) are covered by free-router.test.mjs.

export const MIN_CONTEXT = 128_000;      // coding agents need a long context
export const PROBE_RETRY_DAYS = 14;      // a model that failed the probe is retried after two weeks
export const MAX_PROBES_PER_SYNC = 5;    // probes spend the daily free-request quota
export const BATCH_SIZE = 3;             // OpenRouter: "'models' array must have 3 items or fewer"

const DAY_MS = 24 * 3600 * 1000;

/** Free text models that support tool calling and have a long context. */
export function filterFree(models, minContext = MIN_CONTEXT) {
  return models.filter((m) => {
    if (!m?.id || m.id === 'openrouter/free') return false;           // the router itself is not a model
    const p = m.pricing || {};
    const free = m.id.endsWith(':free') || (String(p.prompt) === '0' && String(p.completion) === '0');
    if (!free) return false;
    if (Number(p.request || 0) > 0) return false;                     // per-request fee
    const params = m.supported_parameters || [];
    if (!params.includes('tools')) return false;
    const arch = m.architecture || {};
    const inMods = arch.input_modalities || ['text'];
    const outMods = arch.output_modalities || ['text'];
    if (!inMods.includes('text') || !outMods.includes('text')) return false;
    return Number(m.context_length || 0) >= minContext;
  });
}

/** Model size in billions of parameters from its id: "…-550b-a55b" → 550, "gemma-4-31b" → 31; unknown → 0. */
export function paramSize(id) {
  const name = id.split('/').pop().replace(/:free$/, '');
  const m = name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)b(?=$|[-_.])/i);
  return m ? Number(m[1]) : 0;
}

/**
 * Order: favorites first (in their order), then bigger, then newer.
 * Models that failed the probe are dropped until the retry period is over.
 */
export function rankModels(models, favorites = [], probes = {}, now = Date.now()) {
  const usable = models.filter((m) => probes[m.id]?.ok !== false || isProbeStale(probes[m.id], now));
  const fav = new Map(favorites.map((id, i) => [id, i]));
  return usable.sort((a, b) => {
    const fa = fav.has(a.id) ? fav.get(a.id) : Infinity;
    const fb = fav.has(b.id) ? fav.get(b.id) : Infinity;
    if (fa !== fb) return fa - fb;
    const sa = paramSize(a.id), sb = paramSize(b.id);
    if (sa !== sb) return sb - sa;
    return Number(b.created || 0) - Number(a.created || 0);
  });
}

export function isProbeStale(probe, now = Date.now()) {
  return !probe || now - Number(probe.at || 0) > PROBE_RETRY_DAYS * DAY_MS;
}

/** Models put to work: those that passed the probe, plus favorites that did not fail it. */
export function workingModels(ranked, favorites = [], probes = {}) {
  const fav = new Set(favorites);
  return ranked.filter((m) => probes[m.id]?.ok === true || (fav.has(m.id) && probes[m.id]?.ok !== false));
}

/** Next batch for a request, skipping models that are cooling down after a 429. */
export function pickBatch(ids, cooldown = {}, now = Date.now(), size = BATCH_SIZE) {
  return ids.filter((id) => !(cooldown[id] > now)).slice(0, size);
}

/** Models due for a probe: new ones, "unknown" ones, and old failures. */
export function needProbe(ranked, probes = {}, now = Date.now(), limit = MAX_PROBES_PER_SYNC) {
  return ranked.filter((m) => {
    const p = probes[m.id];
    return !p || p.ok === null || (p.ok === false && isProbeStale(p, now));
  }).slice(0, limit);
}

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather in a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

/** Probe request: the model has to call get_weather with a city. */
export function probeBody(id) {
  return {
    model: id,
    messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the tool.' }],
    tools: [PROBE_TOOL],
    tool_choice: 'auto',
    max_tokens: 300,
  };
}

/** Probe verdict: true — passed, false — failed, null — unknown (busy, rate limited). */
export function judgeProbe(status, body) {
  if (status === 429 || status >= 500) return null;
  if (status !== 200) return false;
  const call = body?.choices?.[0]?.message?.tool_calls?.[0];
  if (call?.function?.name !== 'get_weather') return false;
  try {
    const args = JSON.parse(call.function.arguments || '{}');
    return typeof args.city === 'string' && args.city.length > 0;
  } catch {
    return false;
  }
}
