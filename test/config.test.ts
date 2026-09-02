import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { DiffQuizError } from "../src/types.ts";

const ENV_KEYS = [
  "DIFFQUIZ_PROVIDER",
  "DIFFQUIZ_MODEL",
  "DIFFQUIZ_QUESTIONS",
  "DIFFQUIZ_MAX_LINES",
  "DIFFQUIZ_TIMEOUT",
  "DIFFQUIZ_LANG",
  "DIFFQUIZ_CUSTOM_COMMAND",
  "DIFFQUIZ_CONFIG",
  "XDG_CONFIG_HOME",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffquiz-config-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

/**
 * Runs `fn` with a clean env AND `DIFFQUIZ_CONFIG` pointed at a guaranteed
 * non-existent path inside a fresh temp dir, so the new user-global config
 * layer resolves to `{}` deterministically — tests never touch the real
 * `~/.config/diffquiz/config.json` on the machine running them. Tests that
 * want to exercise the global layer override `DIFFQUIZ_CONFIG` themselves.
 */
async function withCleanEnv(fn: () => Promise<void>): Promise<void> {
  const snap = snapshotEnv();
  clearEnv();
  const envTmp = mkdtempSync(join(tmpdir(), "diffquiz-config-env-"));
  process.env.DIFFQUIZ_CONFIG = join(envTmp, "does-not-exist.json");
  try {
    await fn();
  } finally {
    rmSync(envTmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
}

/** Captures everything written to stderr while `fn` runs. */
async function withCapturedStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let output = "";
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    const cb = rest.find((a) => typeof a === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

test("loads config file from repo root", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      join(root, ".diffquiz.json"),
      JSON.stringify({ provider: "claude", model: "opus", questions: 4, maxLines: 500, secretScan: false }),
    );

    const config = await loadConfig(root);
    assert.deepEqual(config, {
      provider: "claude",
      model: "opus",
      questions: 4,
      maxLines: 500,
      secretScan: false,
    });
  });
});

test("finds config file from a nested working directory (nearest ancestor with .git)", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ language: "de" }));
    const nested = join(root, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    const config = await loadConfig(nested);
    assert.deepEqual(config, { language: "de" });
  });
});

test("missing config file returns {}", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const config = await loadConfig(root);
    assert.deepEqual(config, {});
  });
});

test("unknown keys are ignored without error", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      join(root, ".diffquiz.json"),
      JSON.stringify({ provider: "codex", someFutureKey: { nested: true }, another: [1, 2, 3] }),
    );

    const config = await loadConfig(root);
    assert.deepEqual(config, { provider: "codex" });
    assert.equal("someFutureKey" in config, false);
  });
});

test("invalid JSON throws BAD_CONFIG", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), "{ not valid json");

    await assert.rejects(
      () => loadConfig(root),
      (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_CONFIG",
    );
  });
});

test("non-object JSON (array) throws BAD_CONFIG", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify([1, 2, 3]));

    await assert.rejects(
      () => loadConfig(root),
      (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_CONFIG",
    );
  });
});

const invalidFileCases: Array<{ name: string; value: unknown }> = [
  { name: "bad provider string", value: { provider: "chatgpt" } },
  { name: "questions out of range (too low)", value: { questions: 2 } },
  { name: "questions out of range (too high)", value: { questions: 6 } },
  { name: "questions not an integer", value: { questions: 3.5 } },
  { name: "maxLines not positive", value: { maxLines: 0 } },
  { name: "maxLines not a number", value: { maxLines: "2000" } },
  { name: "secretScan not boolean", value: { secretScan: "yes" } },
  { name: "timeoutSeconds not positive", value: { timeoutSeconds: -5 } },
  { name: "language empty string", value: { language: "" } },
  { name: "customCommand empty array", value: { customCommand: [] } },
  { name: "customCommand non-string entries", value: { customCommand: ["llm", 5] } },
  { name: "model empty string", value: { model: "" } },
];

for (const { name, value } of invalidFileCases) {
  test(`config validation error: ${name}`, async (t) => {
    await withCleanEnv(async () => {
      const root = makeRepoRoot();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, ".diffquiz.json"), JSON.stringify(value));

      await assert.rejects(
        () => loadConfig(root),
        (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_CONFIG",
      );
    });
  });
}

