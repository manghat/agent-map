"""agent-map: scan Claude Code profiles, agent CLIs, skills, plugins, MCP servers,
projects and cloud CLIs (Neon, Vercel, gh, ...) on this machine, and render a
self-contained HTML map.

Usage:
  agent-map              # scan (offline) and open the map
  agent-map --redact     # hide emails, orgs, ids, hostname and project paths (for screenshots)
  agent-map --demo       # render a map of a made-up machine (try it / screenshots)
  agent-map --live       # also ask neonctl / vercel / gh who you're logged in as
  agent-map --no-open    # just regenerate
  agent-map --json       # print the raw scan data

Read-only. Never reads or prints token values from credential files. The only
files it writes are the map itself (default ~/.agent-map/index.html).
"""
import argparse, datetime, glob, hashlib, json, os, pathlib, re, shutil, socket, subprocess, sys, webbrowser

try:
    import tomllib
except ImportError:  # py<3.11
    tomllib = None

from agent_map import __version__

HOME = os.path.expanduser("~")
OUT_DIR = os.path.join(HOME, ".agent-map")
TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template.html")
DEMO = False  # set by --demo: ignore real binaries / env so the map shows only the fake home


def which(name):
    return None if DEMO else shutil.which(name)


def tilde(p):
    if p is None:
        return None
    return "~" + p[len(HOME):] if p.startswith(HOME) else p


def load_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def _toml_key(part):
    part = part.strip()
    return part[1:-1] if len(part) > 1 and part[0] == part[-1] and part[0] in "\"'" else part


