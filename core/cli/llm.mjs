// forge llm (decision 140): a checkout's agents on a self-hosted model server instead of Claude's.
//   forge llm                         the servers this machine knows, and the one this checkout runs on
//   forge llm add <name> --url <address> --model <model> [--opus <m>] [--sonnet <m>] [--haiku <m>] [--key-file <file>]
//   forge llm use <name> | claude     from the next Claude Code session, this checkout runs there (or on Claude)
//   forge llm remove <name>
// The servers live in the machine's settings, never in the team repo: an address and a key are a person's. Claude
// Code talks to the server in Anthropic's Messages format (/v1/messages); the kit's tiers keep asking for opus, sonnet
// and haiku, and the server's model names stand in for those aliases.
import fs from 'node:fs';
import path from 'node:path';
import { NAME, findKey, keyFile, keyService } from './llm-key.mjs';
import { llmInUse } from '../policy/lib/llm.mjs';

export class LlmError extends Error {}

const ALIASES = ['opus', 'sonnet', 'haiku'];
const MODEL = /^[\w.:/@[\]-]+$/;
const MARK = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const USAGE_ADD = 'forge llm add <name> --url <address> --model <model> [--opus <m>] [--sonnet <m>] [--haiku <m>] [--key-file <file>]';
const USAGE = `forge llm | ${USAGE_ADD} | forge llm use <name>|claude | forge llm remove <name>`;
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };
const line = (r) => `${MARK[r.level]} ${r.msg}`;

export function modelsText(models) {
  const names = [...new Set(ALIASES.map((a) => models[a]))];
  return names.length === 1 ? `${names[0]} for opus, sonnet and haiku` : ALIASES.map((a) => `${a} ${models[a]}`).join(', ');
}

// What forge sync writes into .claude/settings.local.json for a server: its address, its model for each alias (the
// session's own model is the opus one, as the lead's is), no attribution block (Anthropic's API strips it, another
// server reads it as part of the prompt and of its cache key), and the key helper.
export function llmSettings(name, server, kitDir) {
  const m = server.models;
  return {
    env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_MODEL: m.opus, ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus, ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet, ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku, ANTHROPIC_DEFAULT_FABLE_MODEL: m.opus, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
    apiKeyHelper: `node "${path.join(kitDir, 'core', 'cli', 'llm-key.mjs')}" ${name}`,
  };
}
const LLM_ENV = Object.keys(llmSettings('x', { url: '', models: {} }, '').env);

// What a person set in settings.local.json themselves and forge llm would overwrite (not what forge sync wrote).
function ownSettings(settings, managed) {
  const ours = new Set(managed.env || []);
  const own = LLM_ENV.filter((k) => settings.env?.[k] !== undefined && !ours.has(k));
  if (settings.apiKeyHelper && settings.apiKeyHelper !== managed.apiKeyHelper) own.push('apiKeyHelper');
  return own;
}

// The settings forge sync writes for this checkout: { settings } for its server, {} on Claude, or { warn } when the
// server cannot be used (the checkout then runs on Claude).
export function llmFor({ stateDir, kitDir, cfg, settings, managed }) {
  const name = llmInUse(stateDir);
  if (!name) return {};
  const server = cfg.llm?.[name];
  if (!server) return { warn: `this checkout is set to ${name}, which this machine does not know: forge llm add ${name} … (or forge llm use claude). Claude Code runs on Claude until then.` };
  if (!fs.existsSync(path.join(kitDir, 'core', 'cli', 'llm-key.mjs'))) return { warn: `the project's kit is older than forge llm: forge upgrade --to 0.2.38 (or later), then forge save. Claude Code runs on Claude until then.` };
  const own = ownSettings(settings, managed);
  if (own.length) return { warn: `.claude/settings.local.json sets ${own.join(', ')} itself; remove ${own.length === 1 ? 'it' : 'them'} and run forge sync to run on ${name}. Claude Code runs on those settings until then.` };
  return { settings: llmSettings(name, server, kitDir) };
}

