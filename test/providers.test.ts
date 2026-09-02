import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { buildClaudeArgs, parseClaudeOutput, claudeProvider } from "../src/providers/claude.ts";
import { buildCodexArgs, codexProvider } from "../src/providers/codex.ts";
import { createCustomProvider } from "../src/providers/custom.ts";
import { resolveProvider, listProviders } from "../src/providers/index.ts";
import { DiffQuizError, type DiffQuizConfig } from "../src/types.ts";

let dir: string;

function makeScript(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "diffquiz-providers-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claude.ts — argv construction & envelope parsing (unit-level, no execution)
// ---------------------------------------------------------------------------

describe("buildClaudeArgs", () => {
  const BASE_ARGS = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "user",
  ];

  test("print mode with JSON output, tools disabled, MCP/settings isolation, no model", () => {
    assert.deepEqual(buildClaudeArgs({}), BASE_ARGS);
  });

  test("appends --model when a model is given", () => {
    assert.deepEqual(buildClaudeArgs({ model: "sonnet" }), [...BASE_ARGS, "--model", "sonnet"]);
  });

  test("omits --model for an empty string model", () => {
    assert.deepEqual(buildClaudeArgs({ model: "" }), BASE_ARGS);
  });

  test("includes --strict-mcp-config and --setting-sources user (verified against `claude --help`)", () => {
    const args = buildClaudeArgs({});
    assert.ok(args.includes("--strict-mcp-config"));
    const idx = args.indexOf("--setting-sources");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "user");
  });
});

describe("parseClaudeOutput", () => {
  test("extracts the result field from the JSON envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"questions": []}',
    });
    assert.equal(parseClaudeOutput(stdout), '{"questions": []}');
  });

  test("falls back to plain text when stdout is not JSON", () => {
    const stdout = "this is not json at all";
    assert.equal(parseClaudeOutput(stdout), "this is not json at all");
  });

  test("falls back to plain text when JSON has no string result field", () => {
    const stdout = JSON.stringify({ type: "result", result: 42 });
    assert.equal(parseClaudeOutput(stdout), stdout);
  });

  test("returns empty string for empty stdout", () => {
    assert.equal(parseClaudeOutput("   "), "");
  });
});

// ---------------------------------------------------------------------------
// codex.ts — argv construction (unit-level, no execution; codex is not
// installed on this machine)
// ---------------------------------------------------------------------------

describe("buildCodexArgs", () => {
  test("exec subcommand, no model", () => {
    assert.deepEqual(buildCodexArgs({}), ["exec"]);
  });

  test("appends --model when given", () => {
    assert.deepEqual(buildCodexArgs({ model: "gpt-5-codex" }), ["exec", "--model", "gpt-5-codex"]);
  });
});

// ---------------------------------------------------------------------------
// claude.ts / codex.ts — cwd isolation (security fix): the subprocess must
// run with cwd pinned to a fresh empty temp dir, never the target repo's
// cwd, and that temp dir must be cleaned up afterward. Verified against fake
// `claude`/`codex` executables prepended onto PATH that just report their
// own process.cwd() back.
// ---------------------------------------------------------------------------

describe("claude/codex subprocess cwd isolation", () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalCwd: string;

  before(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "diffquiz-fakebin-"));
    originalPath = process.env["PATH"];
    process.env["PATH"] = [fakeBinDir, originalPath ?? ""].join(":");
    originalCwd = process.cwd();
  });

  after(() => {
    rmSync(fakeBinDir, { recursive: true, force: true });
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
  });

  test("claudeProvider.complete runs with cwd pinned to a fresh temp dir, cleaned up after", async () => {
    const script = join(fakeBinDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: process.cwd() }));
process.exit(0);
`,
      { mode: 0o755 },
    );

    const reportedCwd = await claudeProvider.complete("prompt", { timeoutMs: 5000 });

    assert.notEqual(reportedCwd, originalCwd, "claude subprocess ran with the test process's own cwd");
    assert.ok(
      reportedCwd.includes("diffquiz-claude-cwd-"),
      `expected an isolated diffquiz-claude-cwd- temp dir, got ${reportedCwd}`,
    );
    assert.equal(existsSync(reportedCwd), false, "isolated temp cwd was not cleaned up after the call");
  });

  test("codexProvider.complete runs with cwd pinned to a fresh temp dir, cleaned up after", async () => {
    const script = join(fakeBinDir, "codex");
    writeFileSync(
      script,
      `#!/usr/bin/env node
