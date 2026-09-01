/**
 * Provider registry & resolution.
 *
 * `auto` order is claude → codex → custom (if configured) — the first
 * available one wins. An explicit `--provider` name must both exist and be
 * available, or resolution fails with `NO_PROVIDER`.
 */
import { DiffQuizError, type DiffQuizConfig, type Provider } from "../types.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { createCustomProvider } from "./custom.ts";

const AUTO_ORDER = ["claude", "codex", "custom"] as const;

const INSTALL_HINT =
  "Install `claude` (npm i -g @anthropic-ai/claude-code) or `codex` (npm i -g @openai/codex), " +
  "or configure `customCommand` in .diffquiz.json for another LLM CLI.";

function buildProviders(config: DiffQuizConfig): Provider[] {
  const providers: Provider[] = [claudeProvider, codexProvider];
  if (config.customCommand !== undefined && config.customCommand.length > 0) {
    providers.push(createCustomProvider(config.customCommand));
  }
  return providers;
}

/** Lists every known provider (custom only when configured) with live availability. */
export async function listProviders(
  config: DiffQuizConfig,
): Promise<Array<{ name: string; available: boolean }>> {
  const providers = buildProviders(config);
  const results: Array<{ name: string; available: boolean }> = [];
  for (const provider of providers) {
    results.push({ name: provider.name, available: await provider.available() });
  }
  return results;
}

/**
 * Resolves the provider to use for this run. `spec` (from `--provider`)
 * takes precedence over `config.provider`; both default to "auto".
 * Throws `NO_PROVIDER` (with an install hint) when the requested provider is
 * unknown, unavailable, or — for "auto" — nothing on the machine is usable.
 */
export async function resolveProvider(
  spec: string | undefined,
  config: DiffQuizConfig,
): Promise<Provider> {
  const requested = spec ?? config.provider ?? "auto";
  const providers = buildProviders(config);

  if (requested === "auto") {
    for (const provider of providers) {
      if (await provider.available()) return provider;
    }
    throw new DiffQuizError(
      "NO_PROVIDER",
      "No LLM provider is available on this machine.",
      INSTALL_HINT,
    );
  }

  if (!(AUTO_ORDER as readonly string[]).includes(requested)) {
    throw new DiffQuizError(
      "NO_PROVIDER",
      `Unknown provider "${requested}" (expected one of: ${AUTO_ORDER.join(", ")}, auto).`,
      INSTALL_HINT,
    );
  }

  const match = providers.find((provider) => provider.name === requested);
  if (match === undefined) {
    // Only reachable for "custom" when it isn't configured — buildProviders
    // omits it entirely rather than returning an always-unavailable stub.
    throw new DiffQuizError(
      "NO_PROVIDER",
      `Provider "${requested}" is not configured.`,
      requested === "custom"
        ? "Set `customCommand` (argv array) in .diffquiz.json."
        : INSTALL_HINT,
    );
  }

  if (!(await match.available())) {
    throw new DiffQuizError(
      "NO_PROVIDER",
      `Provider "${requested}" is not available on this machine.`,
      INSTALL_HINT,
    );
  }

  return match;
}