def load_toml_tables(text):
    """Python <3.11 fallback: only the table structure ([a.b], [a."quoted.key"]) and simple key = "string" lines."""
    root = {}
    cur = root
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^\[\[?(.+?)\]\]?\s*(?:#.*)?$", line)
        if m:
            parts = re.findall(r'"[^"]*"|\'[^\']*\'|[^.]+', m.group(1))
            cur = root
            for part in parts:
                cur = cur.setdefault(_toml_key(part), {})
            continue
        kv = re.match(r'^([\w.-]+|"[^"]+")\s*=\s*"([^"]*)"', line)
        if kv:
            cur[_toml_key(kv.group(1))] = kv.group(2)
    return root


def load_toml(p):
    if not os.path.isfile(p):
        return None
    try:
        if tomllib:
            with open(p, "rb") as f:
                return tomllib.load(f)
        return load_toml_tables(read_text(p))
    except Exception:
        return None


def read_text(p, limit=200_000):
    try:
        with open(p, errors="replace") as f:
            return f.read(limit)
    except Exception:
        return ""


def frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    fm = m.group(1) if m else ""
    name = re.search(r"^name:\s*(.+)$", fm, re.M)
    desc = re.search(r"^description:\s*(.*)$", fm, re.M)
    d = ""
    if desc:
        d = desc.group(1).strip()
        if d in ("|", ">", "|-", ">-", ""):
            # folded / literal block: take following indented lines
            rest = fm[desc.end():].split("\n")
            d = " ".join(l.strip() for l in rest[1:6] if l.startswith((" ", "\t")))
    d = d.strip().strip("'\"")
    return (name.group(1).strip().strip("'\"") if name else None), d[:280]


def skill_record(skill_dir, kind="dir"):
    """Describe one skill folder (or file) containing SKILL.md."""
    md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(md):
        return None
    text = read_text(md)
    fname, desc = frontmatter(text)
    is_link = os.path.islink(skill_dir)
    real = os.path.realpath(skill_dir)
    return {
        "name": os.path.basename(skill_dir.rstrip("/")),
        "fmName": fname,
        "desc": desc,
        "path": tilde(skill_dir),
        "real": tilde(real) if is_link else None,
        "link": is_link,
        "hash": hashlib.sha1(text.encode()).hexdigest()[:10],
        "gstack": "(gstack)" in text[:3000] or "/gstack/" in real,
    }


def scan_skill_dir(d):
    out = []
    if not os.path.isdir(d):
        return out
    for e in sorted(os.listdir(d)):
        if e.startswith(".") or e == "synced":
            continue
        r = skill_record(os.path.join(d, e))
        if r:
            out.append(r)
    return out


def scan_named_files(d, ext=".md"):
    if not os.path.isdir(d):
        return []
    out = []
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"]
        for f in files:
            if f.endswith(ext) and f.lower() != "readme.md":
                rel = os.path.relpath(os.path.join(root, f), d)
                out.append(rel[: -len(ext)].replace(os.sep, ":"))
    return sorted(out)


def plugin_contents(install_path):
    res = {"skills": [], "commands": [], "agents": [], "mcp": [], "hooks": False}
    if not install_path or not os.path.isdir(install_path):
        return res
    # plugin.json may list skill paths explicitly; otherwise Claude Code loads skills/<name>/SKILL.md
    # (deeper SKILL.md files are reference copies and are not loaded)
    manifest = load_json(os.path.join(install_path, ".claude-plugin", "plugin.json")) or {}
    declared = manifest.get("skills")
    if isinstance(declared, str):
        declared = [declared]
    roots = [os.path.normpath(os.path.join(install_path, x)) for x in declared] if declared else [os.path.join(install_path, "skills")]
    for root in roots:
        if os.path.isfile(os.path.join(root, "SKILL.md")):
            r = skill_record(root)
            if r:
                res["skills"].append(r)
        else:
            res["skills"] += scan_skill_dir(root)
    res["commands"] = scan_named_files(os.path.join(install_path, "commands"))
    res["agents"] = scan_named_files(os.path.join(install_path, "agents"))
    for mp in (os.path.join(install_path, ".mcp.json"), os.path.join(install_path, ".claude-plugin", "plugin.json")):
        j = load_json(mp) or {}
        res["mcp"] += list((j.get("mcpServers") or {}).keys())
    res["hooks"] = os.path.exists(os.path.join(install_path, "hooks", "hooks.json"))
    return res


# ─────────────────────────── shell aliases ────────────────────────────
SHELL_FILES = (".zshrc", ".zprofile", ".zshenv", ".zsh_aliases", ".bashrc", ".bash_profile", ".bash_aliases",
               ".profile", ".aliases", os.path.join(".config", "fish", "config.fish"))


def shell_aliases():
    files = [os.path.join(HOME, f) for f in SHELL_FILES]
    zdot = os.environ.get("ZDOTDIR")
    if zdot and not DEMO:
        files += [os.path.join(zdot, f) for f in (".zshrc", ".zprofile", ".zshenv")]
    txt = "\n".join(read_text(f) for f in dict.fromkeys(files))
    aliases = {}
    # bash/zsh: alias name='value'   fish: alias name 'value' / alias name "value"
    for m in re.finditer(r"^\s*alias\s+([\w.:-]+)(?:=|\s+)(['\"])(.*?)\2\s*$", txt, re.M):
        aliases[m.group(1)] = m.group(3)
    return aliases


def expand(p):
    p = p.strip().strip("'\"")
    p = p.replace("${HOME}", HOME).replace("$HOME", HOME)
    return os.path.realpath(os.path.expanduser(p))


CONFIG_DIR_RE = re.compile(r"CLAUDE_CONFIG_DIR=(?:\"([^\"]+)\"|'([^']+)'|(\S+))")


def alias_config_dirs(aliases):
    """{realpath of CLAUDE_CONFIG_DIR: [alias names]} for aliases that launch Claude with a custom config dir."""
    out = {}
    for a, cmd in aliases.items():
        m = CONFIG_DIR_RE.search(cmd)
        if m:
            out.setdefault(expand(next(g for g in m.groups() if g)), []).append(a)
    return out


def looks_like_claude_dir(d):
    return os.path.isdir(d) and any(os.path.exists(os.path.join(d, x)) for x in
                                    ("settings.json", ".claude.json", "plugins", "projects", "history.jsonl", "skills"))


# ─────────────────────────── Claude profiles ──────────────────────────
def claude_profiles(aliases):
    alias_for = alias_config_dirs(aliases)
    # 1. ~/.claude   2. dirs that shell aliases launch   3. ~/.claude-*   4. $CLAUDE_CONFIG_DIR
    candidates = [os.path.join(HOME, ".claude")] + sorted(alias_for) + sorted(glob.glob(os.path.join(HOME, ".claude-*")))
    env_dir = None if DEMO else os.environ.get("CLAUDE_CONFIG_DIR")
    if env_dir:
        candidates.append(expand(env_dir))
    dirs, seen = [], set()
    for d in candidates:
        r = os.path.realpath(d)
        if r not in seen and looks_like_claude_dir(r):
            seen.add(r)
            dirs.append(d)

    profiles, used_ids = [], set()
    for d in dirs:
        is_default = os.path.realpath(d) == os.path.realpath(os.path.join(HOME, ".claude"))
        names = alias_for.get(os.path.realpath(d), [])
        if is_default:
            pid = "default"
        elif names:
            pid = re.sub(r"^claude[-_]?", "", names[0]) or names[0]
        else:
            pid = re.sub(r"^\.?claude[-_]?", "", os.path.basename(d)) or os.path.basename(d)
        base, n = pid, 2
        while pid in used_ids:
            pid, n = f"{base}-{n}", n + 1
        used_ids.add(pid)
        cj_path = os.path.join(HOME, ".claude.json") if is_default else os.path.join(d, ".claude.json")
        cj = load_json(cj_path) or {}
        settings = load_json(os.path.join(d, "settings.json")) or {}
        settings_local = load_json(os.path.join(d, "settings.local.json")) or {}
        acct = cj.get("oauthAccount") or {}

        skills = scan_skill_dir(os.path.join(d, "skills"))
        synced = []
        for manifest in glob.glob(os.path.join(d, "skills", "synced", "*", "manifest.json")):
            bucket = os.path.dirname(manifest)
            synced += scan_skill_dir(bucket)
        if not synced:
            for bucket in glob.glob(os.path.join(d, "skills", "synced", "*")):
                if os.path.isdir(bucket):
                    synced += scan_skill_dir(bucket)
        # several cached buckets (e.g. an old org) often hold the same skill: keep one per name+content
        uniq = {}
        for s in synced:
            uniq.setdefault((s["name"], s["hash"]), s)
        synced = list(uniq.values())

        enabled = {**(settings.get("enabledPlugins") or {}), **(settings_local.get("enabledPlugins") or {})}
        installed = (load_json(os.path.join(d, "plugins", "installed_plugins.json")) or {}).get("plugins", {})
        plugins = []
        for pkey, entries in installed.items():
            for e in entries:
                name, _, market = pkey.partition("@")
                c = plugin_contents(e.get("installPath"))
                plugins.append({
                    "id": pkey, "name": name, "marketplace": market,
                    "scope": e.get("scope"), "projectPath": tilde(e.get("projectPath")),
                    "version": e.get("version"),
                    "enabled": bool(enabled.get(pkey)) if e.get("scope") == "user" else None,
                    "installPath": tilde(e.get("installPath")),
                    "installed": True,
                    **c,
                })
        for pkey, on in enabled.items():
            if pkey not in installed:
                name, _, market = pkey.partition("@")
                plugins.append({"id": pkey, "name": name, "marketplace": market, "scope": "user",
                                "enabled": bool(on), "installed": False, "skills": [], "commands": [],
                                "agents": [], "mcp": [], "hooks": False})

        projects = {}
        for ppath, pv in (cj.get("projects") or {}).items():
            projects[ppath] = {
                "mcp": sorted((pv.get("mcpServers") or {}).keys()),
                "lastCost": pv.get("lastCost"),
            }

        markets = (load_json(os.path.join(d, "plugins", "known_marketplaces.json")) or {})
        profiles.append({
            "id": pid,
            "dir": tilde(d),
            "default": is_default,
            "aliases": alias_for.get(os.path.realpath(d), []) or (["claude"] if is_default else []),
            "account": {"email": acct.get("emailAddress"), "org": acct.get("organizationName"),
                        "billing": acct.get("billingType")} if acct else None,
            "model": settings.get("model"),
            "hooks": sorted((settings.get("hooks") or {}).keys()),
            "statusLine": bool(settings.get("statusLine")),
            "claudeMd": os.path.exists(os.path.join(d, "CLAUDE.md")),
            "memory": os.path.isdir(os.path.join(d, "memory")),
            "skills": skills,
            "synced": synced,
            "agents": scan_named_files(os.path.join(d, "agents")),
            "commands": scan_named_files(os.path.join(d, "commands")),
            "plugins": plugins,
            "marketplaces": sorted(markets.keys()),
            "mcpUser": sorted((cj.get("mcpServers") or {}).keys()),
            "projects": projects,
            "stale": [os.path.basename(x) for x in glob.glob(os.path.join(d, "skills*.pre-*")) + glob.glob(os.path.join(d, "skills.bak*"))],
        })
    return profiles


# ─────────────────────────── other agent CLIs ─────────────────────────
def other_agents():
    tools = []

    def add(tid, label, bin_name, cfg_dir, skill_dirs, mcp=None, projects=None, plugins=None, account=None, extra=None):
        exists = os.path.isdir(cfg_dir)
        if not exists and not which(bin_name):
            return
        skills = []
        for sd in skill_dirs:
            skills += scan_skill_dir(sd)
        tools.append({"id": tid, "label": label, "bin": tilde(which(bin_name)) if bin_name else None,
                      "dir": tilde(cfg_dir), "skillDirs": [tilde(s) for s in skill_dirs if os.path.isdir(s)],
                      "skills": skills, "mcp": sorted(mcp or []), "projects": projects or [],
                      "plugins": plugins or [], "account": account, "extra": extra})

    cx = os.path.join(HOME, ".codex")
    cfg = load_toml(os.path.join(cx, "config.toml")) or {}
    auth = load_json(os.path.join(cx, "auth.json")) or {}
    add("codex", "Codex CLI", "codex", cx, [os.path.join(cx, "skills")],
        mcp=(cfg.get("mcp_servers") or {}).keys(), projects=list((cfg.get("projects") or {}).keys()),
        plugins=list((cfg.get("plugins") or {}).keys()),
        account={"auth": auth.get("auth_mode") or ("api-key" if auth.get("OPENAI_API_KEY") else ("chatgpt" if auth.get("tokens") else None))})

    gm = os.path.join(HOME, ".gemini")
    gs = load_json(os.path.join(gm, "settings.json")) or {}
    ga = load_json(os.path.join(gm, "google_accounts.json")) or {}
    add("gemini", "Gemini CLI", "gemini", gm, [os.path.join(gm, "skills")],
        mcp=(gs.get("mcpServers") or {}).keys(), account={"email": ga.get("active")})

    cu = os.path.join(HOME, ".cursor")
    add("cursor", "Cursor", "cursor", cu, [os.path.join(cu, "skills"), os.path.join(cu, "skills-cursor")],
        mcp=((load_json(os.path.join(cu, "mcp.json")) or {}).get("mcpServers") or {}).keys())

    oc = os.path.join(HOME, ".config", "opencode")
    ocj = load_json(os.path.join(oc, "opencode.json")) or {}
    add("opencode", "OpenCode", "opencode", oc, [os.path.join(oc, "skills"), os.path.join(oc, "skill")],
        mcp=(ocj.get("mcp") or {}).keys())

    cp = os.path.join(HOME, ".copilot")
    add("copilot", "Copilot CLI", "copilot", cp, [os.path.join(cp, "skills")],
        mcp=((load_json(os.path.join(cp, "mcp-config.json")) or {}).get("mcpServers") or {}).keys())

    amp = os.path.join(HOME, ".config", "amp")
    add("amp", "Amp", "amp", amp, [os.path.join(amp, "skills")])
    return tools


def skill_stores():
    stores = []
    ag = os.path.join(HOME, ".agents", "skills")
    if os.path.isdir(ag):
        lock = (load_json(os.path.join(HOME, ".agents", ".skill-lock.json")) or {}).get("skills", {})
        skills = scan_skill_dir(ag)
        for s in skills:
            l = lock.get(s["name"]) or {}
            s["source"] = l.get("source")
            s["updatedAt"] = l.get("updatedAt")
        stores.append({"id": "agents", "label": "~/.agents/skills", "note": "shared store (npx skills). Agents consume it via symlinks.",
                       "path": tilde(ag), "skills": skills})
    gst = os.path.join(HOME, ".claude", "skills", "gstack")
    if os.path.isdir(gst):
        stores.append({"id": "gstack", "label": "gstack", "note": "gstack suite, installs real folders into ~/.claude/skills",
                       "path": tilde(gst), "skills": []})
    return stores


# ─────────────────────────── projects ─────────────────────────────────
NEON_EP = re.compile(r"(ep-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+)(?:-pooler)?\.[a-z0-9-]+\.aws\.neon\.tech|(ep-[a-z0-9-]+?)(?:-pooler)?\.[\w.-]*neon\.tech")


def scan_project(path):
    p = {"path": tilde(path), "exists": os.path.isdir(path)}
    if not p["exists"]:
        return p
    is_home = os.path.realpath(path) == os.path.realpath(HOME)
    p["isHome"] = is_home
    cd = os.path.join(path, ".claude")
    if not is_home:  # ~/.claude is the default profile, not a project dir
        p["skills"] = scan_skill_dir(os.path.join(cd, "skills"))
        p["commands"] = scan_named_files(os.path.join(cd, "commands"))
        p["agents"] = scan_named_files(os.path.join(cd, "agents"))
        ps = load_json(os.path.join(cd, "settings.json")) or {}
        pl = load_json(os.path.join(cd, "settings.local.json")) or {}
        p["enabledPlugins"] = sorted(k for k, v in {**(ps.get("enabledPlugins") or {}), **(pl.get("enabledPlugins") or {})}.items() if v)
        p["hooks"] = sorted(set((ps.get("hooks") or {}).keys()) | set((pl.get("hooks") or {}).keys()))
        p["agentsSkills"] = scan_skill_dir(os.path.join(path, ".agents", "skills"))
    else:
        p.update(skills=[], commands=[], agents=[], enabledPlugins=[], hooks=[], agentsSkills=[])
    p["mcpJson"] = sorted(((load_json(os.path.join(path, ".mcp.json")) or {}).get("mcpServers") or {}).keys())
    p["claudeMd"] = os.path.exists(os.path.join(path, "CLAUDE.md")) or os.path.exists(os.path.join(cd, "CLAUDE.md"))
    p["agentsMd"] = os.path.exists(os.path.join(path, "AGENTS.md"))
    p["git"] = os.path.exists(os.path.join(path, ".git"))

    v = load_json(os.path.join(path, ".vercel", "project.json"))
    p["vercel"] = {"projectName": v.get("projectName"), "projectId": v.get("projectId"), "orgId": v.get("orgId")} if v else None
    rv = load_json(os.path.join(path, ".vercel", "repo.json"))
    if rv and not p["vercel"]:
        p["vercel"] = {"projectName": ", ".join(x.get("name", "?") for x in rv.get("projects", [])), "orgId": rv.get("orgId"), "repo": True}

    neon = load_json(os.path.join(path, ".neon"))
    eps = set()
    if not is_home:
        for envf in glob.glob(os.path.join(path, ".env*")) + glob.glob(os.path.join(path, "*", ".env*")):
            if os.path.isfile(envf) and os.path.getsize(envf) < 200_000:
                for m in NEON_EP.finditer(read_text(envf)):
                    eps.add((m.group(1) or m.group(2)))
    p["neon"] = {"context": neon, "endpoints": sorted(eps)} if (neon or eps) else None
    sb = os.path.join(path, "supabase", "config.toml")
    p["supabase"] = bool(os.path.exists(sb))
    p["convex"] = os.path.exists(os.path.join(path, "convex.json")) or os.path.isdir(os.path.join(path, "convex"))
    return p


# ─────────────────────────── cloud / infra CLIs ──────────────────────
def run(cmd, timeout=12):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"error: {e}"


def neon_alias_dir(cmd):
    m = re.search(r"--config-dir[ =](\S+)", cmd)
    return expand(m.group(1)) if m else os.path.realpath(os.path.join(HOME, ".config", "neonctl"))


def cloud_clis(aliases, live):
    clis = []

    # Neon
    neon_bin = which("neonctl")
    if neon_bin or os.path.isdir(os.path.join(HOME, ".config", "neonctl")):
        accounts = []
        cfg_dirs = {os.path.join(HOME, ".config", "neonctl"): "default"}
        for a, cmd in aliases.items():
            if cmd.startswith(("neonctl", "neon ")) or " neonctl" in cmd:
                m = re.search(r"--config-dir[ =](\S+)", cmd)
                d = expand(m.group(1)) if m else os.path.join(HOME, ".config", "neonctl")
                cfg_dirs.setdefault(d, a)
        for d in glob.glob(os.path.join(HOME, ".config", "neonctl*")):
            cfg_dirs.setdefault(d, None)
        for d in cfg_dirs:
            c = load_json(os.path.join(d, "credentials.json"))
            if c is None:
                continue
            al = [a for a, cmd in aliases.items() if "neonctl" in cmd and neon_alias_dir(cmd) == os.path.realpath(d)]
            proj = [re.search(r"--project-id[ =](\S+)", aliases[a]).group(1) for a in al if re.search(r"--project-id[ =](\S+)", aliases[a])]
            acc = {"label": os.path.basename(d), "configDir": tilde(d), "userId": c.get("user_id"),
                   "aliases": al, "pinnedProject": proj[0] if proj else None,
                   "expires": datetime.datetime.fromtimestamp(c["expires_at"] / 1000).isoformat(timespec="minutes") if isinstance(c.get("expires_at"), (int, float)) else None}
            if live and neon_bin:
                out = run([neon_bin, "me", "--config-dir", d, "--output", "json"])
                try:
                    j = json.loads(out[out.index("{"):])
                    acc["email"] = j.get("email"); acc["login"] = j.get("login")
                except Exception:
                    acc["liveError"] = out.strip()[:160]
            accounts.append(acc)
        prof = load_json(os.path.join(HOME, ".config", "neon", "profiles.json")) or {}
        for name, pv in (prof.get("profiles") or {}).items():
            if name == "DEFAULT":
                continue
            cred = load_json(os.path.join(HOME, ".config", "neon", pv.get("credentials", ""))) or {}
            accounts.append({"label": f"neon profile: {name}", "configDir": "~/.config/neon", "userId": pv.get("userId") or cred.get("user_id"),
                             "email": pv.get("label"), "aliases": []})
        clis.append({"id": "neon", "label": "Neon (neonctl)", "bin": tilde(neon_bin), "accounts": accounts,
                     "note": "Separate config dirs = separate accounts. Aliases pin the account (and sometimes the project)."})

    # Vercel
    vbin = which("vercel")
    vdir = os.path.join(HOME, "Library", "Application Support", "com.vercel.cli")
    if not os.path.isdir(vdir):
        vdir = os.path.join(HOME, ".local", "share", "com.vercel.cli")
    if vbin or os.path.isdir(vdir):
        vc = load_json(os.path.join(vdir, "config.json")) or {}
        acc = {"label": "global", "configDir": tilde(vdir), "currentTeam": vc.get("currentTeam"),
               "loggedIn": os.path.exists(os.path.join(vdir, "auth.json"))}
        if live and vbin:
            out = run([vbin, "whoami"], timeout=20)
            acc["user"] = out.strip().splitlines()[-1] if out.strip() else None
        clis.append({"id": "vercel", "label": "Vercel CLI", "bin": tilde(vbin), "accounts": [acc],
                     "note": "One global login. Per-project link lives in <project>/.vercel/project.json (see Projects tab)."})

    # GitHub
    gbin = which("gh")
    hosts = read_text(os.path.join(HOME, ".config", "gh", "hosts.yml"))
    if gbin or hosts:
        accs = []
        cur = None
        for line in hosts.splitlines():
            if re.match(r"^\S.*:$", line):
                cur = line[:-1]
            m = re.match(r"^\s{4}user:\s*(\S+)", line)
            if m and cur:
                accs.append({"label": cur, "user": m.group(1), "configDir": "~/.config/gh"})
            m2 = re.match(r"^\s{8}(\S+):\s*$", line)  # multi-account users: block
            if m2 and cur and m2.group(1) not in ("oauth_token",):
                if not any(a["user"] == m2.group(1) for a in accs):
                    accs.append({"label": cur, "user": m2.group(1), "configDir": "~/.config/gh", "inactive": True})
        seen = {}
        for a in accs:
            k = (a["label"], a["user"])
            if k not in seen or not a.get("inactive"):
                seen[k] = a
        accs = list(seen.values())
        if live and gbin:
            for a in accs:
                a["status"] = run([gbin, "auth", "status", "-h", a["label"]]).strip()[:300]
        clis.append({"id": "gh", "label": "GitHub CLI", "bin": tilde(gbin), "accounts": accs})

    # gcloud
    gcd = os.path.join(HOME, ".config", "gcloud")
    if os.path.isdir(gcd):
        active = read_text(os.path.join(gcd, "active_config")).strip() or "default"
        accs = []
        for f in sorted(glob.glob(os.path.join(gcd, "configurations", "config_*"))):
            t = read_text(f)
            name = os.path.basename(f)[7:]
            acct = re.search(r"^account\s*=\s*(\S+)", t, re.M)
            proj = re.search(r"^project\s*=\s*(\S+)", t, re.M)
            accs.append({"label": name, "email": acct.group(1) if acct else None, "project": proj.group(1) if proj else None,
                         "active": name == active})
        clis.append({"id": "gcloud", "label": "Google Cloud (gcloud)", "bin": tilde(which("gcloud")), "accounts": accs})

    # AWS
    awsc = read_text(os.path.join(HOME, ".aws", "config"))
    if awsc:
        accs = [{"label": m.group(1)} for m in re.finditer(r"^\[(?:profile )?([^\]]+)\]", awsc, re.M)]
        clis.append({"id": "aws", "label": "AWS CLI", "bin": tilde(which("aws")), "accounts": accs})

    # Supabase
    if which("supabase") or os.path.isdir(os.path.join(HOME, ".supabase")):
        clis.append({"id": "supabase", "label": "Supabase CLI", "bin": tilde(which("supabase")),
                     "accounts": [{"label": "global", "configDir": "~/.supabase",
                                   "loggedIn": os.path.exists(os.path.join(HOME, ".supabase", "access-token"))}]})
    # Modal
    mt = read_text(os.path.join(HOME, ".modal.toml"))
    if mt:
        clis.append({"id": "modal", "label": "Modal", "bin": tilde(which("modal")),
                     "accounts": [{"label": m.group(1), "configDir": "~/.modal.toml"} for m in re.finditer(r"^\[([^\]]+)\]", mt, re.M)]})
    # Turso
    if which("turso") or os.path.isdir(os.path.join(HOME, ".turso")):
        clis.append({"id": "turso", "label": "Turso", "bin": tilde(which("turso")), "accounts": [{"label": "global", "configDir": "~/.turso"}]})
    # Convex
    if os.path.isdir(os.path.join(HOME, ".convex")):
        clis.append({"id": "convex", "label": "Convex", "bin": None, "accounts": [{"label": "global", "configDir": "~/.convex",
                     "loggedIn": os.path.exists(os.path.join(HOME, ".convex", "config.json"))}]})
    # Cloudflare wrangler
    if which("wrangler"):
        clis.append({"id": "wrangler", "label": "Cloudflare wrangler", "bin": tilde(which("wrangler")), "accounts": []})
    return clis


# ─────────────────────────── main ─────────────────────────────────────
def scan(live=False):
    aliases = shell_aliases()
    profiles = claude_profiles(aliases)
    agents = other_agents()
    stores = skill_stores()
    clis = cloud_clis(aliases, live)

    # union of every project any tool has seen
    proj_users = {}
    for pr in profiles:
        for path in pr["projects"]:
            proj_users.setdefault(path, set()).add(pr["id"])
        for pl in pr["plugins"]:
            if pl.get("projectPath"):
                proj_users.setdefault(os.path.expanduser(pl["projectPath"]), set())
    for ag in agents:
        for path in ag["projects"]:
            proj_users.setdefault(path, set()).add(ag["id"])
    projects = []
    for path in sorted(proj_users):
        in_home = path == HOME or path.startswith(HOME + os.sep)
        if (not in_home and path.startswith(("/private/tmp", "/tmp", "/var/folders", "/private/var/folders"))) \
                or "/.claude/worktrees/" in path:
            continue
        p = scan_project(path)
        p["usedBy"] = sorted(proj_users[path])
        p["mcpLocal"] = {pr["id"]: pr["projects"][path]["mcp"] for pr in profiles if path in pr["projects"] and pr["projects"][path]["mcp"]}
        p["projectPlugins"] = [{"profile": pr["id"], "id": pl["id"], "skills": [s["name"] for s in pl["skills"]]}
                               for pr in profiles for pl in pr["plugins"] if pl.get("projectPath") == tilde(path)]
        projects.append(p)
    for pr in profiles:  # keep payload lean; projects are in their own table
        pr["projects"] = sorted(tilde(x) for x in pr["projects"])
    for ag in agents:
        ag["projects"] = sorted(tilde(x) for x in ag["projects"] if tilde(x) in {p["path"] for p in projects})

    return {
        "version": __version__,
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "host": "demo-machine" if DEMO else socket.gethostname(),
        "live": live,
        "demo": DEMO,
        "redacted": False,
        "profiles": profiles,
        "agents": agents,
        "stores": stores,
        "projects": projects,
        "clis": clis,
        "aliases": {k: v for k, v in aliases.items() if re.search(r"claude|neon|vercel|gh |codex|gemini|supabase|CONFIG_DIR", v)},
    }


# ─────────────────────────── redaction ────────────────────────────────
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# values that identify an account, team or resource: replaced wholesale
ID_KEYS = {"userId", "orgId", "projectId", "pinnedProject", "currentTeam", "user", "login", "status",
           "liveError", "project", "projectName", "endpoints"}


def redact(data):
    """Best-effort: swap personal strings for stable placeholders so the map can be screenshotted.

    Emails -> user1@example.com, orgs/ids -> placeholders, project paths -> ~/projects/project-01,
    profile folders -> ~/.claude-<id>, hostname -> my-computer, home folder name -> you, skill
    descriptions dropped. Skill, plugin and MCP server names are kept: check those yourself.
    """
    subs = {}  # original (lowercased) -> replacement

    def put(orig, new):
        if orig and len(orig) >= 3 and orig.lower() not in subs:
            subs[orig.lower()] = new

    # 1. project paths, longest first so nested paths map cleanly
    for i, p in enumerate(sorted({p["path"] for p in data["projects"]}, key=lambda x: (x.count("/"), x)), 1):
        if p not in ("~", "~/"):
            put(p, f"~/projects/project-{i:02d}")
    for pr in data["profiles"]:
        for i, p in enumerate(pr["projects"], 1):
            put(p, f"~/projects/{pr['id']}-{i:02d}")

    # 2. profiles: ids, aliases and folders are named after accounts or clients ("claude-acme")
    for i, pr in enumerate(data["profiles"], 1):
        if pr["default"]:
            continue
        put(pr["dir"], f"~/.claude-profile-{i}")
        for a in pr["aliases"]:
            put(a, f"claude-profile-{i}")
        put(pr["id"], f"profile-{i}")

    # 3. emails, and the "name_domain.tld" form account-switchers use in folder names, plus local parts
    blob = json.dumps(data)
    found = {m.group(0) for m in EMAIL_RE.finditer(blob)}
    found |= {m.group(1) + "@" + m.group(2) for m in re.finditer(r"(?<![\w.-])(?:\d+-)?([a-z][\w.+-]*)_([\w-]+\.[a-z]{2,})(?![\w-])", blob, re.I)}
    # bare local parts ("alex") only for accounts actually signed in here: an arbitrary email in some
    # skill (support@posthog.com) must not rename the posthog MCP server
    accounts = {(p.get("account") or {}).get("email") for p in data["profiles"]}
    accounts |= {(a.get("account") or {}).get("email") for a in data.get("agents", [])}
    accounts |= {a.get("email") for c in data.get("clis", []) for a in c["accounts"]}
    accounts = {e.lower() for e in accounts if e}
    for i, e in enumerate(sorted(found, key=str.lower), 1):
        local, _, domain = e.partition("@")
        put(e, f"user{i}@example.com")
        put(f"{local}_{domain}", f"user{i}_example.com")
        if e.lower() in accounts and len(local) >= 5:
            put(local, f"user{i}")

    # 4. hostname, home folder name
    put(data.get("host"), "my-computer")
    user = os.path.basename(HOME.rstrip(os.sep))
    if len(user) >= 4:
        put(user, "you")

    # 5. org names
    for i, pr in enumerate(data["profiles"], 1):
        org = (pr.get("account") or {}).get("org")
        if org:
            put(org, f"Org {i}")

    # 6. cloud CLI account labels that aren't generic ("neon profile: acme")
    for c in data["clis"]:
        for j, a in enumerate(c["accounts"], 1):
            lab = a.get("label") or ""
            if lab not in ("global", "default", "github.com") and not re.fullmatch(r"neonctl|config_default", lab):
                a["label"] = f"account-{j}"

    def walk(x, key=None):
        if isinstance(x, dict):
            return {sub_all(k): walk(v, k) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v, key) for v in x]
        if isinstance(x, str):
            if key == "desc":  # free text written by you: may name clients, domains, people
                return ""
            return "redacted" if key in ID_KEYS and x else sub_all(x)
        return x

    keys = sorted(subs, key=len, reverse=True)
    # whole tokens only, so redacting "alex" doesn't mangle a skill called "alexandria-notes"
    pat = re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(re.escape(k) for k in keys) + r")(?![A-Za-z0-9])", re.I) if keys else None

    def sub_all(s):
        return pat.sub(lambda m: subs[m.group(0).lower()], s) if pat else s

    out = walk(data)
    out["redacted"] = True
    return out


