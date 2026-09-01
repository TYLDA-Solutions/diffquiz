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

async function withCleanEnv(fn: () => Promise<void>): Promise<void> {
  const snap = snapshotEnv();
  clearEnv();
  try {
    await fn();
  } finally {
    restoreEnv(snap);
  }
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

test("customCommand array of strings loads correctly", async (t) => {
  await withCleanEnv(async () => {
    const root = makeRepoRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, ".diffquiz.json"), JSON.stringify({ customCommand: ["llm", "-m", "gpt-5"] }));

    const config = await loadConfig(root);
    assert.deepEqual(config, { customCommand: ["llm", "-m", "gpt-5"] });
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
