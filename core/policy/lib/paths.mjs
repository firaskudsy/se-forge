// Path classification shared by the file-tool rules and the Bash rules.
import path from 'node:path';

const globCache = new Map();

// gitignore-like globs on repo-relative POSIX paths: "**/" any depth, "*" within a segment,
// "?" one character, "{a,b}" alternatives. A pattern without "/" matches any single path segment.
export function globToRegex(pattern) {
  if (globCache.has(pattern)) return globCache.get(pattern);
  let p = pattern.replace(/^\.\//, '');
  const anchored = p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && p.indexOf('}', i) > i) {
      const end = p.indexOf('}', i);
      re += `(?:${p.slice(i + 1, end).split(',').map((alt) => alt.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = anchored ? new RegExp(`^${re}(?:/.*)?$`) : new RegExp(`(?:^|/)${re}(?:/.*)?$`);
  globCache.set(pattern, rx);
  return rx;
}

export const matchAny = (patterns, rel) => rel !== null && patterns.some((g) => globToRegex(g).test(rel));

// Absolute path for a tool argument; "~" is the user's home.
export function resolvePath(p, cwd, home) {
  if (p === '~' || p.startsWith('~/')) return path.join(home, p.slice(1));
  if (p.startsWith('$HOME/') || p.startsWith('${HOME}/')) return path.join(home, p.replace(/^\$\{?HOME\}?\//, ''));
  return path.resolve(cwd, p);
}

// Repo-relative POSIX path, or null when outside the repo.
export function relTo(abs, root) {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.kdbx']);
const SECRET_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.netrc', '.pgpass', 'credentials.json',
  'secrets.json', 'secrets.yaml', 'secrets.yml', '.dev.vars', 'terraform.tfstate', 'terraform.tfstate.backup']);
const HOME_SECRET_DIRS = ['.ssh', '.aws', '.azure', '.config/gh', '.config/glab-cli', '.config/gcloud', '.kube', '.docker/config.json', '.npmrc', '.netrc', '.pgpass', '.git-credentials'];

// The OpenProject key file, ${XDG_CONFIG_HOME:-$HOME/.config}/se-forge/openproject-key (backslashes for Windows).
export const isOpenProjectKeyPath = (p) => /(^|\/)se-forge\/+openproject-key$/.test(String(p).replace(/\\/g, '/'));
// Its folder: .config/se-forge or $XDG_CONFIG_HOME/se-forge (not the kit's own checkout, also named se-forge).
export const isOpenProjectKeyDir = (p) => /(^|\/)(\.config|\$\{?XDG_CONFIG_HOME[^/]*)\/+se-forge\/*$/.test(String(p).replace(/\\/g, '/'));

// Secret files: .env and .env.* (except the configured placeholders), *.env, keys and certificates,
// cloud/CLI credential folders in $HOME, service-account JSON, Terraform state.
export function isSecretPath(p, config, home) {
  const norm = p.split(path.sep).join('/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (config.secrets.allow.includes(base)) return false;
  if (base === '.env' || base.startsWith('.env.') || (base.endsWith('.env') && base.length > 4)) return true;
  if (isOpenProjectKeyPath(norm)) return true;
  if (SECRET_NAMES.has(base) || SECRET_EXT.has(path.extname(base).toLowerCase())) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(?!\.pub$)/.test(base)) return true;
  if (/(service[-_]?account|adminsdk).*\.json$/i.test(base)) return true;
  if (home) {
    const h = home.split(path.sep).join('/').replace(/\/$/, '');
    if (HOME_SECRET_DIRS.some((d) => norm === `${h}/${d}` || norm.startsWith(`${h}/${d}/`))) return true;
  }
  return config.secrets.extra.some((g) => globToRegex(g).test(norm) || globToRegex(g).test(base));
}

// A word that names a secret file, including unexpanded globs such as ".env*" or "*.pem".
export function wordNamesSecret(word, ctx) {
  if (!word || word.startsWith('-')) return false;
  if (/[*?[]/.test(word)) {
    const base = word.slice(word.lastIndexOf('/') + 1);
    return /^\.env/.test(base) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(base);
  }
  return isSecretPath(resolvePath(word, ctx.cwd, ctx.home), ctx.config, ctx.home);
}

const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'packages.lock.json', '.terraform.lock.hcl', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']);
export const isLockFile = (p) => LOCK_FILES.has(path.basename(p));

export const isTfState = (p) => /\.tfstate(\.backup)?$/.test(p) || /(^|[/\\])\.terraform([/\\]|$)/.test(p);

const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|Directory\.Packages\.props|packages\.config|[^/]+\.csproj|requirements[^/]*\.txt)$/;
export const isManifest = (p) => MANIFESTS.test(p.split(path.sep).join('/'));
