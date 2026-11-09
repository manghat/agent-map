import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from agent_map import scan as S  # noqa: E402
from agent_map.demo import build_demo_home  # noqa: E402


class DemoScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old = (S.HOME, S.DEMO)
        S.HOME, S.DEMO = build_demo_home(tempfile.mkdtemp()), True
        cls.data = S.scan()
        cls.profiles = {p["id"]: p for p in cls.data["profiles"]}

    @classmethod
    def tearDownClass(cls):
        S.HOME, S.DEMO = cls._old

    def test_finds_every_profile_including_alias_only_dirs(self):
        self.assertEqual(set(self.profiles), {"default", "work", "client"})
        self.assertEqual(self.profiles["client"]["dir"], "~/profiles/client-co")

    def test_aliases_with_quoted_home_paths_attach_to_their_profile(self):
        self.assertEqual(self.profiles["work"]["aliases"], ["claude-work"])
        self.assertEqual(self.profiles["client"]["aliases"], ["claude-client"])
        self.assertEqual(self.profiles["default"]["aliases"], ["claude"])

    def test_accounts_are_read(self):
        self.assertEqual(self.profiles["work"]["account"]["email"], "alex@acme.dev")
        self.assertEqual(self.profiles["work"]["account"]["org"], "Acme Inc")

    def test_symlinked_skills_point_into_the_store(self):
        bs = next(s for s in self.profiles["default"]["skills"] if s["name"] == "brainstorming")
        self.assertTrue(bs["link"])
        self.assertEqual(bs["real"], "~/.agents/skills/brainstorming")

    def test_plugin_state(self):
        plugins = {p["id"]: p for p in self.profiles["default"]["plugins"]}
        self.assertFalse(plugins["pm-toolkit@community"]["enabled"])
        self.assertEqual(sorted(s["name"] for s in plugins["superpowers@community"]["skills"]),
                         ["brainstorming", "debugging", "tdd", "writing-plans"])
        work = {p["id"]: p for p in self.profiles["work"]["plugins"]}
        self.assertFalse(work["linear@claude-plugins-official"]["installed"])

    def test_store_reads_lock_sources(self):
        store = next(s for s in self.data["stores"] if s["id"] == "agents")
        self.assertEqual(next(s for s in store["skills"] if s["name"] == "copywriting")["source"], "coreyhaines31/marketingskills")

    def test_projects_and_services(self):
        projects = {p["path"]: p for p in self.data["projects"]}
        self.assertEqual(projects["~/code/storefront"]["vercel"]["projectName"], "storefront")
        self.assertEqual(projects["~/code/api"]["neon"]["endpoints"], ["ep-quiet-river-a1b2c3d4"])
        self.assertIn("codex", projects["~/code/api"]["usedBy"])
        self.assertFalse(projects["~/code/old-prototype"]["exists"])

    def test_demo_ignores_real_binaries(self):
        self.assertTrue(all(c["bin"] is None for c in self.data["clis"]))
        self.assertEqual(self.data["host"], "demo-machine")

    def test_redact_removes_identities(self):
        r = S.redact(json.loads(json.dumps(self.data)))
        blob = json.dumps(r)
        for secret in ("alex@acme.dev", "alex@clientco.io", "Acme Inc", "Client Co", "client-co", "storefront",
                       "claude-work", "demo-user-1", "ep-quiet-river", "team_demo", "alex-demo"):
            self.assertNotIn(secret.lower(), blob.lower(), secret)
        self.assertTrue(r["redacted"])
        self.assertTrue(all(s["desc"] == "" for p in r["profiles"] for s in p["skills"]))
        # skill names survive
        self.assertIn("release-notes", blob)
        self.assertIn("brainstorming", blob)

    def test_redact_matches_whole_tokens_only(self):
        d = {"host": "box", "profiles": [{"id": "default", "default": True, "dir": "~/.claude", "aliases": [], "projects": [],
                                          "account": {"email": "alex@acme.dev"}, "skills": [{"name": "alexandria-notes", "desc": ""}]}],
             "projects": [], "clis": []}
        r = S.redact(d)
        self.assertEqual(r["profiles"][0]["skills"][0]["name"], "alexandria-notes")

    def test_redact_keeps_service_names_that_match_some_email(self):
        d = {"host": "box", "projects": [], "clis": [], "agents": [],
             "profiles": [{"id": "default", "default": True, "dir": "~/.claude", "aliases": [], "projects": [],
                           "account": {"email": "alex@acme.dev"}, "mcpUser": ["posthog"],
                           "skills": [{"name": "x", "desc": "mail support@posthog.com", "path": "~/a/posthog@x.io"}]}]}
        r = S.redact(d)
        self.assertEqual(r["profiles"][0]["mcpUser"], ["posthog"])
        self.assertNotIn("posthog@x.io", json.dumps(r))


class Parsing(unittest.TestCase):
    def test_alias_forms(self):
        home = tempfile.mkdtemp()
        with open(os.path.join(home, ".zshrc"), "w") as f:
            f.write("alias a='CLAUDE_CONFIG_DIR=\"$HOME/x\" claude'\nalias b=\"CLAUDE_CONFIG_DIR=$HOME/y claude\"\n")
        os.makedirs(os.path.join(home, ".config", "fish"))
        with open(os.path.join(home, ".config", "fish", "config.fish"), "w") as f:
            f.write("alias c 'CLAUDE_CONFIG_DIR=~/z claude'\n")
        old = S.HOME
        try:
            S.HOME = home
            dirs = S.alias_config_dirs(S.shell_aliases())
        finally:
            S.HOME = old
        real = os.path.realpath(home)
        self.assertEqual(dirs.get(os.path.join(real, "x")), ["a"])
        self.assertEqual(dirs.get(os.path.join(real, "y")), ["b"])
        self.assertIn("c", sum(dirs.values(), []))

    def test_toml_fallback_reads_tables(self):
        t = S.load_toml_tables('model = "x"\n[mcp_servers.context7]\ncommand = "npx"\n[projects."/home/a.b/api"]\ntrust_level = "trusted"\n')
        self.assertEqual(t["mcp_servers"]["context7"]["command"], "npx")
        self.assertIn("/home/a.b/api", t["projects"])

    def test_frontmatter_block_description(self):
        name, desc = S.frontmatter("---\nname: x\ndescription: >\n  first line\n  second line\n---\n")
        self.assertEqual((name, desc), ("x", "first line second line"))


class Cli(unittest.TestCase):
    def test_demo_writes_html_with_embedded_data(self):
        out = os.path.join(tempfile.mkdtemp(), "map.html")
        r = subprocess.run([sys.executable, "-m", "agent_map", "--demo", "--no-open", "-o", out],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(out) as f:
            html = f.read()
        self.assertNotIn("/*__DATA__*/null", html)
        payload = re.search(r"const DATA = (\{.*?\});\n", html, re.S).group(1)
        self.assertTrue(json.loads(payload.replace("<\\/", "</"))["demo"])


if __name__ == "__main__":
    unittest.main()
