// Build a made-up home folder with a realistic (and realistically messy) agent setup.
// Used by `agent-map --demo` and by the tests. Every account, org and project is invented,
// and no file contains a token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function w(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 1));
}
const skill = (folder, name, desc, body = '') =>
  w(path.join(folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n${body}\n`);
function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
}

const STORE = {
  brainstorming: 'Turn a fuzzy idea into a design before writing code.',
  'frontend-design': 'Build distinctive, production-grade web UI.',
  'find-skills': 'Search the skills directory for a skill that fits the task.',
  'react-best-practices': 'React and Next.js performance rules.',
  'postgres-tuning': 'Read EXPLAIN plans and fix slow queries.',
  copywriting: 'Write landing-page and product copy.',
  'seo-audit': 'Audit a site for technical SEO problems.',
};
const STORE_SOURCES = {
  brainstorming: 'obra/superpowers', 'frontend-design': 'anthropics/skills', 'find-skills': 'vercel-labs/skills',
  'react-best-practices': 'vercel-labs/agent-skills', 'postgres-tuning': 'neondatabase/agent-skills',
  copywriting: 'coreyhaines31/marketingskills', 'seo-audit': 'coreyhaines31/marketingskills',
};
// [marketplace, plugin, skills]
const PLUGINS = [
  ['claude-plugins-official', 'vercel', { deploy: 'Deploy to Vercel.', 'ai-sdk': 'Use the Vercel AI SDK.', 'env-vars': 'Manage Vercel environment variables.' }],
  ['claude-plugins-official', 'playwright', { 'browser-test': 'Drive a browser with Playwright.' }],
  ['community', 'superpowers', { tdd: 'Red, green, refactor.', brainstorming: 'Turn a fuzzy idea into a design before writing code.',
    debugging: 'Systematic root-cause debugging.', 'writing-plans': 'Write an implementation plan.' }],
  ['community', 'pm-toolkit', { prd: 'Write a PRD.', 'user-interviews': 'Plan and synthesise user interviews.' }],
];
const SYNCED = { docx: 'Create and edit Word documents.', pdf: 'Read, fill and merge PDFs.', xlsx: 'Work with spreadsheets.', pptx: 'Build slide decks.' };

function installPlugins(cfg, wanted, disabled = []) {
  const installed = {};
  const markets = {};
  for (const [mk, pl, skills] of PLUGINS) {
    if (!wanted.includes(pl)) continue;
    const p = path.join(cfg, 'plugins', 'cache', mk, pl, '1.4.0');
    for (const [n, d] of Object.entries(skills)) skill(path.join(p, 'skills'), n, d);
    w(path.join(p, '.claude-plugin', 'plugin.json'), { name: pl, version: '1.4.0' });
    if (pl === 'vercel') w(path.join(p, '.mcp.json'), { mcpServers: { vercel: { url: 'https://mcp.vercel.com' } } });
    installed[`${pl}@${mk}`] = [{ scope: 'user', installPath: p, version: '1.4.0' }];
    markets[mk] = {};
  }
  w(path.join(cfg, 'plugins', 'installed_plugins.json'), { version: 2, plugins: installed });
  w(path.join(cfg, 'plugins', 'known_marketplaces.json'), markets);
  return Object.fromEntries(Object.keys(installed).map((k) => [k, !disabled.includes(k.split('@')[0])]));
}

/** Create the fake home and return its (real) path. */
export function buildDemoHome(root) {
  const home = fs.realpathSync(root || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-map-demo-')));
  const H = (...p) => path.join(home, ...p);
  const code = H('code');

  // shared store (npx skills)
  for (const [n, d] of Object.entries(STORE)) skill(H('.agents', 'skills'), n, d);
  w(H('.agents', '.skill-lock.json'), { skills: Object.fromEntries(Object.entries(STORE_SOURCES)
    .map(([n, source]) => [n, { source, updatedAt: '2026-10-01T09:00:00Z' }])) });

  // ── default profile: ~/.claude ──
  const c = H('.claude');
  for (const n of ['brainstorming', 'frontend-design', 'find-skills', 'react-best-practices']) link(H('.agents', 'skills', n), path.join(c, 'skills', n));
  skill(path.join(c, 'skills'), 'release-notes', 'Draft release notes from merged PRs.');
  skill(path.join(c, 'skills'), 'tdd', 'Red, green, refactor.'); // same name as a plugin skill -> conflict
  for (const [n, d] of Object.entries(SYNCED)) skill(path.join(c, 'skills', 'synced', 'org-1'), n, d);
  w(path.join(c, 'skills', 'synced', 'org-1', 'manifest.json'), {});
  let en = installPlugins(c, ['vercel', 'superpowers', 'playwright', 'pm-toolkit'], ['pm-toolkit']);
  w(path.join(c, 'settings.json'), { model: 'opus', enabledPlugins: en, hooks: { PreToolUse: [] } });
  w(path.join(c, 'CLAUDE.md'), '# Global notes\n');
  w(H('.claude.json'), {
    oauthAccount: { emailAddress: 'alex@example.com', organizationName: "alex@example.com's Organization" },
    mcpServers: { github: {}, context7: {} },
    projects: { [`${code}/storefront`]: { mcpServers: { stripe: {} } }, [`${code}/api`]: {}, [`${code}/marketing-site`]: {}, [`${code}/old-prototype`]: {} },
  });
  fs.mkdirSync(path.join(c, 'skills.bak-2026-08-01'), { recursive: true });

  // ── work profile: ~/.claude-work, launched by an alias ──
  const wk = H('.claude-work');
  link(H('.agents', 'skills', 'postgres-tuning'), path.join(wk, 'skills', 'postgres-tuning'));
  skill(path.join(wk, 'skills'), 'release-notes', 'Draft release notes from merged PRs.'); // identical copy
  skill(path.join(wk, 'skills'), 'brainstorming', 'Brainstorm (old fork).', 'Older copy, never updated.');
  skill(path.join(wk, 'skills'), 'incident-review', 'Write a blameless incident review.');
  for (const [n, d] of Object.entries(SYNCED)) skill(path.join(wk, 'skills', 'synced', 'org-2'), n, d);
  en = installPlugins(wk, ['vercel', 'superpowers']);
  en['linear@claude-plugins-official'] = true; // enabled but never installed
  w(path.join(wk, 'settings.json'), { model: 'sonnet', enabledPlugins: en });
  w(path.join(wk, '.claude.json'), {
    oauthAccount: { emailAddress: 'alex@acme.dev', organizationName: 'Acme Inc' },
    mcpServers: { linear: {}, sentry: {} },
    projects: { [`${code}/api`]: { mcpServers: { neon: {} } }, [`${code}/billing`]: {} },
  });

  // ── client profile: config dir outside ~/.claude-*, only reachable through its alias ──
  const k = H('profiles', 'client-co');
  skill(path.join(k, 'skills'), 'release-notes', 'Draft release notes from merged PRs.');
  skill(path.join(k, 'skills'), 'brand-voice', "Write in Client Co's voice.");
  w(path.join(k, 'settings.json'), { enabledPlugins: {} });
  w(path.join(k, '.claude.json'), { oauthAccount: { emailAddress: 'alex@clientco.io', organizationName: 'Client Co' },
    projects: { [`${code}/client-portal`]: {} } });

  // ── other agents ──
  w(H('.codex', 'config.toml'), `model = "gpt-5"\n[mcp_servers.context7]\ncommand = "npx"\n[projects."${code}/api"]\ntrust_level = "trusted"\n`);
  w(H('.codex', 'auth.json'), { auth_mode: 'chatgpt' });
  for (const n of ['brainstorming', 'postgres-tuning']) link(H('.agents', 'skills', n), H('.codex', 'skills', n));
  skill(H('.codex', 'skills'), 'react-best-practices', 'React rules (copied by hand).', 'Hand copy, drifted.');
  w(H('.gemini', 'settings.json'), { mcpServers: { context7: {} } });
  w(H('.gemini', 'google_accounts.json'), { active: 'alex@example.com' });
  link(H('.agents', 'skills', 'frontend-design'), H('.gemini', 'skills', 'frontend-design'));
  w(H('.cursor', 'mcp.json'), { mcpServers: { github: {}, figma: {} } });
  link(H('.agents', 'skills', 'react-best-practices'), H('.cursor', 'skills', 'react-best-practices'));

  // ── projects ──
  for (const p of ['storefront', 'api', 'marketing-site', 'billing', 'client-portal']) fs.mkdirSync(path.join(code, p, '.git'), { recursive: true });
  skill(path.join(code, 'storefront', '.claude', 'skills'), 'checkout-flows', 'How checkout works in this repo.');
  skill(path.join(code, 'storefront', '.claude', 'skills'), 'tdd', 'Red, green, refactor.');
  w(path.join(code, 'storefront', '.mcp.json'), { mcpServers: { playwright: {} } });
  w(path.join(code, 'storefront', '.vercel', 'project.json'), { projectName: 'storefront', projectId: 'prj_demo1', orgId: 'team_demo' });
  w(path.join(code, 'storefront', 'CLAUDE.md'), '# Storefront\n');
  w(path.join(code, 'api', '.env.example'), 'DATABASE_URL=postgres://app@ep-quiet-river-a1b2c3d4.us-east-2.aws.neon.tech/app\n');
  w(path.join(code, 'api', 'AGENTS.md'), '# API\n');
  skill(path.join(code, 'api', '.agents', 'skills'), 'postgres-tuning', 'Read EXPLAIN plans and fix slow queries.');
  w(path.join(code, 'marketing-site', '.vercel', 'project.json'), { projectName: 'marketing', projectId: 'prj_demo2', orgId: 'team_demo' });
  skill(path.join(code, 'marketing-site', '.claude', 'skills'), 'copywriting', 'Write landing-page and product copy.');
  fs.mkdirSync(path.join(code, 'client-portal', 'convex'), { recursive: true });

  // ── shell + cloud CLIs ──
  w(H('.zshrc'), [
    'export PATH=$HOME/bin:$PATH',
    `alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'`,
    `alias claude-client='CLAUDE_CONFIG_DIR="$HOME/profiles/client-co" claude'`,
    "alias neon-work='neonctl --config-dir ~/.config/neonctl-work --project-id demo-proj-123'",
    "alias ll='ls -la'", ''].join('\n'));
  const exp = Date.now() - 86400_000 * 3;
  w(H('.config', 'neonctl', 'credentials.json'), { user_id: 'demo-user-1', expires_at: exp + 86400_000 * 30 });
  w(H('.config', 'neonctl-work', 'credentials.json'), { user_id: 'demo-user-2', expires_at: exp });
  w(H('.config', 'gh', 'hosts.yml'), 'github.com:\n    user: alex-demo\n    git_protocol: ssh\n');
  w(H('.config', 'gcloud', 'active_config'), 'default');
  w(H('.config', 'gcloud', 'configurations', 'config_default'), '[core]\naccount = alex@example.com\nproject = demo-analytics\n');
  return home;
}
