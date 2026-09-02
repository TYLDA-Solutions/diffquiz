/**
 * Configuration loading.
 *
 * Trust model (security-critical — see docs/SECURITY notes / audit fix):
 * repo-committed `.diffquiz.json` is attacker-controlled the moment a
 * hostile repo is checked out, so it must never be able to make diffquiz
 * execute arbitrary code on the user's machine. Precedence, ascending
 * (later wins):
 *
 *   (a) user-global config — path from `DIFFQUIZ_CONFIG`, else
 *       `$XDG_CONFIG_HOME/diffquiz/config.json`, else
 *       `~/.config/diffquiz/config.json`. This file is under the user's own
 *       control, so ALL keys are honored, including `customCommand` and
 *       `provider: "custom"`.
 *   (b) repo-root `.diffquiz.json` — all keys honored EXCEPT
 *       `customCommand` (ignored) and `provider: "custom"` (ignored; other
 *       provider values are fine). A checked-out repo must not be able to
 *       make diffquiz spawn an arbitrary command. A one-line warning is
 *       written to stderr when either is stripped.
 *   (c) environment variables — `DIFFQUIZ_*`, including
 *       `DIFFQUIZ_CUSTOM_COMMAND` (a JSON array of argv strings).
 *
 * CLI flags are merged on top of this by cli.ts — this module returns
 * file+env only.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DiffQuizError, type DiffQuizConfig } from "./types.ts";

const CONFIG_FILENAME = ".diffquiz.json";
const VALID_PROVIDERS = new Set(["claude", "codex", "auto", "custom"]);
const REPO_CUSTOM_COMMAND_WARNING =
  "ignoring customCommand from repo .diffquiz.json — configure custom providers in ~/.config/diffquiz/config.json or DIFFQUIZ_CUSTOM_COMMAND";
const REPO_CUSTOM_PROVIDER_WARNING =
  'ignoring provider "custom" from repo .diffquiz.json — configure custom providers in ~/.config/diffquiz/config.json or DIFFQUIZ_CUSTOM_COMMAND';

export async function loadConfig(cwd: string): Promise<DiffQuizConfig> {
  const root = await findRepoRoot(cwd);
  const globalConfig = await readGlobalConfigFile(globalConfigPath(process.env));
  const repoConfig = await readRepoConfigFile(root);
  const config: DiffQuizConfig = { ...globalConfig, ...repoConfig };
  applyEnvOverrides(config, process.env);
  return config;
}

// ---------------------------------------------------------------------------
// repo root discovery
// ---------------------------------------------------------------------------

async function findRepoRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  for (;;) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd); // no ancestor had .git; best effort
    dir = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// global (user-controlled) config file — all keys allowed
// ---------------------------------------------------------------------------

function globalConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.DIFFQUIZ_CONFIG;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== "") return join(xdg, "diffquiz", "config.json");
  return join(homedir(), ".config", "diffquiz", "config.json");
}

async function readGlobalConfigFile(filePath: string): Promise<DiffQuizConfig> {
  const parsed = await readJsonConfigFile(filePath, filePath);
  if (parsed === undefined) return {};
  return validateConfigObject(parsed, filePath);
}

// ---------------------------------------------------------------------------
// repo-root config file — customCommand / provider:"custom" stripped
// ---------------------------------------------------------------------------

async function readRepoConfigFile(root: string): Promise<DiffQuizConfig> {
  const filePath = join(root, CONFIG_FILENAME);
  const parsed = await readJsonConfigFile(filePath, CONFIG_FILENAME);
  if (parsed === undefined) return {};
  const config = validateConfigObject(parsed, CONFIG_FILENAME);
  stripRepoOnlyKeys(config);
  return config;
}

function stripRepoOnlyKeys(config: DiffQuizConfig): void {
  if (config.customCommand !== undefined) {
    delete config.customCommand;
    process.stderr.write(`${REPO_CUSTOM_COMMAND_WARNING}\n`);
  }
  if (config.provider === "custom") {
    delete config.provider;
    process.stderr.write(`${REPO_CUSTOM_PROVIDER_WARNING}\n`);
  }
}

// ---------------------------------------------------------------------------
// shared file loading + validation
// ---------------------------------------------------------------------------

/** Returns `undefined` when the file does not exist (ENOENT). */
async function readJsonConfigFile(filePath: string, source: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return undefined;
    throw new DiffQuizError("BAD_CONFIG", `Could not read ${filePath}: ${(err as Error).message}`, filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DiffQuizError("BAD_CONFIG", `Invalid JSON in ${source}: ${(err as Error).message}`, source);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiffQuizError("BAD_CONFIG", `${source} must contain a JSON object.`, source);
  }

  return parsed as Record<string, unknown>;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function validateConfigObject(obj: Record<string, unknown>, source: string): DiffQuizConfig {
  const config: DiffQuizConfig = {};

  if ("provider" in obj) {
    const v = obj.provider;
    if (typeof v !== "string" || !VALID_PROVIDERS.has(v)) {
      throw new DiffQuizError(
        "BAD_CONFIG",
        `"provider" in ${source} must be one of: ${[...VALID_PROVIDERS].join(", ")}.`,
        "provider",
      );
    }
    config.provider = v;
  }

  if ("model" in obj) {
    const v = obj.model;
    if (typeof v !== "string" || v.trim() === "") {
      throw new DiffQuizError("BAD_CONFIG", `"model" in ${source} must be a non-empty string.`, "model");
    }
    config.model = v;
  }

  if ("questions" in obj) {
    const v = obj.questions;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 3 || v > 5) {
      throw new DiffQuizError("BAD_CONFIG", `"questions" in ${source} must be an integer between 3 and 5.`, "questions");
    }
    config.questions = v;
  }

  if ("maxLines" in obj) {
    const v = obj.maxLines;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new DiffQuizError("BAD_CONFIG", `"maxLines" in ${source} must be a positive integer.`, "maxLines");
    }
    config.maxLines = v;
  }

  if ("secretScan" in obj) {
    const v = obj.secretScan;
    if (typeof v !== "boolean") {
      throw new DiffQuizError("BAD_CONFIG", `"secretScan" in ${source} must be a boolean.`, "secretScan");
    }
    config.secretScan = v;
  }

  if ("timeoutSeconds" in obj) {
    const v = obj.timeoutSeconds;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new DiffQuizError("BAD_CONFIG", `"timeoutSeconds" in ${source} must be a positive number.`, "timeoutSeconds");
    }
    config.timeoutSeconds = v;
  }

  if ("language" in obj) {
    const v = obj.language;
    if (typeof v !== "string" || v.trim() === "") {
      throw new DiffQuizError("BAD_CONFIG", `"language" in ${source} must be a non-empty string.`, "language");
    }
    config.language = v;
  }

  if ("customCommand" in obj) {
    const v = obj.customCommand;
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
      throw new DiffQuizError(
        "BAD_CONFIG",
        `"customCommand" in ${source} must be a non-empty array of non-empty strings.`,
        "customCommand",
      );
    }
    config.customCommand = v as string[];
  }

  // Unknown keys are intentionally ignored for forward compatibility.
  return config;
}

