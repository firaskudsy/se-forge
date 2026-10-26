// A model server for forge llm's tests (decision 140): /v1/models and /v1/messages under /gpu/llm behind a bearer
// key, like vLLM behind a proxy. FAKE_LLM_TOOLS=off answers tool calls as vLLM does without --enable-auto-tool-choice;
// FAKE_LLM_CONTEXT sets the context it reports. Prints its port.
import http from 'node:http';

const KEY = 'fake-llm-key';
const MODEL = 'Qwen/Qwen3.8-27B';
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'invalid api key' });
  if (req.method === 'GET' && req.url === '/gpu/llm/v1/models') return send(200, { object: 'list', data: [{ id: MODEL, max_model_len: Number(process.env.FAKE_LLM_CONTEXT || 262144) }] });
  if (req.method !== 'POST' || req.url !== '/gpu/llm/v1/messages') return send(404, { detail: 'Not Found' });
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const r = JSON.parse(body);
    if (r.model !== MODEL) return send(404, { error: { message: `The model \`${r.model}\` does not exist.` } });
    if (r.tools && process.env.FAKE_LLM_TOOLS === 'off') return send(400, { type: 'error', error: { type: 'BadRequestError', message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } });
    return send(200, { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 1 } });
  });
  return undefined;
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
