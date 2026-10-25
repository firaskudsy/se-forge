// Secrets: no command may read or touch a secret file, dump the environment or print a secret variable.
import { deny } from '../decision.mjs';
import { isSecretPath, resolvePath, wordNamesSecret } from '../paths.mjs';
import { gitSecretSafe } from './git.mjs';

// Commands that only look at names or metadata, never at content.
export const METADATA = new Set(['ls', 'stat', 'test', '[', '[[', 'file', 'du', 'realpath', 'readlink', 'dirname', 'basename', 'chmod', 'chown']);
export const GREP_LIKE = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const GREP_VALUE = new Set(['A', 'B', 'C', 'm', 'e', 'f', 'd', 'D', 'g', 't', 'T', 'j', 'M']);
// Interpreters and text processors whose program text can open files by name.
export const CODE_RUNNERS = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'osascript', 'pwsh',
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'jq']);

const CODE_SECRET = /(?:^|[^\w.-])((?:[\w./~$-]*\/)?(?:\.env(?:\.[\w-]+)?|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore)|id_(?:rsa|ed25519|ecdsa|dsa)|credentials\.json|\.netrc|\.pgpass))(?![\w-])/g;
const CODE_HOME_SECRET = /\.(ssh|aws|azure|kube|gnupg)\/|\.docker\/config\.json|\.config\/(gh|glab-cli|gcloud)\b/;

export const isSecretVarName = (name) => !['PWD', 'OLDPWD'].includes(name)
  && /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(name);
const SECRET_VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const refsSecretVar = (s) => [...String(s).matchAll(SECRET_VAR_REF)].some((m) => isSecretVarName(m[1]));

// The same word may hide a path after "=" (--file=.env) or "@" (curl -d @.env).
export function candidates(word) {
  const out = [word];
  const eq = word.indexOf('=');
  if (eq > 0) out.push(word.slice(eq + 1));
  const at = word.lastIndexOf('@');
  if (at >= 0 && !word.includes('://')) out.push(word.slice(at + 1));
  return out.filter(Boolean);
}

export function withoutGrepPattern(args) {
  let patternGiven = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      if (/^--(regexp|file)(=|$)/.test(a)) patternGiven = true;
      if (/^--(regexp|file|glob|type|type-not|max-count|context|before-context|after-context)$/.test(a)) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const last = a[a.length - 1];
      if (a.includes('e') || a.includes('f')) patternGiven = true;
      if (GREP_VALUE.has(last)) i++;
      continue;
    }
    rest.push(a);
  }
  return patternGiven ? rest : rest.slice(1);
}

function codeNamesSecret(text, ctx) {
  if (CODE_HOME_SECRET.test(text)) return true;
  for (const m of String(text).matchAll(CODE_SECRET)) {
    if (isSecretPath(resolvePath(m[1].replace(/^\$\{?HOME\}?/, '~'), ctx.cwd, ctx.home), ctx.config, ctx.home)) return true;
  }
  return false;
}

// A process's environment as a file (Linux, WSL, containers).
export const PROC_ENVIRON = /\/proc\/[^/\s]+\/environ\b/;

// ps shows environments with BSD-style `e` (ps eww, ps auxe) or macOS `-E`; `ps -e` only lists all processes.
const PS_VALUE = new Set(['o', 'O', 'p', 'q', 'u', 'U', 'g', 'G', 't', 'C', 'k', 's', 'N', 'M']);
function psShowsEnv(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) continue;
    if (a.startsWith('-')) {
      if (a.includes('E')) return true;
      if (PS_VALUE.has(a[a.length - 1])) i++;
      continue;
    }
    if (/^[a-zA-Z]+$/.test(a) && a.includes('e')) return true;
  }
  return false;
}

