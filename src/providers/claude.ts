/**
 * Claude Code CLI provider.
 *
 * Flags verified against `claude --help` / `claude -p --help` on
 * Claude Code 2.1.121:
 *   -p, --print                 non-interactive, print-and-exit
 *   --output-format json        single-result JSON envelope (print-mode only)
 *   --model <model>              model override
 *   --tools <tools...>          "" disables all built-in tools — used here so
 *                                quiz generation can't read/edit the repo, it
 *                                only ever sees the prompt we hand it
 *   --strict-mcp-config         only use MCP servers from --mcp-config
 *                                (none passed here), ignoring all other MCP
 *                                configuration sources — confirmed present
 *                                in `claude --help` output.
 *   --setting-sources user      only load settings from the user's own
 *                                config, never from the target repo's
 *                                project/local settings — confirmed present
 *                                in `claude --help` output.
 *
 * The JSON envelope (confirmed via a live smoke call) looks like:
 *   { "type": "result", "subtype": "success" | ..., "is_error": boolean,
 *     "result": "<completion text>", ... }
 * The completion text is always in `result`. On envelope parse failure we
 * fall back to treating stdout as plain text, per spec.
 *
 * cwd isolation (security fix): the diff being quizzed comes from a repo the
 * user is about to run diffquiz against, which may be untrusted (e.g. a
 * cloned PR branch). `-p` mode skips Claude Code's interactive workspace
 * trust dialog, and if this subprocess ran with the target repo as its cwd,
 * a hostile repo could ship a `.mcp.json` or `.claude/settings.json` that
 * gets picked up automatically. We run the subprocess with cwd pinned to a
 * throwaway empty temp directory instead, so nothing in the target repo can
 * configure or influence this invocation — the process never sees anything
 * beyond the prompt we hand it on stdin.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, commandExists } from "../exec.ts";
import { DiffQuizError, type CompleteOptions, type Provider } from "../types.ts";

const CLAUDE_BIN = "claude";
const STDERR_EXCERPT_MAX = 300;

/** Exported for unit tests — argv construction only, no execution. */
export function buildClaudeArgs(opts: { model?: string }): string[] {
  const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "user"];
  if (opts.model !== undefined && opts.model.length > 0) {
    args.push("--model", opts.model);
  }
  return args;
}

interface ClaudeResultEnvelope {
  result?: unknown;
}

/** Exported for unit tests — parses a captured stdout string in isolation. */
export function parseClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && "result" in parsed) {
      const result = (parsed as ClaudeResultEnvelope).result;
      if (typeof result === "string") return result;
    }
  } catch {
    // Not a JSON envelope — fall back to treating stdout as plain text.
  }
  return stdout;
}

function trimmedExcerpt(text: string, max: number): string {
  const collapsed = text.trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Runs `fn` with a fresh, empty temp directory as its working context,
 * cleaning it up afterward regardless of success or failure. See the
 * cwd-isolation rationale in the file header comment.
 */
async function withIsolatedCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "diffquiz-claude-cwd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const claudeProvider: Provider = {
  name: "claude",

  async available(): Promise<boolean> {
    return commandExists(CLAUDE_BIN);
  },

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const args = buildClaudeArgs(opts.model !== undefined ? { model: opts.model } : {});

    return withIsolatedCwd(async (cwd) => {
      const res = await runCommand(CLAUDE_BIN, args, {
        stdin: prompt,
        timeoutMs: opts.timeoutMs,
        cwd,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new DiffQuizError(
          "PROVIDER_FAILED",
          `Failed to run "claude": ${message}`,
          "Install it with `npm i -g @anthropic-ai/claude-code` and run `claude auth login`.",
        );
      });

      if (res.code !== 0) {
        const excerptSource = res.stderr.trim().length > 0 ? res.stderr : res.stdout;
        throw new DiffQuizError(
          "PROVIDER_FAILED",
          `claude exited with code ${res.code}.`,
          trimmedExcerpt(excerptSource, STDERR_EXCERPT_MAX),
        );
      }

      return parseClaudeOutput(res.stdout);
    });
  },
};