process.stdout.write(process.cwd());
process.exit(0);
`,
      { mode: 0o755 },
    );

    const reportedCwd = await codexProvider.complete("prompt", { timeoutMs: 5000 });

    assert.notEqual(reportedCwd, originalCwd, "codex subprocess ran with the test process's own cwd");
    assert.ok(
      reportedCwd.includes("diffquiz-codex-cwd-"),
      `expected an isolated diffquiz-codex-cwd- temp dir, got ${reportedCwd}`,
    );
    assert.equal(existsSync(reportedCwd), false, "isolated temp cwd was not cleaned up after the call");
  });

  test("isolated temp cwd is cleaned up even when the subprocess fails", async () => {
    const script = join(fakeBinDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env node
process.stderr.write(process.cwd());
process.exit(1);
`,
      { mode: 0o755 },
    );

    let capturedCwd = "";
    await assert.rejects(
      claudeProvider.complete("prompt", { timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DiffQuizError);
        capturedCwd = err.hint ?? "";
        return true;
      },
    );
    assert.ok(capturedCwd.includes("diffquiz-claude-cwd-"));
    assert.equal(existsSync(capturedCwd), false, "isolated temp cwd was not cleaned up after a failed call");
  });
});

// ---------------------------------------------------------------------------
// custom.ts — real execution against fake executables
// ---------------------------------------------------------------------------

describe("createCustomProvider — real execution", () => {
  test("sends the prompt on stdin and returns stdout", async () => {
    const script = makeScript(
      "echo-stdin.js",
      `const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  process.stdout.write(Buffer.concat(chunks).toString("utf8"));
  process.exit(0);
});`,
    );
    const provider = createCustomProvider([script]);
    assert.equal(await provider.available(), true);
    const result = await provider.complete("here is the diff\nwith multiple lines", {
      timeoutMs: 5000,
    });
    assert.equal(result, "here is the diff\nwith multiple lines");
  });

  test("does not leak the prompt via argv — only stdin carries it", async () => {
    // A script that ignores stdin and just reports its own argv; if the
    // provider ever put the prompt on argv this would see it.
    const script = makeScript(
      "argv-report.js",
      `process.stdout.write(JSON.stringify(process.argv.slice(2)));
process.exit(0);`,
    );
    const provider = createCustomProvider([script]);
    const result = await provider.complete("SECRET_PROMPT_CONTENT", { timeoutMs: 5000 });
    const argv = JSON.parse(result) as string[];
    assert.ok(!argv.some((a) => a.includes("SECRET_PROMPT_CONTENT")));
  });

  test("non-zero exit produces PROVIDER_FAILED with a trimmed stderr excerpt", async () => {
    const script = makeScript(
      "fail.js",
      `process.stderr.write("boom: something went wrong\\n");
process.exit(1);`,
    );
    const provider = createCustomProvider([script]);
    await assert.rejects(
      provider.complete("prompt", { timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DiffQuizError);
        assert.equal(err.code, "PROVIDER_FAILED");
        assert.ok(err.hint !== undefined && err.hint.includes("boom"));
        return true;
      },
    );
  });

  test("PROVIDER_FAILED stderr excerpt is capped at 300 chars", async () => {
    const longMessage = "e".repeat(1000);
    const script = makeScript(
      "fail-long.js",
      `process.stderr.write(${JSON.stringify(longMessage)});
process.exit(1);`,
    );
    const provider = createCustomProvider([script]);
    await assert.rejects(provider.complete("prompt", { timeoutMs: 5000 }), (err: unknown) => {
      assert.ok(err instanceof DiffQuizError);
      assert.ok(err.hint !== undefined);
      assert.ok(err.hint!.length <= 301); // 300 chars + ellipsis
      return true;
    });
  });

  test("timeout path rejects with PROVIDER_FAILED", async () => {
    const script = makeScript(
      "sleep.js",
      `setTimeout(() => process.exit(0), 5000);`,
    );
    const provider = createCustomProvider([script]);
    await assert.rejects(
      provider.complete("prompt", { timeoutMs: 150 }),
      (err: unknown) => {
        assert.ok(err instanceof DiffQuizError);
        assert.equal(err.code, "PROVIDER_FAILED");
        assert.ok(err.message.toLowerCase().includes("timed out"));
        return true;
      },
    );
  });

  test("unconfigured custom provider is unavailable and throws NO_PROVIDER", async () => {
    const provider = createCustomProvider([]);
    assert.equal(await provider.available(), false);
    await assert.rejects(
      provider.complete("prompt", { timeoutMs: 1000 }),
      (err: unknown) => err instanceof DiffQuizError && err.code === "NO_PROVIDER",
    );
  });
});