// project.models entries that are full model names: Claude Code sends them to the server as they are.
const fullNames = (models) => Object.entries(models || {}).filter(([, m]) => !['opus', 'sonnet', 'haiku', 'fable'].includes(m));
const fullNameLine = ([tier, m], name) => ({ level: 'warn', msg: `model server: project.models.${tier} is ${m}, a full model name, which ${name} does not serve: set it to opus, sonnet or haiku in project.json (then forge save)` });

const why = (r) => {
  const j = r.json;
  return String(j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.message ?? r.text.slice(0, 200)).trim();
};

// What the server answers, as forge doctor lines: reachable with the key, serving the models with room for the lead's
// context, and taking tool calls in Anthropic's format (every step of Claude Code is one). The key goes in both
// headers, as Claude Code's key helper sends it.
export async function probe(server, key, { needContext = 200000, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const headers = { authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const call = async (to, body) => {
    try {
      const r = await fetchImpl(`${server.url}${to}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text };
    } catch (e) {
      return { error: e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : (e.cause?.message || e.message) };
    }
  };
  const out = [];
  const list = await call('/v1/models');
  if (list.error) return [{ level: 'fail', msg: `model server: ${server.url} cannot be reached: ${list.error}` }];
  if (list.status === 401 || list.status === 403) return [{ level: 'fail', msg: `model server: ${server.url} refused the key (HTTP ${list.status}: ${why(list)})` }];
  const models = [...new Set(ALIASES.map((a) => server.models[a]))];
  if (list.status === 200 && Array.isArray(list.json?.data)) {
    const served = new Map(list.json.data.map((d) => [d.id, d]));
    const missing = models.filter((m) => !served.has(m));
    if (missing.length) out.push({ level: 'fail', msg: `model server: ${missing.join(', ')} not served at ${server.url} (it serves ${[...served.keys()].join(', ') || 'nothing'})` });
    else out.push({ level: 'ok', msg: `model server: ${server.url} serves ${models.join(', ')}` });
    for (const m of models.filter((x) => served.get(x)?.max_model_len < needContext)) out.push({ level: 'warn', msg: `model server: ${m} has a context of ${served.get(m).max_model_len} tokens and the lead compacts at ${needContext}: a long session fails before then` });
  } else out.push({ level: 'info', msg: `model server: no model list at ${server.url}/v1/models (HTTP ${list.status}), so the model names are not checked` });
  const reply = await call('/v1/messages', { model: server.models.opus, max_tokens: 1, tools: [{ name: 'probe', description: 'A connection check.', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'ping' }] });
  if (reply.error) out.push({ level: 'fail', msg: `model server: ${server.url}/v1/messages cannot be reached: ${reply.error}` });
  else if (reply.status === 200) out.push({ level: 'ok', msg: `model server: ${server.models.opus} takes tool calls at ${server.url}/v1/messages` });
  else if (reply.status === 404 && !/model/i.test(why(reply))) out.push({ level: 'fail', msg: `model server: no Anthropic Messages endpoint at ${server.url}/v1/messages (HTTP 404). Claude Code needs one: vLLM, Ollama 0.14 or later and llama.cpp's server have it; others need a translator such as LiteLLM in front` });
  else {
    const w = why(reply);
    out.push({ level: 'fail', msg: `model server: ${server.url}/v1/messages refused a tool call (HTTP ${reply.status}: ${w})${/tool/i.test(w) ? '. vLLM takes tool calls when started with --enable-auto-tool-choice and a --tool-call-parser for the model' : ''}` });
  }
  return out;
}

// forge doctor's lines for the checkout's model server.
export async function llmDoctor({ stateDir, kitDir, cfg, settings, managed, models, needContext, env }) {
  const name = llmInUse(stateDir);
  const known = Object.keys(cfg.llm || {});
  if (!name) return known.length ? [{ level: 'info', msg: `model server: Claude (this machine also knows ${known.join(', ')}: forge llm use <name>)` }] : [];
  const r = llmFor({ stateDir, kitDir, cfg, settings, managed });
  if (r.warn) return [{ level: 'fail', msg: `model server: ${r.warn}` }];
  const server = cfg.llm[name];
  const written = Object.entries(r.settings.env).every(([k, v]) => settings.env?.[k] === v) && settings.apiKeyHelper === r.settings.apiKeyHelper;
  const out = [written ? { level: 'ok', msg: `model server ${name}: ${server.url}, ${modelsText(server.models)}` } : { level: 'fail', msg: `model server ${name}: .claude/settings.local.json does not point Claude Code at it: forge sync` }];
  out.push(...fullNames(models).map((e) => fullNameLine(e, name)));
  const k = findKey(name, env);
  if (k.error) return [...out, { level: 'fail', msg: `model server: ${k.error}` }];
  out.push({ level: 'ok', msg: `model server: key from ${k.source}` });
  return [...out, ...(await probe(server, k.key, { needContext }))];
}

// The dashboard's words for the server a checkout runs on, or null on Claude.
export function llmLabel(stateDir, cfg) {
  const name = llmInUse(stateDir);
  const s = name && cfg.llm?.[name];
  return name ? `${name}${s ? ` (${[...new Set(ALIASES.map((a) => s.models[a]))].join(', ')})` : ''}` : null;
}

const storeHint = (name, env) => [
  `No key stored for ${name} yet. Store it once, in one of (GUIDE.md, H):`,
  `  macOS Keychain:  security add-generic-password -U -s ${keyService(name)} -a "$USER" -T /usr/bin/security -w`,
  `  Linux keyring:   secret-tool store --label="se-forge model server ${name}" service ${keyService(name)}`,
  `  a private file:  forge llm add ${name} … --key-file <file> (copied to ${keyFile(name, env)})`,
].join('\n');

export async function llm(o, { env, cwd, out, cfgFile, main, sync, needContext, models }) {
  const [sub, name] = o._;
  const cfg = readJson(cfgFile, {});
  const servers = cfg.llm || {};
  const stateDir = main ? path.join(main, '.forge', 'state') : null;
  const stateFile = stateDir && path.join(stateDir, 'llm.json');

  if (!sub) {
    const names = Object.keys(servers);
    if (!names.length) out(`No model servers on this machine: ${USAGE_ADD}`);
    else {
      out('Model servers on this machine:');
      for (const n of names) { const k = findKey(n, env); out(`- ${n}: ${servers[n].url}, ${modelsText(servers[n].models)}; key: ${k.error ? 'none stored' : k.source}`); }
    }
    if (stateDir) out(`This checkout runs on ${llmInUse(stateDir) ?? 'Claude'}.`);
    return 0;
  }

  if (sub === 'add') {
    if (!NAME.test(name || '') || name === 'claude') throw new LlmError(`a server's name is lowercase letters, digits and dashes, not "claude": ${USAGE_ADD}`);
    const url = typeof o.url === 'string' ? o.url.trim().replace(/\/+$/, '').replace(/\/v1$/, '') : '';
    if (!/^https?:\/\/\S+$/.test(url)) throw new LlmError(`--url is the server's address, e.g. https://gpu.example.com (Claude Code adds /v1/messages): ${USAGE_ADD}`);
    const picked = Object.fromEntries(ALIASES.map((a) => [a, typeof o[a] === 'string' ? o[a] : typeof o.model === 'string' ? o.model : '']));
    const none = ALIASES.filter((a) => !MODEL.test(picked[a]));
    if (none.length) throw new LlmError(`--model names the server's model for opus, sonnet and haiku (or --opus, --sonnet, --haiku one by one); ${none.join(', ')} has none: ${USAGE_ADD}`);
    if (o['key-file'] !== undefined) {
      const from = path.resolve(cwd, String(o['key-file']));
      const key = fs.existsSync(from) && fs.statSync(from).isFile() ? fs.readFileSync(from, 'utf8').split(/\r?\n/)[0].trim() : '';
      if (!key) throw new LlmError(`--key-file ${from} holds no key`);
      const to = keyFile(name, env);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.writeFileSync(to, `${key}\n`, { mode: 0o600 });
      fs.chmodSync(to, 0o600);
      out(`key copied to ${to}, readable by you only; you can delete ${from}`);
    }
    cfg.llm = { ...servers, [name]: { url, models: picked } };
    writeJson(cfgFile, cfg);
    out(`model server ${name}: ${url}, ${modelsText(picked)}`);
    const k = findKey(name, env);
    if (k.error) out(storeHint(name, env));
    else {
      out(`key: ${k.source}`);
      for (const r of await probe(cfg.llm[name], k.key)) out(line(r));
    }
    out(`In an app's checkout: forge llm use ${name}`);
    return 0;
  }

  if (sub === 'use') {
    if (!name) throw new LlmError(USAGE);
    if (!main) throw new LlmError('forge llm use runs in an app\'s checkout');
    const before = llmInUse(stateDir);
    const restore = () => (before ? writeJson(stateFile, { server: before }) : fs.rmSync(stateFile, { force: true }));
    const switched = 'from the next Claude Code session: /pause a running one first, then /resume in a new one';
    if (name === 'claude') {
      if (!before) { out('This checkout runs on Claude already.'); return 0; }
      fs.rmSync(stateFile, { force: true });
      try { await sync(); } catch (e) { restore(); throw e; }
      out(`This checkout runs on Claude again (it was ${before}) ${switched}.`);
      return 0;
    }
    const server = servers[name];
    if (!server) throw new LlmError(`this machine knows no model server named ${name}${Object.keys(servers).length ? ` (it knows ${Object.keys(servers).join(', ')})` : ''}: ${USAGE_ADD}`);
    if (!fs.existsSync(path.join(main, '.forge', 'kit', 'core', 'cli', 'llm-key.mjs'))) throw new LlmError('this checkout\'s kit is older than forge llm (it came with 0.2.38): forge upgrade --to 0.2.38 (or later) first, then forge save');
    const k = findKey(name, env);
    if (k.error) throw new LlmError(`${k.error}\n${storeHint(name, env)}`);
    const own = ownSettings(readJson(path.join(main, '.claude', 'settings.local.json'), {}), readJson(path.join(stateDir, 'settings-managed.json'), {}));
    if (own.length) throw new LlmError(`.claude/settings.local.json sets ${own.join(', ')} itself; remove ${own.length === 1 ? 'it' : 'them'} first, so forge llm does not overwrite ${own.length === 1 ? 'it' : 'them'}`);
    writeJson(stateFile, { server: name });
    try { await sync(); } catch (e) { restore(); throw e; }
    for (const e of fullNames(models)) out(line(fullNameLine(e, name)));
    for (const r of await probe(server, k.key, { needContext })) out(line(r));
    out(`This checkout runs on ${name} (${modelsText(server.models)}) ${switched}. If Claude Code warns that two credentials are set, the key helper is the one it uses. forge llm use claude switches back.`);
    return 0;
  }

  if (sub === 'remove') {
    if (!servers[name]) throw new LlmError(`this machine knows no model server named ${name || '(none given)'}`);
    delete servers[name];
    if (Object.keys(servers).length) cfg.llm = servers; else delete cfg.llm;
    writeJson(cfgFile, cfg);
    out(`model server ${name} removed. Its key stays where you stored it: security delete-generic-password -s ${keyService(name)} (macOS), secret-tool clear service ${keyService(name)} (Linux), or rm "${keyFile(name, env)}".`);
    if (stateDir && llmInUse(stateDir) === name) out(`! this checkout is still set to ${name}: forge llm use claude`);
    return 0;
  }
  throw new LlmError(USAGE);
}