// ---------------------------------------------------------------------------
// env overrides
// ---------------------------------------------------------------------------

function applyEnvOverrides(config: DiffQuizConfig, env: NodeJS.ProcessEnv): void {
  const provider = env.DIFFQUIZ_PROVIDER;
  if (provider !== undefined) {
    if (!VALID_PROVIDERS.has(provider)) {
      throw new DiffQuizError(
        "BAD_CONFIG",
        `DIFFQUIZ_PROVIDER must be one of: ${[...VALID_PROVIDERS].join(", ")}.`,
        "DIFFQUIZ_PROVIDER",
      );
    }
    config.provider = provider;
  }

  const model = env.DIFFQUIZ_MODEL;
  if (model !== undefined) {
    if (model.trim() === "") {
      throw new DiffQuizError("BAD_CONFIG", "DIFFQUIZ_MODEL must not be empty.", "DIFFQUIZ_MODEL");
    }
    config.model = model;
  }

  const questions = env.DIFFQUIZ_QUESTIONS;
  if (questions !== undefined) {
    const n = Number(questions);
    if (!Number.isInteger(n) || n < 3 || n > 5) {
      throw new DiffQuizError("BAD_CONFIG", "DIFFQUIZ_QUESTIONS must be an integer between 3 and 5.", "DIFFQUIZ_QUESTIONS");
    }
    config.questions = n;
  }

  const maxLines = env.DIFFQUIZ_MAX_LINES;
  if (maxLines !== undefined) {
    const n = Number(maxLines);
    if (!Number.isInteger(n) || n <= 0) {
      throw new DiffQuizError("BAD_CONFIG", "DIFFQUIZ_MAX_LINES must be a positive integer.", "DIFFQUIZ_MAX_LINES");
    }
    config.maxLines = n;
  }

  const timeout = env.DIFFQUIZ_TIMEOUT;
  if (timeout !== undefined) {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new DiffQuizError("BAD_CONFIG", "DIFFQUIZ_TIMEOUT must be a positive number.", "DIFFQUIZ_TIMEOUT");
    }
    config.timeoutSeconds = n;
  }

  const lang = env.DIFFQUIZ_LANG;
  if (lang !== undefined) {
    if (lang.trim() === "") {
      throw new DiffQuizError("BAD_CONFIG", "DIFFQUIZ_LANG must not be empty.", "DIFFQUIZ_LANG");
    }
    config.language = lang;
  }

  const customCommand = env.DIFFQUIZ_CUSTOM_COMMAND;
  if (customCommand !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(customCommand);
    } catch {
      throw new DiffQuizError(
        "BAD_CONFIG",
        "DIFFQUIZ_CUSTOM_COMMAND must be a JSON array of argv strings.",
        "DIFFQUIZ_CUSTOM_COMMAND",
      );
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string" && x.length > 0)) {
      throw new DiffQuizError(
        "BAD_CONFIG",
        "DIFFQUIZ_CUSTOM_COMMAND must be a non-empty JSON array of non-empty strings.",
        "DIFFQUIZ_CUSTOM_COMMAND",
      );
    }
    config.customCommand = parsed as string[];
  }
}
