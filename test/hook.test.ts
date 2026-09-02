import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const HOOK_PATH = join(import.meta.dirname, "..", "plugin", "diffquiz", "hooks", "pre-push-quiz.mjs");
const DENY_REASON =
  "diffquiz auto mode: quiz the author on this diff before pushing. Run the diffquiz skill (3 quick questions, wrong answers only get explained — nothing is gated), which records a quiz marker, then re-run this exact command. If no human is present to answer, switch off auto mode with /diffquiz:ondemand instead of answering on their behalf.";

// ---------------------------------------------------------------------------
// git test-repo helpers (mirrors test/git.test.ts's style)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffquiz-hook-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** The exact toplevel path git itself reports — avoids symlink mismatches (e.g. macOS /var vs /private/var) between test and hook. */
function repoToplevel(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).trim();
}

function repoHead(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function markerHashFor(dir: string): string {
  return createHash("sha256").update(repoToplevel(dir)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// hook invocation helper
// ---------------------------------------------------------------------------

interface HookEnvOverrides {
  home?: string;
  diffquizConfig?: string;
  diffquizCacheDir?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the hook script as a real child process, feeding `stdinPayload`
 * verbatim on stdin (caller is responsible for JSON.stringify-ing a valid
 * hook payload, or passing raw garbage to exercise the malformed-stdin
 * path). Env is built from scratch (not inherited) so the developer
 * machine's real ~/.config/diffquiz or XDG_* vars can never leak into a
 * test.
 */
function runHook(stdinPayload: string, env: HookEnvOverrides = {}): HookResult {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
  };
  if (env.home !== undefined) childEnv.HOME = env.home;
  if (env.diffquizConfig !== undefined) childEnv.DIFFQUIZ_CONFIG = env.diffquizConfig;
  if (env.diffquizCacheDir !== undefined) childEnv.DIFFQUIZ_CACHE_DIR = env.diffquizCacheDir;
  if (env.xdgConfigHome !== undefined) childEnv.XDG_CONFIG_HOME = env.xdgConfigHome;
  if (env.xdgCacheHome !== undefined) childEnv.XDG_CACHE_HOME = env.xdgCacheHome;

  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdinPayload,
    encoding: "utf8",
    env: childEnv,
    timeout: 5000,
  });

  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function bashInput(command: string, cwd?: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

function makeIsolatedHome(): string {
  // Guaranteed-empty $HOME so os.homedir() fallback resolution never
  // touches the real machine's ~/.config or ~/.cache.
  return mkdtempSync(join(tmpdir(), "diffquiz-hook-home-"));
}

function writeConfig(dir: string, content: string): string {
  const configDir = join(dir, "diffquiz-config");
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "config.json");
  writeFileSync(path, content);
  return path;
}

function cacheDirIn(dir: string): string {
  return join(dir, "diffquiz-cache");
}

function writeMarker(cacheDir: string, hash: string, content: unknown): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `quizzed-${hash}`), JSON.stringify(content));
}

function assertAllow(result: HookResult): void {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

function assertDeny(result: HookResult): void {
  assert.equal(result.status, 0); // deny is still exit 0 — Claude reads the JSON decision
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, DENY_REASON);
}

// ---------------------------------------------------------------------------
// non-Bash tool / non-push commands -> always allow, regardless of mode
// ---------------------------------------------------------------------------

test("non-Bash tool -> allow (empty stdout)", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/whatever.txt" },
  });
  const result = runHook(input, { home });
  assertAllow(result);
});

test("Bash tool with no tool_input.command -> allow", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
  assertAllow(runHook(input, { home }));
});

const nonPushCommands = ["npm test", "echo git pushover", "git status", "git pushremote-helper", "git log --oneline"];

for (const command of nonPushCommands) {
  test(`non-push Bash command allows regardless of mode: ${JSON.stringify(command)}`, (t) => {
    const home = makeIsolatedHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));

    const result = runHook(bashInput(command), { home, diffquizConfig: configPath });
    assertAllow(result);
  });
}

// ---------------------------------------------------------------------------
// push/PR intent regex: variants that MUST match, driven end-to-end through
// auto mode with no marker present (proving the regex actually triggered
// the deny path, not just "didn't crash").
// ---------------------------------------------------------------------------

const pushVariants = [
  "git push",
  "git push origin main",
  "cd x && git push --force-with-lease",
  "git -C x push",
  "gh pr create --fill",
];

for (const command of pushVariants) {
  test(`push/PR intent matched and denied under auto mode with no marker: ${JSON.stringify(command)}`, (t) => {
    const home = makeIsolatedHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const repo = makeTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));

    const result = runHook(bashInput(command, repo), {
      home,
      diffquizConfig: configPath,
      diffquizCacheDir: cacheDirIn(home),
    });
    assertDeny(result);
  });
}