// ---------------------------------------------------------------------------
// index.ts — resolveProvider / listProviders
// ---------------------------------------------------------------------------

describe("resolveProvider / listProviders", () => {
  test("explicit unknown provider name throws NO_PROVIDER", async () => {
    await assert.rejects(
      resolveProvider("bogus", {}),
      (err: unknown) => err instanceof DiffQuizError && err.code === "NO_PROVIDER",
    );
  });

  test('explicit "custom" without customCommand configured throws NO_PROVIDER', async () => {
    await assert.rejects(
      resolveProvider("custom", {}),
      (err: unknown) => err instanceof DiffQuizError && err.code === "NO_PROVIDER",
    );
  });

  test('explicit "custom" with a working customCommand resolves', async () => {
    const script = makeScript(
      "echo-stdin-2.js",
      `const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => { process.stdout.write("ok"); process.exit(0); });`,
    );
    const config: DiffQuizConfig = { customCommand: [script] };
    const provider = await resolveProvider("custom", config);
    assert.equal(provider.name, "custom");
  });

  test("listProviders includes custom only when configured, in claude/codex/custom order", async () => {
    const withoutCustom = await listProviders({});
    assert.deepEqual(
      withoutCustom.map((p) => p.name),
      ["claude", "codex"],
    );

    const script = makeScript(
      "echo-stdin-3.js",
      `process.stdout.write("ok"); process.exit(0);`,
    );
    const withCustom = await listProviders({ customCommand: [script] });
    assert.deepEqual(
      withCustom.map((p) => p.name),
      ["claude", "codex", "custom"],
    );
  });

  describe("auto order with claude/codex forced unavailable via PATH", () => {
    let originalPath: string | undefined;

    before(() => {
      originalPath = process.env["PATH"];
      // Restrict PATH to just enough to still run node/sh/env (our fake
      // scripts use a `#!/usr/bin/env node` shebang) but excluding wherever
      // `claude` actually lives on this machine (e.g. /opt/homebrew/bin) —
      // so commandExists("claude"/"codex") resolves false. Absolute-path
      // commands (used by the custom provider) are unaffected by PATH.
      process.env["PATH"] = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
    });

    after(() => {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
    });

    test("claude/codex report unavailable when not on PATH", async () => {
      assert.equal(await claudeProvider.available(), false);
      assert.equal(await codexProvider.available(), false);
    });

    test("auto falls through to custom when claude/codex are unavailable", async () => {
      const script = makeScript(
        "echo-stdin-4.js",
        `process.stdout.write("ok"); process.exit(0);`,
      );
      const config: DiffQuizConfig = { customCommand: [script] };
      const provider = await resolveProvider(undefined, config);
      assert.equal(provider.name, "custom");
    });

    test("auto throws NO_PROVIDER with an install hint when nothing is available", async () => {
      await assert.rejects(
        resolveProvider(undefined, {}),
        (err: unknown) => {
          assert.ok(err instanceof DiffQuizError);
          assert.equal(err.code, "NO_PROVIDER");
          assert.ok(err.hint !== undefined && err.hint.length > 0);
          return true;
        },
      );
    });

    test('explicit provider="auto" in config.provider behaves the same as spec undefined', async () => {
      const script = makeScript(
        "echo-stdin-5.js",
        `process.stdout.write("ok"); process.exit(0);`,
      );
      const config: DiffQuizConfig = { provider: "auto", customCommand: [script] };
      const provider = await resolveProvider(undefined, config);
      assert.equal(provider.name, "custom");
    });
  });
});
