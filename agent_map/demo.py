"""Build a made-up home folder with a realistic (and realistically messy) agent setup.

Used by `agent-map --demo` and by the tests. Nothing here is real: every account,
org and project is invented, and no file contains a token.
"""
import json
import os
import tempfile
import time


def _w(path, content=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content if isinstance(content, str) else json.dumps(content, indent=1))


def _skill(folder, name, desc, body=""):
    _w(os.path.join(folder, name, "SKILL.md"), f"---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n{body}\n")


def _link(target, link):
    os.makedirs(os.path.dirname(link), exist_ok=True)
    os.symlink(target, link)


STORE = {
    "brainstorming": "Turn a fuzzy idea into a design before writing code.",
    "frontend-design": "Build distinctive, production-grade web UI.",
    "find-skills": "Search the skills directory for a skill that fits the task.",
    "react-best-practices": "React and Next.js performance rules.",
    "postgres-tuning": "Read EXPLAIN plans and fix slow queries.",
    "copywriting": "Write landing-page and product copy.",
    "seo-audit": "Audit a site for technical SEO problems.",
}

PLUGINS = {
    # marketplace, plugin -> skills
    ("claude-plugins-official", "vercel"): {"deploy": "Deploy to Vercel.", "ai-sdk": "Use the Vercel AI SDK.",
                                            "env-vars": "Manage Vercel environment variables."},
    ("claude-plugins-official", "playwright"): {"browser-test": "Drive a browser with Playwright."},
    ("community", "superpowers"): {"tdd": "Red, green, refactor.", "brainstorming": "Turn a fuzzy idea into a design before writing code.",
                                   "debugging": "Systematic root-cause debugging.", "writing-plans": "Write an implementation plan."},
    ("community", "pm-toolkit"): {"prd": "Write a PRD.", "user-interviews": "Plan and synthesise user interviews."},
}

SYNCED = {"docx": "Create and edit Word documents.", "pdf": "Read, fill and merge PDFs.",
          "xlsx": "Work with spreadsheets.", "pptx": "Build slide decks."}


