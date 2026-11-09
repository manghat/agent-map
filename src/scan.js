// Scan Claude Code profiles, other agent CLIs, skills, plugins, MCP servers, projects and
// cloud CLI logins on this machine. Read-only: credential files are only checked for
// existence or a user id, never for token values.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';

let HOME = os.homedir();
let DEMO = false; // with a demo home: ignore real binaries / env so the map shows only the fake machine

export function configure({ home, demo } = {}) {
  if (home !== undefined) HOME = home;
  if (demo !== undefined) DEMO = demo;
}
export const getHome = () => HOME;

// ─────────────────────────── fs helpers ───────────────────────────────
const J = (...p) => path.join(...p);

function statOf(p) {
  try { return fs.statSync(p); } catch { return null; }
}
const isDir = (p) => !!statOf(p)?.isDirectory();
const isFile = (p) => !!statOf(p)?.isFile();
const exists = (p) => statOf(p) !== null;
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}
function realpath(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
function listDir(d) {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
}
/** Entries of `dir` whose name matches `re`, as full paths, sorted. */
function globDir(dir, re) {
  return listDir(dir).filter((e) => re.test(e)).map((e) => J(dir, e));
}

export function readText(p, limit = 200_000) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Table structure of a TOML file ([a.b], [a."quoted.key"]) plus simple key = "string" lines. Enough for Codex. */
export function loadTomlTables(text) {
  const root = {};
  let cur = root;
  const key = (k) => {
    k = k.trim();
    return k.length > 1 && k[0] === k.at(-1) && `"'`.includes(k[0]) ? k.slice(1, -1) : k;
  };
  for (let line of text.split('\n')) {
    line = line.trim();
    const t = line.match(/^\[\[?(.+?)\]\]?\s*(?:#.*)?$/);
    if (t) {
      cur = root;
      for (const part of t[1].match(/"[^"]*"|'[^']*'|[^.]+/g) || []) cur = cur[key(part)] ??= {};
      continue;
    }
    const kv = line.match(/^([\w.-]+|"[^"]+")\s*=\s*"([^"]*)"/);
    if (kv) cur[key(kv[1])] = kv[2];
  }
  return root;
}
function loadToml(p) {
  return isFile(p) ? loadTomlTables(readText(p)) : null;
}

function which(name) {
  if (DEMO || !name) return null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = J(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (isFile(p)) return p;
    } catch { /* not here */ }
  }
  return null;
}

export const tilde = (p) => (p == null ? null : p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const keys = (o) => Object.keys(o || {});
const sortedKeys = (o) => keys(o).sort();
const strip = (s) => s.trim().replace(/^['"]+|['"]+$/g, '');

function localIso(d, withSeconds = true) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${s}:${p(d.getSeconds())}` : s;
}

// ─────────────────────────── skills ───────────────────────────────────
export function frontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : '';
  const name = fm.match(/^name:\s*(.+)$/m);
  const desc = fm.match(/^description:\s*(.*)$/m);
  let d = '';
  if (desc) {
    d = desc[1].trim();
    if (['|', '>', '|-', '>-', ''].includes(d)) {
      // folded / literal block: take the following indented lines
      const rest = fm.slice(desc.index + desc[0].length).split('\n');
      d = rest.slice(1, 6).filter((l) => l.startsWith(' ') || l.startsWith('\t')).map((l) => l.trim()).join(' ');
    }
  }
  d = strip(d);
  return [name ? strip(name[1]) : null, d.slice(0, 280)];
}

function skillRecord(dir) {
  const md = J(dir, 'SKILL.md');
  if (!isFile(md)) return null;
  const text = readText(md);
  const [fmName, desc] = frontmatter(text);
  const link = isLink(dir);
  const real = realpath(dir);
  return {
    name: path.basename(dir.replace(/\/+$/, '')),
    fmName,
    desc,
    path: tilde(dir),
    real: link ? tilde(real) : null,
    link,
    hash: createHash('sha1').update(text).digest('hex').slice(0, 10),
    gstack: text.slice(0, 3000).includes('(gstack)') || real.includes('/gstack/'),
  };
}

function scanSkillDir(d) {
  if (!isDir(d)) return [];
  return listDir(d)
    .filter((e) => !e.startsWith('.') && e !== 'synced')
    .map((e) => skillRecord(J(d, e)))
    .filter(Boolean);
}

function scanNamedFiles(d, ext = '.md') {
  if (!isDir(d)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of listDir(dir)) {
      const p = J(dir, e);
      if (isDir(p)) {
        if (!e.startsWith('.') && e !== 'node_modules') walk(p);
      } else if (e.endsWith(ext) && e.toLowerCase() !== 'readme.md') {
        out.push(path.relative(d, p).slice(0, -ext.length).split(path.sep).join(':'));
      }
    }
  };
  walk(d);
  return out.sort();
}

function pluginContents(installPath) {
  const res = { skills: [], commands: [], agents: [], mcp: [], hooks: false };
  if (!installPath || !isDir(installPath)) return res;
  // plugin.json may list skill paths; otherwise Claude Code loads skills/<name>/SKILL.md
  const manifest = loadJson(J(installPath, '.claude-plugin', 'plugin.json')) || {};
  let declared = manifest.skills;
  if (typeof declared === 'string') declared = [declared];
  const roots = Array.isArray(declared) && declared.length
    ? declared.map((x) => path.normalize(J(installPath, x)))
    : [J(installPath, 'skills')];
  for (const root of roots) {
    if (isFile(J(root, 'SKILL.md'))) {
      const r = skillRecord(root);
      if (r) res.skills.push(r);
    } else {
      res.skills.push(...scanSkillDir(root));
    }
  }
  res.commands = scanNamedFiles(J(installPath, 'commands'));
  res.agents = scanNamedFiles(J(installPath, 'agents'));
  for (const mp of [J(installPath, '.mcp.json'), J(installPath, '.claude-plugin', 'plugin.json')]) {
    res.mcp.push(...keys((loadJson(mp) || {}).mcpServers));
  }
  res.hooks = exists(J(installPath, 'hooks', 'hooks.json'));
  return res;
}

// ─────────────────────────── shell aliases ────────────────────────────
const SHELL_FILES = ['.zshrc', '.zprofile', '.zshenv', '.zsh_aliases', '.bashrc', '.bash_profile', '.bash_aliases',
  '.profile', '.aliases', J('.config', 'fish', 'config.fish')];

export function shellAliases() {
  const files = SHELL_FILES.map((f) => J(HOME, f));
  const zdot = process.env.ZDOTDIR;
  if (zdot && !DEMO) files.push(...['.zshrc', '.zprofile', '.zshenv'].map((f) => J(zdot, f)));
  const txt = [...new Set(files)].map((f) => readText(f)).join('\n');
  const aliases = {};
  // bash/zsh: alias name='value'   fish: alias name 'value' / alias name "value"
  for (const m of txt.matchAll(/^\s*alias\s+([\w.:-]+)(?:=|\s+)(['"])(.*?)\2\s*$/gm)) aliases[m[1]] = m[3];
  return aliases;
}

function expand(p) {
  p = strip(p).replaceAll('${HOME}', HOME).replaceAll('$HOME', HOME);
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  return realpath(p);
}

const CONFIG_DIR_RE = /CLAUDE_CONFIG_DIR=(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** {realpath of CLAUDE_CONFIG_DIR: [alias names]} for aliases that launch Claude with a custom config dir. */
export function aliasConfigDirs(aliases) {
  const out = {};
  for (const [a, cmd] of Object.entries(aliases)) {
    const m = cmd.match(CONFIG_DIR_RE);
    if (m) (out[expand(m[1] || m[2] || m[3])] ??= []).push(a);
  }
  return out;
}

const looksLikeClaudeDir = (d) =>
  isDir(d) && ['settings.json', '.claude.json', 'plugins', 'projects', 'history.jsonl', 'skills'].some((x) => exists(J(d, x)));

// ─────────────────────────── Claude profiles ──────────────────────────
function claudeProfiles(aliases) {
  const aliasFor = aliasConfigDirs(aliases);
  // 1. ~/.claude   2. dirs that shell aliases launch   3. ~/.claude-*   4. $CLAUDE_CONFIG_DIR
  const candidates = [J(HOME, '.claude'), ...Object.keys(aliasFor).sort(), ...globDir(HOME, /^\.claude-/)];
  const envDir = DEMO ? null : process.env.CLAUDE_CONFIG_DIR;
  if (envDir) candidates.push(expand(envDir));
  const dirs = [];
  const seen = new Set();
  for (const d of candidates) {
    const r = realpath(d);
    if (!seen.has(r) && looksLikeClaudeDir(r)) {
      seen.add(r);
      dirs.push(d);
    }
  }

  const profiles = [];
  const usedIds = new Set();
  for (const d of dirs) {
    const isDefault = realpath(d) === realpath(J(HOME, '.claude'));
    const names = aliasFor[realpath(d)] || [];
    let pid;
    if (isDefault) pid = 'default';
    else if (names.length) pid = names[0].replace(/^claude[-_]?/, '') || names[0];
    else pid = path.basename(d).replace(/^\.?claude[-_]?/, '') || path.basename(d);
    const base = pid;
    for (let n = 2; usedIds.has(pid); n++) pid = `${base}-${n}`;
    usedIds.add(pid);

    const cj = loadJson(isDefault ? J(HOME, '.claude.json') : J(d, '.claude.json')) || {};
    const settings = loadJson(J(d, 'settings.json')) || {};
    const settingsLocal = loadJson(J(d, 'settings.local.json')) || {};
    const acct = cj.oauthAccount || null;

    const skills = scanSkillDir(J(d, 'skills'));
    let synced = [];
    const buckets = globDir(J(d, 'skills', 'synced'), /./).filter(isDir);
    for (const b of buckets) if (isFile(J(b, 'manifest.json'))) synced.push(...scanSkillDir(b));
    if (!synced.length) for (const b of buckets) synced.push(...scanSkillDir(b));
    // several cached buckets (e.g. an old org) often hold the same skill: keep one per name + content
    const uniq = new Map();
    for (const s of synced) if (!uniq.has(s.name + '|' + s.hash)) uniq.set(s.name + '|' + s.hash, s);
    synced = [...uniq.values()];

    const enabled = { ...(settings.enabledPlugins || {}), ...(settingsLocal.enabledPlugins || {}) };
    const installed = (loadJson(J(d, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
    const plugins = [];
    for (const [pkey, entries] of Object.entries(installed)) {
      for (const e of entries || []) {
        const [name, market = ''] = splitOnce(pkey, '@');
        plugins.push({
          id: pkey, name, marketplace: market,
          scope: e.scope ?? null, projectPath: tilde(e.projectPath ?? null), version: e.version ?? null,
          enabled: e.scope === 'user' ? !!enabled[pkey] : null,
          installPath: tilde(e.installPath ?? null), installed: true,
          ...pluginContents(e.installPath),
        });
      }
    }
    for (const [pkey, on] of Object.entries(enabled)) {
      if (pkey in installed) continue;
      const [name, market = ''] = splitOnce(pkey, '@');
      plugins.push({ id: pkey, name, marketplace: market, scope: 'user', enabled: !!on, installed: false,
        skills: [], commands: [], agents: [], mcp: [], hooks: false });
    }

    const projects = {};
    for (const [p, pv] of Object.entries(cj.projects || {})) {
      projects[p] = { mcp: sortedKeys(pv?.mcpServers), lastCost: pv?.lastCost ?? null };
    }

    profiles.push({
      id: pid,
      dir: tilde(d),
      default: isDefault,
      aliases: names.length ? names : isDefault ? ['claude'] : [],
      account: acct ? { email: acct.emailAddress ?? null, org: acct.organizationName ?? null, billing: acct.billingType ?? null } : null,
      model: settings.model ?? null,
      hooks: sortedKeys(settings.hooks),
      statusLine: !!settings.statusLine,
      claudeMd: exists(J(d, 'CLAUDE.md')),
      memory: isDir(J(d, 'memory')),
      skills,
      synced,
      agents: scanNamedFiles(J(d, 'agents')),
      commands: scanNamedFiles(J(d, 'commands')),
      plugins,
      marketplaces: sortedKeys(loadJson(J(d, 'plugins', 'known_marketplaces.json'))),
      mcpUser: sortedKeys(cj.mcpServers),
      projects,
      stale: globDir(d, /^skills(.*\.pre-|\.bak)/).map((x) => path.basename(x)),
    });
  }
  return profiles;
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

// ─────────────────────────── other agent CLIs ─────────────────────────
function otherAgents() {
  const tools = [];
  const add = (id, label, bin, cfgDir, skillDirs, { mcp = [], projects = [], plugins = [], account = null } = {}) => {
    if (!isDir(cfgDir) && !which(bin)) return;
    tools.push({
      id, label, bin: tilde(which(bin)), dir: tilde(cfgDir),
      skillDirs: skillDirs.filter(isDir).map(tilde),
      skills: skillDirs.flatMap(scanSkillDir),
      mcp: [...mcp].sort(), projects, plugins, account, extra: null,
    });
  };

  const cx = J(HOME, '.codex');
  const cfg = loadToml(J(cx, 'config.toml')) || {};
  const auth = loadJson(J(cx, 'auth.json')) || {};
  add('codex', 'Codex CLI', 'codex', cx, [J(cx, 'skills')], {
    mcp: keys(cfg.mcp_servers), projects: keys(cfg.projects), plugins: keys(cfg.plugins),
    account: { auth: auth.auth_mode || (auth.OPENAI_API_KEY ? 'api-key' : auth.tokens ? 'chatgpt' : null) },
  });

  const gm = J(HOME, '.gemini');
  const ga = loadJson(J(gm, 'google_accounts.json')) || {};
  add('gemini', 'Gemini CLI', 'gemini', gm, [J(gm, 'skills')], {
    mcp: keys((loadJson(J(gm, 'settings.json')) || {}).mcpServers), account: { email: ga.active ?? null },
  });

  const cu = J(HOME, '.cursor');
  add('cursor', 'Cursor', 'cursor', cu, [J(cu, 'skills'), J(cu, 'skills-cursor')], {
    mcp: keys((loadJson(J(cu, 'mcp.json')) || {}).mcpServers),
  });

  const oc = J(HOME, '.config', 'opencode');
  add('opencode', 'OpenCode', 'opencode', oc, [J(oc, 'skills'), J(oc, 'skill')], {
    mcp: keys((loadJson(J(oc, 'opencode.json')) || {}).mcp),
  });

  const cp = J(HOME, '.copilot');
  add('copilot', 'Copilot CLI', 'copilot', cp, [J(cp, 'skills')], {
    mcp: keys((loadJson(J(cp, 'mcp-config.json')) || {}).mcpServers),
  });

  const amp = J(HOME, '.config', 'amp');
  add('amp', 'Amp', 'amp', amp, [J(amp, 'skills')]);
  return tools;
}

function skillStores() {
  const stores = [];
  const ag = J(HOME, '.agents', 'skills');
  if (isDir(ag)) {
    const lock = (loadJson(J(HOME, '.agents', '.skill-lock.json')) || {}).skills || {};
    const skills = scanSkillDir(ag).map((s) => ({ ...s, source: lock[s.name]?.source ?? null, updatedAt: lock[s.name]?.updatedAt ?? null }));
    stores.push({ id: 'agents', label: '~/.agents/skills', note: 'shared store (npx skills). Agents consume it via symlinks.',
      path: tilde(ag), skills });
  }
  const gst = J(HOME, '.claude', 'skills', 'gstack');
  if (isDir(gst)) {
    stores.push({ id: 'gstack', label: 'gstack', note: 'gstack suite, installs real folders into ~/.claude/skills', path: tilde(gst), skills: [] });
  }
  return stores;
}

// ─────────────────────────── projects ─────────────────────────────────
const NEON_EP = /(ep-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+)(?:-pooler)?\.[a-z0-9-]+\.aws\.neon\.tech|(ep-[a-z0-9-]+?)(?:-pooler)?\.[\w.-]*neon\.tech/g;

function scanProject(p) {
  const out = { path: tilde(p), exists: isDir(p) };
  if (!out.exists) return out;
  const isHome = realpath(p) === realpath(HOME);
  out.isHome = isHome;
  const cd = J(p, '.claude');
  if (!isHome) { // ~/.claude is the default profile, not a project dir
    out.skills = scanSkillDir(J(cd, 'skills'));
    out.commands = scanNamedFiles(J(cd, 'commands'));
    out.agents = scanNamedFiles(J(cd, 'agents'));
    const ps = loadJson(J(cd, 'settings.json')) || {};
    const pl = loadJson(J(cd, 'settings.local.json')) || {};
    out.enabledPlugins = Object.entries({ ...(ps.enabledPlugins || {}), ...(pl.enabledPlugins || {}) }).filter(([, v]) => v).map(([k]) => k).sort();
    out.hooks = [...new Set([...keys(ps.hooks), ...keys(pl.hooks)])].sort();
    out.agentsSkills = scanSkillDir(J(p, '.agents', 'skills'));
  } else {
    Object.assign(out, { skills: [], commands: [], agents: [], enabledPlugins: [], hooks: [], agentsSkills: [] });
  }
  out.mcpJson = sortedKeys((loadJson(J(p, '.mcp.json')) || {}).mcpServers);
  out.claudeMd = exists(J(p, 'CLAUDE.md')) || exists(J(cd, 'CLAUDE.md'));
  out.agentsMd = exists(J(p, 'AGENTS.md'));
  out.git = exists(J(p, '.git'));

  const v = loadJson(J(p, '.vercel', 'project.json'));
  out.vercel = v ? { projectName: v.projectName ?? null, projectId: v.projectId ?? null, orgId: v.orgId ?? null } : null;
  const rv = loadJson(J(p, '.vercel', 'repo.json'));
  if (rv && !out.vercel) {
    out.vercel = { projectName: (rv.projects || []).map((x) => x.name || '?').join(', '), orgId: rv.orgId ?? null, repo: true };
  }

  const neon = loadJson(J(p, '.neon'));
  const eps = new Set();
  if (!isHome) {
    const envFiles = [...globDir(p, /^\.env/), ...listDir(p).filter((e) => isDir(J(p, e))).flatMap((e) => globDir(J(p, e), /^\.env/))];
    for (const f of envFiles) {
      const st = statOf(f);
      if (st?.isFile() && st.size < 200_000) for (const m of readText(f).matchAll(NEON_EP)) eps.add(m[1] || m[2]);
    }
  }
  out.neon = neon || eps.size ? { context: neon, endpoints: [...eps].sort() } : null;
  out.supabase = exists(J(p, 'supabase', 'config.toml'));
  out.convex = exists(J(p, 'convex.json')) || isDir(J(p, 'convex'));
  return out;
}

// ─────────────────────────── cloud / infra CLIs ──────────────────────
function run(cmd, args, timeout = 12_000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}` || `error: ${e.message}`;
  }
}

function neonAliasDir(cmd) {
  const m = cmd.match(/--config-dir[ =](\S+)/);
  return m ? expand(m[1]) : realpath(J(HOME, '.config', 'neonctl'));
}

function cloudClis(aliases, live) {
  const clis = [];

  // Neon
  const neonBin = which('neonctl');
  if (neonBin || isDir(J(HOME, '.config', 'neonctl'))) {
    const accounts = [];
    const cfgDirs = new Map([[J(HOME, '.config', 'neonctl'), 'default']]);
    for (const [a, cmd] of Object.entries(aliases)) {
      if (cmd.startsWith('neonctl') || cmd.startsWith('neon ') || cmd.includes(' neonctl')) {
        const m = cmd.match(/--config-dir[ =](\S+)/);
        const d = m ? expand(m[1]) : J(HOME, '.config', 'neonctl');
        if (!cfgDirs.has(d)) cfgDirs.set(d, a);
      }
    }
    for (const d of globDir(J(HOME, '.config'), /^neonctl/)) if (!cfgDirs.has(d)) cfgDirs.set(d, null);
    for (const d of cfgDirs.keys()) {
      const c = loadJson(J(d, 'credentials.json'));
      if (c === null) continue;
      const al = Object.entries(aliases).filter(([, cmd]) => cmd.includes('neonctl') && neonAliasDir(cmd) === realpath(d)).map(([a]) => a);
      const proj = al.map((a) => aliases[a].match(/--project-id[ =](\S+)/)).filter(Boolean).map((m) => m[1]);
      const acc = {
        label: path.basename(d), configDir: tilde(d), userId: c.user_id ?? null, aliases: al, pinnedProject: proj[0] ?? null,
        expires: typeof c.expires_at === 'number' ? localIso(new Date(c.expires_at), false) : null,
      };
      if (live && neonBin) {
        const outp = run(neonBin, ['me', '--config-dir', d, '--output', 'json']);
        try {
          const j = JSON.parse(outp.slice(outp.indexOf('{')));
          acc.email = j.email ?? null;
          acc.login = j.login ?? null;
        } catch {
          acc.liveError = outp.trim().slice(0, 160);
        }
      }
      accounts.push(acc);
    }
    const prof = loadJson(J(HOME, '.config', 'neon', 'profiles.json')) || {};
    for (const [name, pv] of Object.entries(prof.profiles || {})) {
      if (name === 'DEFAULT') continue;
      const cred = loadJson(J(HOME, '.config', 'neon', pv.credentials || '')) || {};
      accounts.push({ label: `neon profile: ${name}`, configDir: '~/.config/neon', userId: pv.userId || cred.user_id || null,
        email: pv.label ?? null, aliases: [] });
    }
    clis.push({ id: 'neon', label: 'Neon (neonctl)', bin: tilde(neonBin), accounts,
      note: 'Separate config dirs = separate accounts. Aliases pin the account (and sometimes the project).' });
  }

  // Vercel
  const vbin = which('vercel');
  let vdir = J(HOME, 'Library', 'Application Support', 'com.vercel.cli');
  if (!isDir(vdir)) vdir = J(HOME, '.local', 'share', 'com.vercel.cli');
  if (vbin || isDir(vdir)) {
    const vc = loadJson(J(vdir, 'config.json')) || {};
    const acc = { label: 'global', configDir: tilde(vdir), currentTeam: vc.currentTeam ?? null, loggedIn: exists(J(vdir, 'auth.json')) };
    if (live && vbin) {
      const outp = run(vbin, ['whoami'], 20_000).trim();
      acc.user = outp ? outp.split('\n').at(-1) : null;
    }
    clis.push({ id: 'vercel', label: 'Vercel CLI', bin: tilde(vbin), accounts: [acc],
      note: 'One global login. Per-project link lives in <project>/.vercel/project.json (see Projects tab).' });
  }

  // GitHub
  const gbin = which('gh');
  const hosts = readText(J(HOME, '.config', 'gh', 'hosts.yml'));
  if (gbin || hosts) {
    const accs = [];
    let cur = null;
    for (const line of hosts.split('\n')) {
      if (/^\S.*:$/.test(line)) cur = line.slice(0, -1);
      const m = line.match(/^\s{4}user:\s*(\S+)/);
      if (m && cur) accs.push({ label: cur, user: m[1], configDir: '~/.config/gh' });
      const m2 = line.match(/^\s{8}(\S+):\s*$/); // multi-account `users:` block
      if (m2 && cur && m2[1] !== 'oauth_token' && !accs.some((a) => a.user === m2[1])) {
        accs.push({ label: cur, user: m2[1], configDir: '~/.config/gh', inactive: true });
      }
    }
    const seen = new Map();
    for (const a of accs) {
      const k = a.label + '|' + a.user;
      if (!seen.has(k) || !a.inactive) seen.set(k, a);
    }
    const list = [...seen.values()];
    if (live && gbin) for (const a of list) a.status = run(gbin, ['auth', 'status', '-h', a.label]).trim().slice(0, 300);
    clis.push({ id: 'gh', label: 'GitHub CLI', bin: tilde(gbin), accounts: list });
  }

  // gcloud
  const gcd = J(HOME, '.config', 'gcloud');
  if (isDir(gcd)) {
    const active = readText(J(gcd, 'active_config')).trim() || 'default';
    const accs = globDir(J(gcd, 'configurations'), /^config_/).map((f) => {
      const t = readText(f);
      const name = path.basename(f).slice(7);
      return { label: name, email: t.match(/^account\s*=\s*(\S+)/m)?.[1] ?? null, project: t.match(/^project\s*=\s*(\S+)/m)?.[1] ?? null,
        active: name === active };
    });
    clis.push({ id: 'gcloud', label: 'Google Cloud (gcloud)', bin: tilde(which('gcloud')), accounts: accs });
  }

  // AWS
  const awsc = readText(J(HOME, '.aws', 'config'));
  if (awsc) {
    clis.push({ id: 'aws', label: 'AWS CLI', bin: tilde(which('aws')),
      accounts: [...awsc.matchAll(/^\[(?:profile )?([^\]]+)\]/gm)].map((m) => ({ label: m[1] })) });
  }
  // Supabase
  if (which('supabase') || isDir(J(HOME, '.supabase'))) {
    clis.push({ id: 'supabase', label: 'Supabase CLI', bin: tilde(which('supabase')),
      accounts: [{ label: 'global', configDir: '~/.supabase', loggedIn: exists(J(HOME, '.supabase', 'access-token')) }] });
  }
  // Modal
  const mt = readText(J(HOME, '.modal.toml'));
  if (mt) {
    clis.push({ id: 'modal', label: 'Modal', bin: tilde(which('modal')),
      accounts: [...mt.matchAll(/^\[([^\]]+)\]/gm)].map((m) => ({ label: m[1], configDir: '~/.modal.toml' })) });
  }
  // Turso
  if (which('turso') || isDir(J(HOME, '.turso'))) {
    clis.push({ id: 'turso', label: 'Turso', bin: tilde(which('turso')), accounts: [{ label: 'global', configDir: '~/.turso' }] });
  }
  // Convex
  if (isDir(J(HOME, '.convex'))) {
    clis.push({ id: 'convex', label: 'Convex', bin: null,
      accounts: [{ label: 'global', configDir: '~/.convex', loggedIn: exists(J(HOME, '.convex', 'config.json')) }] });
  }
  // Cloudflare wrangler
  if (which('wrangler')) clis.push({ id: 'wrangler', label: 'Cloudflare wrangler', bin: tilde(which('wrangler')), accounts: [] });
  return clis;
}

// ─────────────────────────── scan ─────────────────────────────────────
export function scan({ live = false } = {}) {
  const aliases = shellAliases();
  const profiles = claudeProfiles(aliases);
  const agents = otherAgents();
  const stores = skillStores();
  const clis = cloudClis(aliases, live);

  // union of every project any tool has seen
  const projUsers = new Map();
  const use = (p) => (projUsers.has(p) ? projUsers.get(p) : projUsers.set(p, new Set()).get(p));
  for (const pr of profiles) {
    for (const p of Object.keys(pr.projects)) use(p).add(pr.id);
    for (const pl of pr.plugins) if (pl.projectPath) use(pl.projectPath.replace(/^~/, HOME));
  }
  for (const ag of agents) for (const p of ag.projects) use(p).add(ag.id);

  const projects = [];
  for (const p of [...projUsers.keys()].sort()) {
    const inHome = p === HOME || p.startsWith(HOME + path.sep);
    const tmp = /^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(p);
    if ((!inHome && tmp) || p.includes('/.claude/worktrees/')) continue;
    const proj = scanProject(p);
    proj.usedBy = [...projUsers.get(p)].sort();
    proj.mcpLocal = Object.fromEntries(profiles.filter((pr) => pr.projects[p]?.mcp.length).map((pr) => [pr.id, pr.projects[p].mcp]));
    proj.projectPlugins = profiles.flatMap((pr) => pr.plugins.filter((pl) => pl.projectPath === tilde(p))
      .map((pl) => ({ profile: pr.id, id: pl.id, skills: pl.skills.map((s) => s.name) })));
    projects.push(proj);
  }
  const known = new Set(projects.map((x) => x.path));
  for (const pr of profiles) pr.projects = Object.keys(pr.projects).map(tilde).sort(); // projects have their own table
  for (const ag of agents) ag.projects = ag.projects.map(tilde).filter((p) => known.has(p)).sort();

  return {
    version: VERSION,
    generatedAt: localIso(new Date()),
    host: DEMO ? 'demo-machine' : os.hostname(),
    live,
    demo: DEMO,
    redacted: false,
    profiles,
    agents,
    stores,
    projects,
    clis,
    aliases: Object.fromEntries(Object.entries(aliases).filter(([, v]) => /claude|neon|vercel|gh |codex|gemini|supabase|CONFIG_DIR/.test(v))),
  };
}
