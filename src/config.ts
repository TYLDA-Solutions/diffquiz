/**
 * Configuration loading: `.diffquiz.json` at the repo root, overridden by
 * `DIFFQUIZ_*` environment variables. CLI flags are merged on top of this by
 * cli.ts — this module returns file+env only.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DiffQuizError, type DiffQuizConfig } from "./types.ts";

const CONFIG_FILENAME = ".diffquiz.json";
const VALID_PROVIDERS = new Set(["claude", "codex", "auto", "custom"]);

export async function loadConfig(cwd: string): Promise<DiffQuizConfig> {
  const root = await findRepoRoot(cwd);
  const config = await readConfigFile(root);
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
// file loading + validation
// ---------------------------------------------------------------------------

async function readConfigFile(root: string): Promise<DiffQuizConfig> {
  const filePath = join(root, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return {};
    throw new DiffQuizError("BAD_CONFIG", `Could not read ${filePath}: ${(err as Error).message}`, filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DiffQuizError("BAD_CONFIG", `Invalid JSON in ${CONFIG_FILENAME}: ${(err as Error).message}`, CONFIG_FILENAME);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiffQuizError("BAD_CONFIG", `${CONFIG_FILENAME} must contain a JSON object.`, CONFIG_FILENAME);
  }

  return validateConfigObject(parsed as Record<string, unknown>, CONFIG_FILENAME);
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
}
