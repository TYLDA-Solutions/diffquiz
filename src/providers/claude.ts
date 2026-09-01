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
 *
 * The JSON envelope (confirmed via a live smoke call) looks like:
 *   { "type": "result", "subtype": "success" | ..., "is_error": boolean,
 *     "result": "<completion text>", ... }
 * The completion text is always in `result`. On envelope parse failure we
 * fall back to treating stdout as plain text, per spec.
 */
import { runCommand, commandExists } from "../exec.ts";
import { DiffQuizError, type CompleteOptions, type Provider } from "../types.ts";

const CLAUDE_BIN = "claude";
const STDERR_EXCERPT_MAX = 300;

/** Exported for unit tests — argv construction only, no execution. */
export function buildClaudeArgs(opts: { model?: string }): string[] {
  const args = ["-p", "--output-format", "json", "--tools", ""];
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

export const claudeProvider: Provider = {
  name: "claude",

  async available(): Promise<boolean> {
    return commandExists(CLAUDE_BIN);
  },

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const args = buildClaudeArgs(opts.model !== undefined ? { model: opts.model } : {});

    const res = await runCommand(CLAUDE_BIN, args, {
      stdin: prompt,
      timeoutMs: opts.timeoutMs,
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
  },
};