test("env overrides win over file values", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ provider: "claude", questions: 3, maxLines: 100 }));

    process.env.DIFFQUIZ_PROVIDER = "codex";
    process.env.DIFFQUIZ_QUESTIONS = "5";
    process.env.DIFFQUIZ_MODEL = "gpt-5";
    process.env.DIFFQUIZ_MAX_LINES = "999";
    process.env.DIFFQUIZ_TIMEOUT = "60";
    process.env.DIFFQUIZ_LANG = "de";

    const config = await loadConfig(root);
    assert.deepEqual(config, {
      provider: "codex",
      questions: 5,
      model: "gpt-5",
      maxLines: 999,
      timeoutSeconds: 60,
      language: "de",
    });
  });
});

test("env overrides apply even with no config file present", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    process.env.DIFFQUIZ_PROVIDER = "auto";
    const config = await loadConfig(root);
    assert.deepEqual(config, { provider: "auto" });
  });
});

const invalidEnvCases: Array<{ name: string; env: Record<string, string> }> = [
  { name: "bad DIFFQUIZ_PROVIDER", env: { DIFFQUIZ_PROVIDER: "not-a-provider" } },
  { name: "non-numeric DIFFQUIZ_QUESTIONS", env: { DIFFQUIZ_QUESTIONS: "abc" } },
  { name: "DIFFQUIZ_QUESTIONS out of range", env: { DIFFQUIZ_QUESTIONS: "10" } },
  { name: "non-numeric DIFFQUIZ_MAX_LINES", env: { DIFFQUIZ_MAX_LINES: "lots" } },
  { name: "negative DIFFQUIZ_MAX_LINES", env: { DIFFQUIZ_MAX_LINES: "-1" } },
  { name: "non-numeric DIFFQUIZ_TIMEOUT", env: { DIFFQUIZ_TIMEOUT: "never" } },
  { name: "empty DIFFQUIZ_LANG", env: { DIFFQUIZ_LANG: "" } },
  { name: "empty DIFFQUIZ_MODEL", env: { DIFFQUIZ_MODEL: "" } },
];

for (const { name, env } of invalidEnvCases) {
  test(`config env validation error: ${name}`, async (t) => {
    await withCleanEnv(async () => {
      const root = makeRepoRoot();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      for (const [k, v] of Object.entries(env)) process.env[k] = v;

      await assert.rejects(
        () => loadConfig(root),
        (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_CONFIG",
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Trust model: repo .diffquiz.json cannot supply customCommand or
// provider:"custom" (arbitrary code execution on checkout+run).
// ---------------------------------------------------------------------------

test("repo file customCommand is ignored, with a warning to stderr", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      join(root, ".diffquiz.json"),
      JSON.stringify({ provider: "codex", customCommand: ["rm", "-rf", "/tmp/whatever"] }),
    );

    let config: Awaited<ReturnType<typeof loadConfig>> = {};
    const stderr = await withCapturedStderr(async () => {
      config = await loadConfig(root);
    });

    assert.deepEqual(config, { provider: "codex" });
    assert.equal("customCommand" in config, false);
    assert.ok(stderr.includes("ignoring customCommand from repo .diffquiz.json"));
    assert.ok(stderr.includes("DIFFQUIZ_CUSTOM_COMMAND"));
  });
});

test('repo file provider:"custom" is ignored, with a warning to stderr', async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ provider: "custom", questions: 4 }));

    let config: Awaited<ReturnType<typeof loadConfig>> = {};
    const stderr = await withCapturedStderr(async () => {
      config = await loadConfig(root);
    });

    assert.deepEqual(config, { questions: 4 });
    assert.equal("provider" in config, false);
    assert.ok(stderr.toLowerCase().includes('ignoring provider "custom" from repo .diffquiz.json'));
  });
});

test("repo file with other provider values (not custom) is honored normally", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ provider: "claude" }));

    const stderr = await withCapturedStderr(async () => {
      const config = await loadConfig(root);
      assert.deepEqual(config, { provider: "claude" });
    });
    assert.equal(stderr, "");
  });
});

