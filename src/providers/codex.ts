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
 *
 * cwd isolation (security fix): same rationale as claude.ts — the target
 * repo being quizzed may be untrusted, and running an LLM CLI subprocess
 * with that repo as its cwd risks the subprocess picking up repo-local
 * config it was never meant to see. We run codex with cwd pinned to a
 * throwaway empty temp directory instead.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Runs `fn` with a fresh, empty temp directory as its working context,
 * cleaning it up afterward regardless of success or failure. See the
 * cwd-isolation rationale in the file header comment.
 */
async function withIsolatedCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "diffquiz-codex-cwd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const codexProvider: Provider = {
  name: "codex",

  async available(): Promise<boolean> {
    return commandExists(CODEX_BIN);
  },

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const args = buildCodexArgs(opts.model !== undefined ? { model: opts.model } : {});

    return withIsolatedCwd(async (cwd) => {
      const res = await runCommand(CODEX_BIN, args, {
        stdin: prompt,
        timeoutMs: opts.timeoutMs,
        cwd,
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
    });
  },
};