// ---------------------------------------------------------------------------
// mode resolution
// ---------------------------------------------------------------------------

test("mode ondemand -> allow even for a push command", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "ondemand" }));

  const result = runHook(bashInput("git push", repo), { home, diffquizConfig: configPath });
  assertAllow(result);
});

test("missing config file -> allow even for a push command", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // Point DIFFQUIZ_CONFIG at a path that does not exist.
  const configPath = join(home, "diffquiz-config", "config.json");
  const result = runHook(bashInput("git push", repo), { home, diffquizConfig: configPath });
  assertAllow(result);
});

test("config with invalid JSON -> allow (fail-open), even for a push command", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, "{ not valid json");

  const result = runHook(bashInput("git push", repo), { home, diffquizConfig: configPath });
  assertAllow(result);
});

// ---------------------------------------------------------------------------
// quiz marker
// ---------------------------------------------------------------------------

test("auto mode + no marker -> deny with reason", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));

  const result = runHook(bashInput("git push origin main", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDirIn(home),
  });
  assertDeny(result);
});

test("auto mode + fresh marker (correct hash, current HEAD, recent timestamp) -> allow", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));
  const cacheDir = cacheDirIn(home);
  writeMarker(cacheDir, markerHashFor(repo), { head: repoHead(repo), at: new Date().toISOString() });

  const result = runHook(bashInput("git push", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDir,
  });
  assertAllow(result);
});

test("auto mode + marker with wrong HEAD -> deny", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));
  const cacheDir = cacheDirIn(home);
  writeMarker(cacheDir, markerHashFor(repo), {
    head: "0".repeat(40), // definitely not the repo's real HEAD
    at: new Date().toISOString(),
  });

  const result = runHook(bashInput("git push", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDir,
  });
  assertDeny(result);
});

test("auto mode + marker older than 60 minutes -> deny", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));
  const cacheDir = cacheDirIn(home);
  const staleAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  writeMarker(cacheDir, markerHashFor(repo), { head: repoHead(repo), at: staleAt });

  const result = runHook(bashInput("git push", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDir,
  });
  assertDeny(result);
});

test("auto mode + marker just under 60 minutes old (59m) -> allow", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));
  const cacheDir = cacheDirIn(home);
  const freshAt = new Date(Date.now() - 59 * 60 * 1000).toISOString();
  writeMarker(cacheDir, markerHashFor(repo), { head: repoHead(repo), at: freshAt });

  const result = runHook(bashInput("git push", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDir,
  });
  assertAllow(result);
});

test("auto mode + malformed marker JSON -> deny (not fresh)", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));
  const cacheDir = cacheDirIn(home);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `quizzed-${markerHashFor(repo)}`), "{ not valid json");

  const result = runHook(bashInput("git push", repo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDir,
  });
  assertDeny(result);
});

test("auto mode + cwd outside any git repo -> allow (repo-root resolution fails)", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const notARepo = mkdtempSync(join(tmpdir(), "diffquiz-hook-norepo-"));
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));

  const result = runHook(bashInput("git push", notARepo), {
    home,
    diffquizConfig: configPath,
    diffquizCacheDir: cacheDirIn(home),
  });
  assertAllow(result);
});

// ---------------------------------------------------------------------------
// malformed stdin -> fail-open
// ---------------------------------------------------------------------------

test("malformed stdin -> allow (fail-open)", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = writeConfig(home, JSON.stringify({ mode: "auto" }));

  const result = runHook("this is not json {{{", { home, diffquizConfig: configPath });
  assertAllow(result);
});

test("empty stdin -> allow (fail-open)", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = runHook("", { home });
  assertAllow(result);
});

// ---------------------------------------------------------------------------
// $HOME fallback (no DIFFQUIZ_CONFIG/DIFFQUIZ_CACHE_DIR override)
// ---------------------------------------------------------------------------

test("falls back to ~/.config/diffquiz/config.json and ~/.cache/diffquiz when only $HOME is set", (t) => {
  const home = makeIsolatedHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = makeTempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(join(home, ".config", "diffquiz"), { recursive: true });
  writeFileSync(join(home, ".config", "diffquiz", "config.json"), JSON.stringify({ mode: "auto" }));

  // No marker written under ~/.cache/diffquiz -> expect deny (proves the
  // hook actually resolved mode from the $HOME-derived path, not just
  // failed open by accident).
  const denyResult = runHook(bashInput("git push", repo), { home });
  assertDeny(denyResult);

  mkdirSync(join(home, ".cache", "diffquiz"), { recursive: true });
  writeFileSync(
    join(home, ".cache", "diffquiz", `quizzed-${markerHashFor(repo)}`),
    JSON.stringify({ head: repoHead(repo), at: new Date().toISOString() }),
  );
  const allowResult = runHook(bashInput("git push", repo), { home });
  assertAllow(allowResult);
});
