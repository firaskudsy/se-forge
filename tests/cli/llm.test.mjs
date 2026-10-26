// forge llm (decision 140): what the probe reports for each answer a model server gives, and what forge sync writes.
// The commands themselves run against a fake server in tests/cli/forge.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, llmSettings, modelsText, llmLabel } from '../../core/cli/llm.mjs';

const SERVER = { url: 'https://gpu.example.com/llm', models: { opus: 'big', sonnet: 'big', haiku: 'small' } };
const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
// A fetch that answers each path from a table, and records what it was sent.
function fake(table) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    const r = table[new URL(url).pathname];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, sent };
}
const levels = (rs) => rs.map((r) => `${r.level}: ${r.msg}`);

test('a server that serves the models and takes tool calls passes; the key goes in both headers, never in a line', async () => {
  const f = fake({ '/llm/v1/models': reply(200, { data: [{ id: 'big', max_model_len: 262144 }, { id: 'small' }] }), '/llm/v1/messages': reply(200, { type: 'message' }) });
  const rs = await probe(SERVER, 'sk-local-1', { fetchImpl: f.fetchImpl });
  assert.deepEqual(levels(rs), ['ok: model server: https://gpu.example.com/llm serves big, small', 'ok: model server: big takes tool calls at https://gpu.example.com/llm/v1/messages']);
  assert.equal(f.sent[0].init.headers.authorization, 'Bearer sk-local-1');
  assert.equal(f.sent[0].init.headers['x-api-key'], 'sk-local-1');
  const body = JSON.parse(f.sent[1].init.body);
  assert.equal(body.model, 'big');
  assert.equal(body.max_tokens, 1, 'the check costs one token');
  assert.equal(body.tools.length, 1);
  assert.ok(!JSON.stringify(rs).includes('sk-local-1'));
});

test('the probe says what is wrong: unreachable, the key refused, a model missing, a small context, no tool calls, no endpoint', async () => {
  const down = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') });
  assert.deepEqual(levels(await probe(SERVER, 'k', fake({ '/llm/v1/models': down }))), ['fail: model server: https://gpu.example.com/llm cannot be reached: connect ECONNREFUSED 10.0.0.1:443']);
  assert.deepEqual(levels(await probe(SERVER, 'k', fake({ '/llm/v1/models': reply(401, { error: 'invalid api key' }) }))), ['fail: model server: https://gpu.example.com/llm refused the key (HTTP 401: invalid api key)']);

  let rs = await probe(SERVER, 'k', { ...fake({ '/llm/v1/models': reply(200, { data: [{ id: 'big', max_model_len: 131072 }] }), '/llm/v1/messages': reply(400, { type: 'error', error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } }) }), needContext: 200000 });
  assert.deepEqual(levels(rs), [
    'fail: model server: small not served at https://gpu.example.com/llm (it serves big)',
    'warn: model server: big has a context of 131072 tokens and the lead compacts at 200000: a long session fails before then',
    'fail: model server: https://gpu.example.com/llm/v1/messages refused a tool call (HTTP 400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set). vLLM takes tool calls when started with --enable-auto-tool-choice and a --tool-call-parser for the model',
  ]);

  // A server with no model list and no Anthropic endpoint (an OpenAI-only server).
  rs = await probe(SERVER, 'k', fake({ '/llm/v1/models': reply(404, 'Not Found'), '/llm/v1/messages': reply(404, { detail: 'Not Found' }) }));
  assert.equal(rs[0].level, 'info');
  assert.match(rs[1].msg, /no Anthropic Messages endpoint at https:\/\/gpu\.example\.com\/llm\/v1\/messages \(HTTP 404\)\. Claude Code needs one: .*LiteLLM/);
  // A 404 that names the model is the model, not the endpoint.
  rs = await probe(SERVER, 'k', fake({ '/llm/v1/models': reply(404, ''), '/llm/v1/messages': reply(404, { error: { message: 'The model `big` does not exist.' } }) }));
  assert.match(rs[1].msg, /refused a tool call \(HTTP 404: The model `big` does not exist\.\)$/);
});

test('forge sync writes the server, a model for each alias, no attribution block and the key helper', () => {
  const s = llmSettings('gpu', SERVER, '/work/app/.forge/kit');
  assert.deepEqual(s.env, {
    ANTHROPIC_BASE_URL: 'https://gpu.example.com/llm',
    ANTHROPIC_MODEL: 'big',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'big',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'big',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'big',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  });
  assert.equal(s.apiKeyHelper, 'node "/work/app/.forge/kit/core/cli/llm-key.mjs" gpu');
  assert.equal(modelsText({ opus: 'q', sonnet: 'q', haiku: 'q' }), 'q for opus, sonnet and haiku');
  assert.equal(modelsText(SERVER.models), 'opus big, sonnet big, haiku small');
});

test('the dashboard names the server a checkout runs on', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-state-'));
  assert.equal(llmLabel(state, { llm: { gpu: SERVER } }), null, 'on Claude');
  fs.writeFileSync(path.join(state, 'llm.json'), JSON.stringify({ server: 'gpu' }));
  assert.equal(llmLabel(state, { llm: { gpu: SERVER } }), 'gpu (big, small)');
  assert.equal(llmLabel(state, {}), 'gpu', 'a server this machine no longer knows');
});
