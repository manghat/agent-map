// Best-effort redaction so a map can be screenshotted.
//
// Emails -> user1@example.com, orgs -> Org N, account ids -> "redacted", project paths ->
// ~/projects/project-01, profiles -> profile-N (and their aliases/folders), hostname -> my-computer,
// home folder name -> you, skill descriptions dropped. Skill, plugin and MCP server names are kept.
import path from 'node:path';
import { getHome } from './scan.js';

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// "name_domain.tld" folder names that account switchers use (optionally prefixed "2-")
const FOLDER_EMAIL_RE = /(?<![\w.-])(?:\d+-)?([a-z][\w.+-]*)_([\w-]+\.[a-z]{2,})(?![\w-])/gi;
// values that identify an account, team or resource: replaced wholesale
const ID_KEYS = new Set(['userId', 'orgId', 'projectId', 'pinnedProject', 'currentTeam', 'user', 'login', 'status',
  'liveError', 'project', 'projectName', 'endpoints']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(input) {
  const data = structuredClone(input);
  const subs = new Map(); // lowercased original -> replacement
  const put = (orig, repl) => {
    if (orig && orig.length >= 3 && !subs.has(orig.toLowerCase())) subs.set(orig.toLowerCase(), repl);
  };
  const profiles = data.profiles || [];

  // 1. project paths
  const paths = [...new Set((data.projects || []).map((p) => p.path))]
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  paths.forEach((p, i) => { if (p !== '~' && p !== '~/') put(p, `~/projects/project-${String(i + 1).padStart(2, '0')}`); });
  for (const pr of profiles) {
    (pr.projects || []).forEach((p, i) => put(p, `~/projects/${pr.id}-${String(i + 1).padStart(2, '0')}`));
  }

  // 2. profiles: ids, aliases and folders are often named after accounts or clients ("claude-acme")
  profiles.forEach((pr, i) => {
    if (pr.default) return;
    put(pr.dir, `~/.claude-profile-${i + 1}`);
    for (const a of pr.aliases || []) put(a, `claude-profile-${i + 1}`);
    put(pr.id, `profile-${i + 1}`);
  });

  // 3. emails (+ folder-name form). Bare local parts ("alex") only for accounts signed in here, so a
  //    stray support@posthog.com in some skill doesn't rename the posthog MCP server.
  const blob = JSON.stringify(data);
  const found = new Set(blob.match(EMAIL_RE) || []);
  for (const m of blob.matchAll(FOLDER_EMAIL_RE)) found.add(`${m[1]}@${m[2]}`);
  const accounts = new Set([
    ...profiles.map((p) => p.account?.email),
    ...(data.agents || []).map((a) => a.account?.email),
    ...(data.clis || []).flatMap((c) => c.accounts.map((a) => a.email)),
  ].filter(Boolean).map((e) => e.toLowerCase()));
  [...found].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).forEach((e, i) => {
    const [local, domain] = e.split('@');
    put(e, `user${i + 1}@example.com`);
    put(`${local}_${domain}`, `user${i + 1}_example.com`);
    if (accounts.has(e.toLowerCase()) && local.length >= 5) put(local, `user${i + 1}`);
  });

  // 4. hostname, home folder name
  put(data.host, 'my-computer');
  const user = path.basename(getHome());
  if (user.length >= 4) put(user, 'you');

  // 5. org names
  profiles.forEach((pr, i) => { if (pr.account?.org) put(pr.account.org, `Org ${i + 1}`); });

  // 6. cloud CLI account labels that aren't generic ("neon profile: acme")
  for (const c of data.clis || []) {
    c.accounts.forEach((a, j) => {
      if (!['global', 'default', 'github.com', 'neonctl', 'config_default'].includes(a.label || '')) a.label = `account-${j + 1}`;
    });
  }

  // whole tokens only, so redacting "alex" doesn't mangle a skill called "alexandria-notes"
  const keys = [...subs.keys()].sort((a, b) => b.length - a.length);
  const pat = keys.length ? new RegExp(`(?<![A-Za-z0-9])(?:${keys.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  const subAll = (s) => (pat ? s.replace(pat, (m) => subs.get(m.toLowerCase())) : s);

  const walk = (x, key) => {
    if (Array.isArray(x)) return x.map((v) => walk(v, key));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [subAll(k), walk(v, k)]));
    if (typeof x === 'string') {
      if (key === 'desc') return ''; // free text you wrote: may name clients, domains, people
      return ID_KEYS.has(key) && x ? 'redacted' : subAll(x);
    }
    return x;
  };
  const out = walk(data);
  out.redacted = true;
  return out;
}
