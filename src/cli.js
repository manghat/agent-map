import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildDemoHome } from './demo.js';
import { redact } from './redact.js';
import { configure, scan } from './scan.js';
import { VERSION } from './version.js';

const HELP = `agent-map ${VERSION}
See every Claude Code profile, skill, plugin, MCP server and CLI login on this machine.

Usage: npx agent-map [options]

  --redact      replace emails, orgs, account ids, profile names, hostname and project paths
  --demo        map a made-up machine instead of yours
  --live        also ask neonctl / vercel / gh who is logged in (network calls)
  --no-open     write the map without opening a browser
  --json        print the raw scan instead of writing HTML
  -o, --out     output file (default ~/.agent-map/index.html, or demo.html with --demo)
  -v, --version
  -h, --help

Read-only. Never reads token values. The only file it writes is the map.
`;

const TEMPLATE = new URL('./template.html', import.meta.url);

export function render(data, outPath) {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const payload = JSON.stringify(data).replaceAll('</', '<\\/');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html.split('/*__DATA__*/null').join(payload));
}

function openInBrowser(file) {
  const url = pathToFileURL(file).href;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.error(`agent-map: open ${url} in your browser`));
    child.unref();
  } catch {
    console.error(`agent-map: open ${url} in your browser`);
  }
}

export function main(argv) {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        redact: { type: 'boolean' }, demo: { type: 'boolean' }, live: { type: 'boolean' }, 'no-open': { type: 'boolean' },
        json: { type: 'boolean' }, out: { type: 'string', short: 'o' }, version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    console.error(`agent-map: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.version) { console.log(`agent-map ${VERSION}`); return 0; }

  const home = os.homedir();
  const out = path.resolve(opts.out || path.join(home, '.agent-map', opts.demo ? 'demo.html' : 'index.html'));
  let live = !!opts.live;
  if (opts.demo) {
    configure({ home: buildDemoHome(), demo: true });
    if (live) console.error('agent-map: --live is ignored with --demo');
    live = false;
  }
  let data = scan({ live });
  if (opts.redact) data = redact(data);
  if (opts.json) { console.log(JSON.stringify(data, null, 1)); return 0; }

  render(data, out);
  const names = new Set([
    ...data.profiles.flatMap((p) => [...p.skills, ...p.synced]),
    ...[...data.agents, ...data.stores].flatMap((g) => g.skills),
  ].map((s) => s.name));
  const shown = out.startsWith(home) ? '~' + out.slice(home.length) : out;
  console.log(`agent-map: wrote ${shown}\n  ${data.profiles.length} Claude profiles · ${data.agents.length} other agents · `
    + `${data.projects.length} projects · ${data.clis.length} CLIs · ${names.size}+ distinct skills${opts.redact ? '  (redacted)' : ''}`);
  if (!opts['no-open']) openInBrowser(out);
  return 0;
}
