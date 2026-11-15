// Writes the "free-auto" provider into a DeepSeek Harness cordis.patch.yml.
// Finds the `free-auto:` key inside `providers:` and replaces its block (by indentation);
// if there is none, inserts it right after `providers:`. The rest of the file is left untouched.
// DSH rewrites this file itself from its UI and drops comments, so we anchor on the key, not on markers.
import { readFileSync, writeFileSync, renameSync, statSync, chmodSync } from 'node:fs';

export const PROVIDER_ID = 'free-auto';
export const AUTO_MODEL = 'auto';
export const AUTO_CONTEXT = 128_000; // not more than any listed model has (MIN_CONTEXT)
export const MAX_TOKENS = 8192;

const q = (s) => JSON.stringify(String(s)); // a double-quoted YAML string is a JSON string

/** Provider block; `indent` is the indentation of the provider key. */
export function renderProvider(models, { baseURL, apiKeyEnv, displayName = 'Free OpenRouter (auto)' }, indent = '      ') {
  const i1 = indent + '  ';
  const i2 = i1 + '  ';
  const i3 = i2 + '  ';
  const lines = [
    `${indent}${PROVIDER_ID}:`,
    `${i1}# Written by free-router once a day — do not edit by hand.`,
    `${i1}displayName: ${q(displayName)}`,
    `${i1}api: openai-completions`,
    `${i1}baseURL: ${q(baseURL)}`,
  ];
  if (apiKeyEnv) lines.push(`${i1}apiKeyEnv: ${apiKeyEnv}`);
  lines.push(`${i1}timeoutMs: 600000`, `${i1}models:`);
  const entries = [
    { id: AUTO_MODEL, name: 'Auto: best available free model', ctx: AUTO_CONTEXT },
    ...models.map((m) => {
      const name = m.name || m.id;
      return { id: m.id, name: /free/i.test(name) ? name : `${name} (free)`, ctx: Number(m.context_length) || AUTO_CONTEXT };
    }),
  ];
  for (const e of entries) {
    lines.push(
      `${i2}- id: ${q(e.id)}`,
      `${i3}name: ${q(e.name)}`,
      `${i3}contextWindow: ${e.ctx}`,
      `${i3}maxTokens: ${MAX_TOKENS}`,
    );
  }
  return lines.join('\n') + '\n';
}

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);

/** New file text with the provider block updated; null if there is no `providers:` to insert into. */
export function upsertProvider(text, models, opts) {
  const lines = text.split('\n');
  const keyRe = new RegExp(`^(\\s+)${PROVIDER_ID}:\\s*$`);
  let start = lines.findIndex((l) => keyRe.test(l));
  let end;
  let indent;
  if (start >= 0) {
    indent = lines[start].match(keyRe)[1];
    end = start + 1;
    while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > indent.length)) end++;
    // trailing blank lines and comments belong to the next block
    while (end > start + 1 && isBlank(lines[end - 1])) end--;
  } else {
    const p = lines.findIndex((l) => /^\s+providers:\s*$/.test(l));
    if (p < 0) return null;
    indent = ' '.repeat(indentOf(lines[p]) + 2);
    start = end = p + 1;
  }
  const block = renderProvider(models, opts, indent).replace(/\n$/, '').split('\n');
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

/** Update the file in place (atomically, keeping its mode). Returns 'updated' | 'same' | 'no-providers'. */
export function updatePatchFile(path, models, opts) {
  const text = readFileSync(path, 'utf8');
  const next = upsertProvider(text, models, opts);
  if (next === null) return 'no-providers';
  if (next === text) return 'same';
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.free-router.tmp`;
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return 'updated';
}
