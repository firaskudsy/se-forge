// Findings from the rules and how they combine. deny beats ask beats allow.

export const deny = (rule, reason) => ({ decision: 'deny', rule, reason });
export const ask = (rule, reason, extra = {}) => ({ decision: 'ask', rule, reason, ...extra });

export function combine(findings) {
  const list = findings.filter(Boolean);
  const denies = list.filter((f) => f.decision === 'deny');
  if (denies.length) return { decision: 'deny', findings: denies };
  const asks = list.filter((f) => f.decision === 'ask');
  if (asks.length) return { decision: 'ask', findings: asks };
  return { decision: 'allow', findings: [] };
}

export function explain(result) {
  const seen = new Set();
  return result.findings
    .filter((f) => !seen.has(f.reason) && seen.add(f.reason))
    .map((f) => `[${f.rule}] ${f.reason}`)
    .join('\n');
}

// Asks only count as a human decision when a person can be prompted. Auto mode is one (decision 141): a hook's ask
// still prompts there, and its classifier can deny the call but never approve it silently. In bypassPermissions and
// dontAsk nobody is asked, so gated asks become denials there.
export const HUMAN_MODES = new Set(['default', 'acceptEdits', 'plan', 'manual', 'auto']);
