#!/usr/bin/env node
// A stand-in glab (and, copied as gh, gh) for the issue history (decision 122): `glab api` answers from $FAKE_ISSUES (a JSON file with
// { issues: [...], labels: { iid: [...] }, states: { iid: [...] } }); every call is logged to $FAKE_LOG.
// $FAKE_FAIL makes every call fail; $FAKE_429 (issue numbers, comma-separated) makes those issues' histories hit the rate limit.
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, `${a.join(' ')}\n`);
if (process.env.FAKE_FAIL) { process.stderr.write('401 Unauthorized\n'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(process.env.FAKE_ISSUES, 'utf8'));
const url = new URL(`https://x/${a[1]}`);
const limited = /\/issues\/(\d+)\//.exec(url.pathname)?.[1];
if (limited && (process.env.FAKE_429 || '').split(',').includes(limited)) { process.stderr.write('glab: HTTP 429\n'); process.exit(1); }
const page = Number(url.searchParams.get('page') || 1);
const one = (list) => (page === 1 ? list : []);
let m;
if (a[0] !== 'api') process.exit(2);
else if (/\/gh$/.test(process.argv[1])) {
  if (/\/issues$/.test(url.pathname)) process.stdout.write(JSON.stringify(one(data.issues)));
  else if ((m = /\/issues\/(\d+)\/events$/.exec(url.pathname))) process.stdout.write(JSON.stringify(one(data.events[m[1]] || [])));
  else process.exit(3);
}
else if (/\/issues$/.test(url.pathname)) process.stdout.write(JSON.stringify(one(data.issues)));
else if ((m = /\/issues\/(\d+)\/resource_label_events$/.exec(url.pathname))) process.stdout.write(JSON.stringify(one(data.labels[m[1]] || [])));
else if ((m = /\/issues\/(\d+)\/resource_state_events$/.exec(url.pathname))) process.stdout.write(JSON.stringify(one(data.states[m[1]] || [])));
else process.exit(3);
