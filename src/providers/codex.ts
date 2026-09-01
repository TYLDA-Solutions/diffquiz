/**
 * OpenAI Codex CLI provider.
 *
 * `codex` is NOT installed on the machine this was built on, so these flags
 * are best-effort from public documentation of `codex exec` (Codex CLI's
 * non-interactive automation subcommand) and are marked experimental in the
 * docs. Verify against a real `codex --help` before relying on this in
 * production.
 *
 * Per the repo-wide hard rule, the prompt always goes over stdin — never as
 * an argv value — even though some public examples show `codex exec
 * "<prompt>"` as a positional argument. Argv leaks into process listings and
 * diffs can be arbitrarily large, so stdin is the only supported path here.
 */
import { runCommand, commandExists } from "../exec.ts";
import { DiffQuizError, type CompleteOptions, type Provider } from "../types.ts";

const CODEX_BIN = "codex";
const STDERR_EXCERPT_MAX = 300;

/** Exported for unit tests — argv construction only, no execution. */
export function buildCodexArgs(opts: { model?: string }): string[] {
  const args = ["exec"];
  if (opts.model !== undefined && opts.model.length > 0) {
    args.push("--model", opts.model);
  }
  return args;
}

function trimmedExcerpt(text: string, max: number): string {
  const collapsed = text.trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export const codexProvider: Provider = {
  name: "codex",

  async available(): Promise<boolean> {
    return commandExists(CODEX_BIN);
  },

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const args = buildCodexArgs(opts.model !== undefined ? { model: opts.model } : {});

    const res = await runCommand(CODEX_BIN, args, {
      stdin: prompt,
      timeoutMs: opts.timeoutMs,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new DiffQuizError(
        "PROVIDER_FAILED",
        `Failed to run "codex": ${message}`,
        "Install it with `npm i -g @openai/codex` and run `codex login`.",
      );
    });

    if (res.code !== 0) {
      const excerptSource = res.stderr.trim().length > 0 ? res.stderr : res.stdout;
      throw new DiffQuizError(
        "PROVIDER_FAILED",
        `codex exited with code ${res.code}.`,
        trimmedExcerpt(excerptSource, STDERR_EXCERPT_MAX),
      );
    }

    return res.stdout;
  },
};
