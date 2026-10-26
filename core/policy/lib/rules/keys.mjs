// Keys: the OpenProject API key, a model server's key (forge llm, decision 140) and stored keyring passwords never
// reach an agent. `forge tracker` and Claude Code's key helper load them in their own processes, which the hook never
// sees.
import { deny } from '../decision.mjs';
import { isOpenProjectKeyPath, isOpenProjectKeyDir, isLlmKeyPath, globToRegex } from '../paths.mjs';
import { llmNames } from '../llm.mjs';
import { METADATA, GREP_LIKE, CODE_RUNNERS, candidates, withoutGrepPattern } from './secrets.mjs';
import { gitSecretSafe } from './git.mjs';

const KEY_MSG = 'The OpenProject API key is never read, printed or sent by an agent. Use `forge tracker`; it loads the key itself.';
const PASSWORD_MSG = 'Printing a stored keyring password is never an agent\'s job. Scripts load their own credentials.';
const DUMP_MSG = 'Dumping or exporting a keychain exposes every stored secret.';
const LLM_MSG = 'A model server\'s key is never read, printed or sent by an agent. Claude Code loads it through its key helper (forge llm).';

const KEY_VAR = /\$\{?OPENPROJECT_API_KEY\b/;
const KEY_SERVICE = /se-forge-openproject/;
const KEY_SCRIPT = /(^|[/\\])(openproject-key\.sh|adapters[/\\]openproject\.sh)$/;
const FETCHERS = new Set(['curl', 'wget', 'xh', 'http', 'https']);
const LLM_SERVICE = /se-forge-llm-/;
const LLM_SCRIPT = /(^|[/\\])llm-key\.mjs$/;
const JS_RUNNERS = new Set(['node', 'bun', 'deno']);

// A glob whose last part can match openproject-key, inside a folder that can match se-forge.
function globNamesKey(word) {
  const parts = word.replace(/\\/g, '/').split('/');
  const [dir, file] = [parts.at(-2) ?? '', parts.at(-1)];
  if (!/[*?[]/.test(dir + file)) return false;
  return globToRegex(file).test('openproject-key') && (dir === '' ? false : globToRegex(dir).test('se-forge'));
}
// Any path named openproject-key; an unquoted Windows path loses its backslashes (se-forgeopenproject-key).
const namesKey = (w) => isOpenProjectKeyPath(w) || isOpenProjectKeyDir(w) || globNamesKey(w)
  || /(^|[/\\])openproject-key$/.test(w) || /se-forge[/\\]*openproject-key$/.test(w);

// A model server's key file, se-forge/llm-<name>-key; a glob reaches it when its folder can match se-forge and its last
// part can match the file of any server this machine knows, or of one named x.
function globNamesLlmKey(word, names) {
  const parts = word.replace(/\\/g, '/').split('/');
  const [dir, file] = [parts.at(-2) ?? '', parts.at(-1)];
  if (!/[*?[]/.test(dir + file) || dir === '' || !globToRegex(dir).test('se-forge')) return false;
  return ['x', ...names].some((n) => globToRegex(file).test(`llm-${n}-key`));
}
const namesLlmKey = (w, names) => isLlmKeyPath(w) || globNamesLlmKey(w, names) || /(^|[/\\])llm-[^/\\]*-key$/.test(w) || /se-forge[/\\]*llm-[^/\\]*-key$/.test(w);

const valueFlag = (a) => /^-[a-zA-Z]*[wg][a-zA-Z]*$/.test(a);
function basicIsApikey(word) {
  for (const m of String(word).matchAll(/Basic\s+([A-Za-z0-9+/=_-]+)/gi)) {
    if (/^apikey:/i.test(Buffer.from(m[1], 'base64').toString('utf8'))) return true;
  }
  return false;
}

export function checkKeys(c, a0, ctx) {
  const out = [];
  const args = c.argv.slice(1);
  const key = () => out.push(deny('openproject:key', KEY_MSG));
  const llmKey = () => out.push(deny('llm:key', LLM_MSG));
  const names = llmNames(ctx.env, ctx.home);

  // The key file, its folder, or a glob that reaches it.
  if (!(METADATA.has(a0) || (a0 === 'git' && gitSecretSafe(c.argv)))) {
    const words = GREP_LIKE.has(a0) ? withoutGrepPattern(args) : args;
    if (words.some((w) => candidates(w).some(namesKey))
      || c.assigns.some((a) => namesKey(a.slice(a.indexOf('=') + 1)))
      || c.redirects.some((r) => namesKey(r.target))) key();
    if (words.some((w) => candidates(w).some((x) => namesLlmKey(x, names)))
      || c.assigns.some((a) => namesLlmKey(a.slice(a.indexOf('=') + 1), names))
      || c.redirects.some((r) => namesLlmKey(r.target, names))) llmKey();
  }

  // The script Claude Code runs for a model server's key, run by hand or loaded by other code (reading it is fine).
  if (LLM_SCRIPT.test(a0) || (JS_RUNNERS.has(a0) && /llm-key/.test([...args, ...c.stdin].join('\n')))) llmKey();

  // The script that finds the key: sourced, run, or its function called.
  if ((a0 === 'source' || a0 === '.') && args.some((w) => KEY_SCRIPT.test(w))) key();
  if (a0 === 'openproject-key.sh' || a0 === 'op_find_key') key();

  // Any expansion of the variable, except a set/unset test.
  const testOnly = ['[', '[[', 'test'].includes(a0) && args.every((a) => KEY_VAR.test(a) || /^(-[nz]|\]\]?)$/.test(a));
  const refs = [...c.argv, ...c.assigns, ...c.stdin, ...c.redirects.map((r) => r.target)].some((w) => KEY_VAR.test(w));
  if (refs && !testOnly) key();

  // Basic auth as the apikey user (OpenProject's scheme), literal or encoded.
  if (FETCHERS.has(a0) && args.some((a) => /(^|[\s/=:])apikey(:|$)/i.test(a) || basicIsApikey(a))) key();

  // Interpreter code reading the variable from its environment.
  if (CODE_RUNNERS.has(a0)) {
    const code = [...args, ...c.stdin].join('\n');
    if (/OPENPROJECT_API_KEY/.test(code) && /env/i.test(code)) key();
  }

  if (['declare', 'typeset', 'readonly', 'local'].includes(a0) && args.includes('OPENPROJECT_API_KEY')) key();

  // Keyrings: a stored password printed, for any service; the OpenProject one named in particular.
  const sub = args[0] ?? '';
  const keyring = (a0 === 'security' && /^find-(generic|internet)-password$/.test(sub) && args.slice(1).some(valueFlag))
    || (a0 === 'secret-tool' && ['lookup', 'search'].includes(sub))
    || (a0 === 'keyring' && sub === 'get');
  if (keyring) {
    out.push(deny('keychain:password', PASSWORD_MSG));
    if (args.some((a) => KEY_SERVICE.test(a))) key();
    if (args.some((a) => LLM_SERVICE.test(a))) llmKey();
  }
  if (a0 === 'security' && ['dump-keychain', 'export'].includes(sub)) out.push(deny('keychain:dump', DUMP_MSG));
  return out;
}