test("global user config honors customCommand and provider:custom", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const globalDir = mkdtempSync(join(tmpdir(), "diffquiz-global-"));
    t.after(() => rmSync(globalDir, { recursive: true, force: true }));
    const globalPath = join(globalDir, "config.json");
    writeFileSync(globalPath, JSON.stringify({ provider: "custom", customCommand: ["llm", "-m", "gpt-5"] }));
    process.env.DIFFQUIZ_CONFIG = globalPath;

    const config = await loadConfig(root);
    assert.deepEqual(config, { provider: "custom", customCommand: ["llm", "-m", "gpt-5"] });
  });
});

test("DIFFQUIZ_CONFIG override is honored as the global config path", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const globalDir = mkdtempSync(join(tmpdir(), "diffquiz-global-"));
    t.after(() => rmSync(globalDir, { recursive: true, force: true }));
    const globalPath = join(globalDir, "somewhere-custom.json");
    writeFileSync(globalPath, JSON.stringify({ language: "fr" }));
    process.env.DIFFQUIZ_CONFIG = globalPath;

    const config = await loadConfig(root);
    assert.deepEqual(config, { language: "fr" });
  });
});

test("repo config overrides global config for shared keys; global fills in the rest", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ model: "repo-model" }));

    const globalDir = mkdtempSync(join(tmpdir(), "diffquiz-global-"));
    t.after(() => rmSync(globalDir, { recursive: true, force: true }));
    const globalPath = join(globalDir, "config.json");
    writeFileSync(globalPath, JSON.stringify({ model: "global-model", language: "de", customCommand: ["llm"] }));
    process.env.DIFFQUIZ_CONFIG = globalPath;

    const config = await loadConfig(root);
    // repo overrides "model"; repo doesn't set "language" so global's wins;
    // repo doesn't set customCommand at all here so global's (allowed at
    // that layer) is not stripped — it was never subject to repo stripping.
    assert.deepEqual(config, { model: "repo-model", language: "de", customCommand: ["llm"] });
  });
});

test("env wins over both global and repo config", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ model: "repo-model" }));

    const globalDir = mkdtempSync(join(tmpdir(), "diffquiz-global-"));
    t.after(() => rmSync(globalDir, { recursive: true, force: true }));
    const globalPath = join(globalDir, "config.json");
    writeFileSync(globalPath, JSON.stringify({ model: "global-model", customCommand: ["global-llm"] }));
    process.env.DIFFQUIZ_CONFIG = globalPath;

    process.env.DIFFQUIZ_MODEL = "env-model";
    process.env.DIFFQUIZ_CUSTOM_COMMAND = JSON.stringify(["env-llm", "-m", "x"]);

    const config = await loadConfig(root);
    assert.deepEqual(config, { model: "env-model", customCommand: ["env-llm", "-m", "x"] });
  });
});

test("DIFFQUIZ_CUSTOM_COMMAND: valid JSON array is honored", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    process.env.DIFFQUIZ_CUSTOM_COMMAND = JSON.stringify(["gemini", "-m", "flash"]);
    const config = await loadConfig(root);
    assert.deepEqual(config, { customCommand: ["gemini", "-m", "flash"] });
  });
});

const invalidCustomCommandEnvCases: Array<{ name: string; value: string }> = [
  { name: "not valid JSON", value: "not json at all" },
  { name: "JSON object instead of array", value: JSON.stringify({ cmd: "llm" }) },
  { name: "empty array", value: JSON.stringify([]) },
  { name: "array with a non-string entry", value: JSON.stringify(["llm", 5]) },
  { name: "array with an empty string entry", value: JSON.stringify(["llm", ""]) },
];

for (const { name, value } of invalidCustomCommandEnvCases) {
  test(`DIFFQUIZ_CUSTOM_COMMAND validation error: ${name}`, async (t) => {
    await withCleanEnv(async () => {
      const root = makeRepoRoot();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      process.env.DIFFQUIZ_CUSTOM_COMMAND = value;

      await assert.rejects(
        () => loadConfig(root),
        (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_CONFIG",
      );
    });
  });
}
