import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDemoHome } from '../src/demo.js';
import { redact } from '../src/redact.js';
import { aliasConfigDirs, configure, frontmatter, getHome, loadTomlTables, scan, shellAliases } from '../src/scan.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-map-test-'));

describe('demo machine', () => {
  let data;
  let profiles;
  const realHome = getHome();
  before(() => {
    configure({ home: buildDemoHome(tmp()), demo: true });
    data = scan();
    profiles = Object.fromEntries(data.profiles.map((p) => [p.id, p]));
  });
  after(() => configure({ home: realHome, demo: false }));

  test('finds every profile, including one only reachable through an alias', () => {
    assert.deepEqual(Object.keys(profiles).sort(), ['client', 'default', 'work']);
    assert.equal(profiles.client.dir, '~/profiles/client-co');
  });

  test('aliases with quoted $HOME paths attach to their profile', () => {
    assert.deepEqual(profiles.work.aliases, ['claude-work']);
    assert.deepEqual(profiles.client.aliases, ['claude-client']);
    assert.deepEqual(profiles.default.aliases, ['claude']);
  });

  test('reads accounts', () => {
    assert.equal(profiles.work.account.email, 'alex@acme.dev');
    assert.equal(profiles.work.account.org, 'Acme Inc');
  });

  test('symlinked skills point into the store', () => {
    const bs = profiles.default.skills.find((s) => s.name === 'brainstorming');
    assert.equal(bs.link, true);
    assert.equal(bs.real, '~/.agents/skills/brainstorming');
  });

  test('plugin state: disabled, contents, enabled-but-missing', () => {
    const plugins = Object.fromEntries(profiles.default.plugins.map((p) => [p.id, p]));
    assert.equal(plugins['pm-toolkit@community'].enabled, false);
    assert.deepEqual(plugins['superpowers@community'].skills.map((s) => s.name).sort(), ['brainstorming', 'debugging', 'tdd', 'writing-plans']);
    const work = Object.fromEntries(profiles.work.plugins.map((p) => [p.id, p]));
    assert.equal(work['linear@claude-plugins-official'].installed, false);
  });

  test('store reads lock sources', () => {
    const store = data.stores.find((s) => s.id === 'agents');
    assert.equal(store.skills.find((s) => s.name === 'copywriting').source, 'coreyhaines31/marketingskills');
  });

  test('projects and services', () => {
    const projects = Object.fromEntries(data.projects.map((p) => [p.path, p]));
    assert.equal(projects['~/code/storefront'].vercel.projectName, 'storefront');
    assert.deepEqual(projects['~/code/api'].neon.endpoints, ['ep-quiet-river-a1b2c3d4']);
    assert.ok(projects['~/code/api'].usedBy.includes('codex'));
    assert.equal(projects['~/code/old-prototype'].exists, false);
  });

  test('neon aliases resolve ~ against the scanned home', () => {
    const work = data.clis.find((c) => c.id === 'neon').accounts.find((a) => a.label === 'neonctl-work');
    assert.deepEqual(work.aliases, ['neon-work']);
    assert.equal(work.pinnedProject, 'demo-proj-123');
  });

  test('demo ignores real binaries and hostname', () => {
    assert.ok(data.clis.every((c) => c.bin === null));
    assert.equal(data.host, 'demo-machine');
  });

  test('redact removes identities and keeps skill names', () => {
    const r = redact(data);
    const blob = JSON.stringify(r).toLowerCase();
    for (const secret of ['alex@acme.dev', 'alex@clientco.io', 'Acme Inc', 'Client Co', 'client-co', 'storefront',
      'claude-work', 'demo-user-1', 'ep-quiet-river', 'team_demo', 'alex-demo']) {
      assert.ok(!blob.includes(secret.toLowerCase()), secret);
    }
    assert.equal(r.redacted, true);
    assert.ok(r.profiles.every((p) => p.skills.every((s) => s.desc === '')));
    assert.ok(blob.includes('release-notes') && blob.includes('brainstorming'));
    assert.equal(data.redacted, false, 'redact must not mutate its input');
  });
});

describe('redact', () => {
  const base = (over) => ({ host: 'box', projects: [], clis: [], agents: [],
    profiles: [{ id: 'default', default: true, dir: '~/.claude', aliases: [], projects: [], account: { email: 'alex@acme.dev' }, ...over }] });

  test('matches whole tokens only', () => {
    const r = redact(base({ skills: [{ name: 'alexandria-notes', desc: '' }] }));
    assert.equal(r.profiles[0].skills[0].name, 'alexandria-notes');
  });

  test('keeps service names that happen to match some email', () => {
    const r = redact(base({ mcpUser: ['posthog'], skills: [{ name: 'x', desc: 'mail support@posthog.com', path: '~/a/posthog@x.io' }] }));
    assert.deepEqual(r.profiles[0].mcpUser, ['posthog']);
    assert.ok(!JSON.stringify(r).includes('posthog@x.io'));
  });
});

describe('parsing', () => {
  test('alias forms: quoted $HOME, unquoted, fish', () => {
    const home = fs.realpathSync(tmp());
    fs.writeFileSync(path.join(home, '.zshrc'), `alias a='CLAUDE_CONFIG_DIR="$HOME/x" claude'\nalias b="CLAUDE_CONFIG_DIR=$HOME/y claude"\n`);
    fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), "alias c 'CLAUDE_CONFIG_DIR=~/z claude'\n");
    const old = getHome();
    let dirs;
    try {
      configure({ home, demo: true });
      dirs = aliasConfigDirs(shellAliases());
    } finally {
      configure({ home: old, demo: false });
    }
    assert.deepEqual(dirs[path.join(home, 'x')], ['a']);
    assert.deepEqual(dirs[path.join(home, 'y')], ['b']);
    assert.deepEqual(dirs[path.join(home, 'z')], ['c']);
  });

  test('toml tables', () => {
    const t = loadTomlTables('model = "x"\n[mcp_servers.context7]\ncommand = "npx"\n[projects."/home/a.b/api"]\ntrust_level = "trusted"\n');
    assert.equal(t.mcp_servers.context7.command, 'npx');
    assert.ok('/home/a.b/api' in t.projects);
  });

  test('frontmatter block description', () => {
    assert.deepEqual(frontmatter('---\nname: x\ndescription: >\n  first line\n  second line\n---\n'), ['x', 'first line second line']);
  });
});

describe('cli', () => {
  test('--demo writes HTML with the data embedded', () => {
    const out = path.join(tmp(), 'map.html');
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-map.js'), '--demo', '--no-open', '-o', out]);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(!html.includes('/*__DATA__*/null'));
    const payload = html.match(/const DATA = (\{.*?\});\n/s)[1];
    assert.equal(JSON.parse(payload.replaceAll('<\\/', '</')).demo, true);
  });

  test('--help and bad flags', () => {
    assert.match(execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-map.js'), '--help'], { encoding: 'utf8' }), /npx @manghat\/agent-map/);
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'agent-map.js'), '--nope'], { stdio: 'pipe' }));
  });
});
