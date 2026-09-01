/**
 * Custom provider — the escape hatch for any other LLM CLI (`llm`,
 * `gemini`, `ollama run …`). Runs `config.customCommand` as argv, prompt on
 * stdin, completion read from stdout.
 */
import { runCommand, commandExists } from "../exec.ts";
import { DiffQuizError, type CompleteOptions, type Provider } from "../types.ts";

const STDERR_EXCERPT_MAX = 300;

function trimmedExcerpt(text: string, max: number): string {
  const collapsed = text.trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Builds a Provider that runs `command` (argv, first element is the binary). */
export function createCustomProvider(command: readonly string[]): Provider {
  const bin = command[0];
  const args = command.slice(1);

  return {
    name: "custom",

    async available(): Promise<boolean> {
      if (bin === undefined) return false;
      return commandExists(bin);
    },

    async complete(prompt: string, opts: CompleteOptions): Promise<string> {
      if (bin === undefined) {
        throw new DiffQuizError(
          "NO_PROVIDER",
          "No custom provider command is configured.",
          "Set `customCommand` (argv array) in .diffquiz.json, e.g. [\"llm\", \"-m\", \"gpt-5\"].",
        );
      }

      const res = await runCommand(bin, args, {
        stdin: prompt,
        timeoutMs: opts.timeoutMs,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new DiffQuizError(
          "PROVIDER_FAILED",
          `Failed to run custom provider "${bin}": ${message}`,
          "Check `customCommand` in .diffquiz.json points at an installed, executable command.",
        );
      });

      if (res.code !== 0) {
        const excerptSource = res.stderr.trim().length > 0 ? res.stderr : res.stdout;
        throw new DiffQuizError(
          "PROVIDER_FAILED",
          `Custom provider "${bin}" exited with code ${res.code}.`,
          trimmedExcerpt(excerptSource, STDERR_EXCERPT_MAX),
        );
      }

      return res.stdout;
    },
  };
}