# ─────────────────────────── main ─────────────────────────────────────
def render(data, out_path):
    html = read_text(TEMPLATE, limit=10_000_000)
    payload = json.dumps(data).replace("</", "<\\/")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as f:
        f.write(html.replace("/*__DATA__*/null", payload))


def main(argv=None):
    global HOME, DEMO
    ap = argparse.ArgumentParser(prog="agent-map", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--redact", action="store_true", help="hide emails, orgs, account ids, hostname and project paths")
    ap.add_argument("--demo", action="store_true", help="scan a generated fake home instead of yours")
    ap.add_argument("--live", action="store_true", help="query neonctl/vercel/gh for logged-in identity (network)")
    ap.add_argument("--no-open", action="store_true", help="write the map but don't open a browser")
    ap.add_argument("--json", action="store_true", help="print the scan as JSON instead of writing HTML")
    ap.add_argument("-o", "--out", help="output file (default ~/.agent-map/index.html, or demo.html with --demo)")
    ap.add_argument("--version", action="version", version=f"agent-map {__version__}")
    a = ap.parse_args(argv)

    out = a.out or os.path.join(OUT_DIR, "demo.html" if a.demo else "index.html")
    if a.demo:
        from agent_map.demo import build_demo_home
        HOME, DEMO = build_demo_home(), True
        if a.live:
            print("agent-map: --live is ignored with --demo", file=sys.stderr)
            a.live = False
    data = scan(a.live)
    if a.redact:
        data = redact(data)
    if a.json:
        print(json.dumps(data, indent=1))
        return 0
    render(data, out)
    n_skills = len({s["name"] for p in data["profiles"] for s in p["skills"] + p["synced"]}
                   | {s["name"] for g in data["agents"] + data["stores"] for s in g["skills"]})
    print(f"agent-map: wrote {out.replace(os.path.expanduser('~'), '~', 1)}\n"
          f"  {len(data['profiles'])} Claude profiles · {len(data['agents'])} other agents · "
          f"{len(data['projects'])} projects · {len(data['clis'])} CLIs · {n_skills}+ distinct skills"
          + ("  (redacted)" if a.redact else ""))
    if not a.no_open:
        webbrowser.open(pathlib.Path(out).resolve().as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())