def build_demo_home(root=None):
    """Create the fake home and return its path."""
    home = os.path.realpath(root or tempfile.mkdtemp(prefix="agent-map-demo-"))
    H = lambda *p: os.path.join(home, *p)  # noqa: E731

    # shared store (npx skills)
    for n, d in STORE.items():
        _skill(H(".agents", "skills"), n, d)
    _w(H(".agents", ".skill-lock.json"), {"skills": {n: {"source": src, "updatedAt": "2026-10-01T09:00:00Z"} for n, src in {
        "brainstorming": "obra/superpowers", "frontend-design": "anthropics/skills", "find-skills": "vercel-labs/skills",
        "react-best-practices": "vercel-labs/agent-skills", "postgres-tuning": "neondatabase/agent-skills",
        "copywriting": "coreyhaines31/marketingskills", "seo-audit": "coreyhaines31/marketingskills"}.items()}})

    # plugin cache shared by profiles
    def install_plugins(cfg, wanted, enabled_map):
        installed = {}
        for (mk, pl), skills in PLUGINS.items():
            if pl not in wanted:
                continue
            path = os.path.join(cfg, "plugins", "cache", mk, pl, "1.4.0")
            for n, d in skills.items():
                _skill(os.path.join(path, "skills"), n, d)
            _w(os.path.join(path, ".claude-plugin", "plugin.json"), {"name": pl, "version": "1.4.0"})
            if pl == "vercel":
                _w(os.path.join(path, ".mcp.json"), {"mcpServers": {"vercel": {"url": "https://mcp.vercel.com"}}})
            installed[f"{pl}@{mk}"] = [{"scope": "user", "installPath": path, "version": "1.4.0"}]
        _w(os.path.join(cfg, "plugins", "installed_plugins.json"), {"version": 2, "plugins": installed})
        _w(os.path.join(cfg, "plugins", "known_marketplaces.json"), {mk: {} for (mk, pl) in PLUGINS if pl in wanted})
        return {k: enabled_map.get(k.split("@")[0], True) for k in installed}

    code = H("code")
    projects = {f"{code}/storefront": {"mcpServers": {"stripe": {}}}, f"{code}/api": {}, f"{code}/marketing-site": {},
                f"{code}/old-prototype": {}}

    # ── default profile: ~/.claude ──
    c = H(".claude")
    for n in ("brainstorming", "frontend-design", "find-skills", "react-best-practices"):
        _link(H(".agents", "skills", n), os.path.join(c, "skills", n))
    _skill(os.path.join(c, "skills"), "release-notes", "Draft release notes from merged PRs.")
    _skill(os.path.join(c, "skills"), "tdd", "Red, green, refactor.")  # same name as a plugin skill -> conflict
    for n, d in SYNCED.items():
        _skill(os.path.join(c, "skills", "synced", "org-1"), n, d)
    _w(os.path.join(c, "skills", "synced", "org-1", "manifest.json"), {})
    en = install_plugins(c, {"vercel", "superpowers", "playwright", "pm-toolkit"}, {"pm-toolkit": False})
    _w(os.path.join(c, "settings.json"), {"model": "opus", "enabledPlugins": en, "hooks": {"PreToolUse": []}})
    _w(os.path.join(c, "CLAUDE.md"), "# Global notes\n")
    _w(H(".claude.json"), {"oauthAccount": {"emailAddress": "alex@example.com", "organizationName": "alex@example.com's Organization"},
                           "mcpServers": {"github": {}, "context7": {}}, "projects": projects})
    os.makedirs(os.path.join(c, "skills.bak-2026-08-01"), exist_ok=True)

    # ── work profile: ~/.claude-work, launched by an alias ──
    w = H(".claude-work")
    _link(H(".agents", "skills", "postgres-tuning"), os.path.join(w, "skills", "postgres-tuning"))
    _skill(os.path.join(w, "skills"), "release-notes", "Draft release notes from merged PRs.")  # identical copy
    _skill(os.path.join(w, "skills"), "brainstorming", "Brainstorm (old fork).", body="Older copy, never updated.")
    _skill(os.path.join(w, "skills"), "incident-review", "Write a blameless incident review.")
    for n, d in SYNCED.items():
        _skill(os.path.join(w, "skills", "synced", "org-2"), n, d)
    en = install_plugins(w, {"vercel", "superpowers"}, {})
    en["linear@claude-plugins-official"] = True  # enabled but never installed
    _w(os.path.join(w, "settings.json"), {"model": "sonnet", "enabledPlugins": en})
    _w(os.path.join(w, ".claude.json"), {"oauthAccount": {"emailAddress": "alex@acme.dev", "organizationName": "Acme Inc"},
                                         "mcpServers": {"linear": {}, "sentry": {}},
                                         "projects": {f"{code}/api": {"mcpServers": {"neon": {}}}, f"{code}/billing": {}}})

    # ── client profile: config dir outside ~/.claude-*, only reachable through its alias ──
    k = H("profiles", "client-co")
    _skill(os.path.join(k, "skills"), "release-notes", "Draft release notes from merged PRs.")
    _skill(os.path.join(k, "skills"), "brand-voice", "Write in Client Co's voice.")
    _w(os.path.join(k, "settings.json"), {"enabledPlugins": {}})
    _w(os.path.join(k, ".claude.json"), {"oauthAccount": {"emailAddress": "alex@clientco.io", "organizationName": "Client Co"},
                                         "projects": {f"{code}/client-portal": {}}})

    # ── other agents ──
    _w(H(".codex", "config.toml"), f'model = "gpt-5"\n[mcp_servers.context7]\ncommand = "npx"\n[projects."{code}/api"]\ntrust_level = "trusted"\n')
    _w(H(".codex", "auth.json"), {"auth_mode": "chatgpt"})
    for n in ("brainstorming", "postgres-tuning"):
        _link(H(".agents", "skills", n), H(".codex", "skills", n))
    _skill(H(".codex", "skills"), "react-best-practices", "React rules (copied by hand).", body="Hand copy, drifted.")
    _w(H(".gemini", "settings.json"), {"mcpServers": {"context7": {}}})
    _w(H(".gemini", "google_accounts.json"), {"active": "alex@example.com"})
    _link(H(".agents", "skills", "frontend-design"), H(".gemini", "skills", "frontend-design"))
    _w(H(".cursor", "mcp.json"), {"mcpServers": {"github": {}, "figma": {}}})
    _link(H(".agents", "skills", "react-best-practices"), H(".cursor", "skills", "react-best-practices"))

    # ── projects ──
    for p in ("storefront", "api", "marketing-site", "billing", "client-portal"):
        os.makedirs(os.path.join(code, p, ".git"), exist_ok=True)
    _skill(os.path.join(code, "storefront", ".claude", "skills"), "checkout-flows", "How checkout works in this repo.")
    _skill(os.path.join(code, "storefront", ".claude", "skills"), "tdd", "Red, green, refactor.")
    _w(os.path.join(code, "storefront", ".mcp.json"), {"mcpServers": {"playwright": {}}})
    _w(os.path.join(code, "storefront", ".vercel", "project.json"), {"projectName": "storefront", "projectId": "prj_demo1", "orgId": "team_demo"})
    _w(os.path.join(code, "storefront", "CLAUDE.md"), "# Storefront\n")
    _w(os.path.join(code, "api", ".env.example"), "DATABASE_URL=postgres://app@ep-quiet-river-a1b2c3d4.us-east-2.aws.neon.tech/app\n")
    _w(os.path.join(code, "api", "AGENTS.md"), "# API\n")
    _skill(os.path.join(code, "api", ".agents", "skills"), "postgres-tuning", "Read EXPLAIN plans and fix slow queries.")
    _w(os.path.join(code, "marketing-site", ".vercel", "project.json"), {"projectName": "marketing", "projectId": "prj_demo2", "orgId": "team_demo"})
    _skill(os.path.join(code, "marketing-site", ".claude", "skills"), "copywriting", "Write landing-page and product copy.")
    os.makedirs(os.path.join(code, "client-portal", "convex"), exist_ok=True)

    # ── shell + cloud CLIs ──
    _w(H(".zshrc"), "\n".join([
        "export PATH=$HOME/bin:$PATH",
        "alias claude-work='CLAUDE_CONFIG_DIR=\"$HOME/.claude-work\" claude'",
        "alias claude-client='CLAUDE_CONFIG_DIR=\"$HOME/profiles/client-co\" claude'",
        "alias neon-work='neonctl --config-dir ~/.config/neonctl-work --project-id demo-proj-123'",
        "alias ll='ls -la'", ""]))
    exp = int((time.time() - 86400 * 3) * 1000)
    _w(H(".config", "neonctl", "credentials.json"), {"user_id": "demo-user-1", "expires_at": exp + 86400 * 30 * 1000})
    _w(H(".config", "neonctl-work", "credentials.json"), {"user_id": "demo-user-2", "expires_at": exp})
    _w(H(".config", "gh", "hosts.yml"), "github.com:\n    user: alex-demo\n    git_protocol: ssh\n")
    _w(H(".config", "gcloud", "active_config"), "default")
    _w(H(".config", "gcloud", "configurations", "config_default"), "[core]\naccount = alex@example.com\nproject = demo-analytics\n")
    return home
