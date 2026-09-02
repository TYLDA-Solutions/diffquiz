#!/usr/bin/env node
/**
 * diffquiz auto-mode PreToolUse hook (Bash).
 *
 * Plain Node ESM, zero dependencies beyond `node:` builtins — this file is
 * invoked directly by the Claude Code plugin runtime via
 * `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-push-quiz.mjs"`, so it must start
 * fast and never assume anything about the environment beyond stdin/argv.
 *
 * What it does: when the session is about to run `git push` or
 * `gh pr create` AND the user has opted into `mode: "auto"` in their
 * user-global diffquiz config, it denies the tool call (with a reason
 * Claude sees) unless a fresh quiz marker already exists for this repo's
 * current HEAD. See docs/SPEC.md, "v0.2.0 — Plugin modes (auto / on-demand)".
 *
 * FAIL-OPEN: this hook must never be able to break a git workflow. Every
 * failure mode short of "the user explicitly opted into auto mode and no
 * fresh quiz marker exists" resolves to a silent allow. The one exception —
 * by design, not by accident — is a missing or stale quiz marker itself,
 * which is the whole point of auto mode and must DENY.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Word-boundary intent match, tolerant of prefixes/suffixes on the same
// shell command (e.g. `cd x && git push`, `git -C x push --force`) but not
// of push being part of a longer word (e.g. `git pushremote-helper`).
// Deliberately does not cross `|`, `;`, or `&` — those separate distinct
// shell commands, and matching across them risks false positives.
const PUSH_RE = /\bgit\b[^|;&]*\bpush\b/;
const PR_CREATE_RE = /\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b/;

const MARKER_FRESH_MS = 60 * 60 * 1000; // 60 minutes

const DENY_REASON =
  "diffquiz auto mode: quiz the author on this diff before pushing. Run the diffquiz skill (3 quick questions, wrong answers only get explained — nothing is gated), which records a quiz marker, then re-run this exact command. If no human is present to answer, switch off auto mode with /diffquiz:ondemand instead of answering on their behalf.";

await main();

async function main() {
  try {
    await run();
  } catch {
    // Anything unanticipated — fail open. A quiz helper must never be able
    // to break someone's git workflow.
    allow();
  }
}

async function run() {
  const raw = await readStdin();
  const input = JSON.parse(raw); // malformed stdin -> throws -> outer catch -> allow

  if (input.tool_name !== "Bash") return allow();

  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== "string" || command.length === 0) return allow();

  if (!PUSH_RE.test(command) && !PR_CREATE_RE.test(command)) return allow();

  if (readMode() !== "auto") return allow();

  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  let root;
  let head;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git repo, git missing, no commits yet, etc. -> allow.
    return allow();
  }

  if (isMarkerFresh(root, head)) return allow();

  deny(DENY_REASON);
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// user-global config (mode)
// ---------------------------------------------------------------------------

function resolveConfigPath() {
  const explicit = process.env.DIFFQUIZ_CONFIG;
  if (explicit && explicit.trim() !== "") return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "diffquiz", "config.json");
  return join(homedir(), ".config", "diffquiz", "config.json");
}

/**
 * Returns the configured mode, or undefined for anything short of a
 * cleanly-readable `{"mode": "auto"}` — missing file, unreadable file,
 * malformed JSON, or a non-string/unexpected value all collapse to
 * "not auto", i.e. allow. This mirrors the fail-open contract: a broken
 * config must never itself become the reason a push gets blocked.
 */
function readMode() {
  try {
    const configPath = resolveConfigPath();
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    if (config && typeof config === "object" && typeof config.mode === "string") {
      return config.mode;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// quiz marker (loop breaker)
// ---------------------------------------------------------------------------

function resolveCacheDir() {
  const explicit = process.env.DIFFQUIZ_CACHE_DIR;
  if (explicit && explicit.trim() !== "") return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, "diffquiz");
  return join(homedir(), ".cache", "diffquiz");
}

function markerPathFor(repoRoot) {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(resolveCacheDir(), `quizzed-${hash}`);
}

/**
 * A missing marker, unreadable marker, malformed marker, wrong-HEAD marker,
 * or stale marker are all "not fresh" -> the caller denies. This is the one
 * place in the hook where a read failure does NOT mean allow — an absent
 * quiz marker is exactly the case auto mode exists to catch.
 */
function isMarkerFresh(repoRoot, head) {
  try {
    const raw = readFileSync(markerPathFor(repoRoot), "utf8");
    const marker = JSON.parse(raw);
    if (!marker || marker.head !== head) return false;
    const at = new Date(marker.at).getTime();
    if (!Number.isFinite(at)) return false;
    const ageMs = Date.now() - at;
    return ageMs >= 0 && ageMs < MARKER_FRESH_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// decision output
// ---------------------------------------------------------------------------

function allow() {
  // Silent allow: no stdout, exit 0. Setting exitCode (rather than calling
  // process.exit()) lets Node drain naturally so any buffered output is
  // flushed rather than risking truncation.
  process.exitCode = 0;
}

function deny(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exitCode = 0;
}