// Interpreter code that prints the whole environment, not one variable by name.
const ENV_DUMPS = [
  [/^python3?$/, /\bos\.environ\b(?!\s*(\[|\.get\b|\.setdefault\b))/],
  [/^(node|bun|deno)$/, /\bprocess\.env\b(?!\s*[.[])|\bDeno\.env\.toObject\b/],
  [/^perl$/, /%ENV\b/],
  [/^ruby$/, /\bENV\b(?!\s*(\[|\.fetch\b|\.key\?))/],
  [/^php$/, /\bgetenv\(\s*\)|\$_(ENV|SERVER)\b(?!\s*\[)/],
  [/awk$/, /\bENVIRON\b(?!\s*\[)/],
  [/^jq$/, /(^|[^\w.$-])env\b(?![\w.-])|\$ENV\b(?!\s*\.)/],
  [/^pwsh$/, /(^|[\s(])env:(?!\w)|GetEnvironmentVariables\(/i],
];
const codeDumpsEnv = (a0, code) => ENV_DUMPS.some(([who, rx]) => who.test(a0) && rx.test(code));

const READ_MSG = 'Commands may not read, copy or stage secret files. Use .env.example for variable names; scripts load credentials by variable name.';

export function checkSecrets(c, a0, ctx) {
  const out = [];
  const args = c.argv.slice(1);

  if (CODE_RUNNERS.has(a0) && args.some((a) => codeNamesSecret(a, ctx))) out.push(deny('secrets:read', READ_MSG));

  if (!(METADATA.has(a0) || (a0 === 'git' && gitSecretSafe(c.argv)))) {
    let words = GREP_LIKE.has(a0) ? withoutGrepPattern(args) : args;
    if (a0 === 'find') {
      const acts = args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fls)$/.test(a));
      words = acts ? args.filter((_, i) => /^-(i?name|i?path|wholename|regex)$/.test(args[i - 1] ?? '')) : [];
    }
    if (words.some((w) => candidates(w).some((p) => wordNamesSecret(p, ctx)))) out.push(deny('secrets:read', READ_MSG));
    else if (c.assigns.some((a) => wordNamesSecret(a.slice(a.indexOf('=') + 1), ctx))) out.push(deny('secrets:read', READ_MSG));
  }
  for (const r of c.redirects) {
    if ((r.op === '<' || r.op === '<>') && wordNamesSecret(r.target, ctx)) out.push(deny('secrets:read', READ_MSG));
  }

  const dump = deny('secrets:env-dump', 'Dumping the environment can print secrets. Ask for one variable by name instead.');
  if (c.envDump) out.push(dump);
  if (a0 === 'printenv' && (!args.length || args.some(isSecretVarName))) out.push(args.length ? deny('secrets:print', 'Never print a secret variable.') : dump);
  if (a0 === 'set' && !args.length) out.push(dump);
  if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(a0) && args.every((a) => /^-[px]+$/.test(a))) out.push(dump);
  if (['declare', 'typeset', 'readonly', 'local'].includes(a0) && args.some((a) => /^-\w*p/.test(a)) && args.some(isSecretVarName)) {
    out.push(deny('secrets:print', 'Never print a secret variable.'));
  }
  if (!METADATA.has(a0) && [...args, ...c.assigns, ...c.redirects.map((r) => r.target)].some((w) => PROC_ENVIRON.test(w))) out.push(dump);
  if (a0 === 'ps' && psShowsEnv(args)) out.push(dump);
  if (CODE_RUNNERS.has(a0) && codeDumpsEnv(a0, [...args, ...c.stdin].join('\n'))) out.push(dump);

  if (['echo', 'printf', 'print', 'tee', 'logger', 'cat'].includes(a0) && (args.some(refsSecretVar) || c.stdin.some(refsSecretVar))) {
    out.push(deny('secrets:print', 'Never print a token, password or key, not even to check it is set. Test with `[ -n "$NAME" ]` instead.'));
  }
  return out;
}

const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const RUNNERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'pwsh']);

// curl … | sh, sh <(curl …), sh -c "$(curl …)"
export function checkDownloadAndRun(cmds, i, a0) {
  const c = cmds[i];
  const msg = deny('net:pipe-to-shell', 'Running a downloaded script directly is not allowed. Download it, review it, then run it.');
  if (FETCHERS.has(a0) && c.pipeTo) {
    const next = cmds.slice(i + 1).find((x) => x.pipeFrom && x.nested === c.nested);
    if (next && RUNNERS.has(String(next.argv[0] ?? '').split('/').pop())) return [msg];
  }
  if (RUNNERS.has(a0) && c.argv.slice(1).some((w) => /(<\(|\$\(|`)\s*(curl|wget)\b/.test(w))) return [msg];
  return [];
}
