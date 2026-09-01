#!/usr/bin/env node
/**
 * diffquiz CLI entry point: argument parsing, config merging, orchestration.
 * All domain logic lives in the modules this file wires together.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

import { DiffQuizError, type DiffQuizConfig, type DiffSummary, type Provider } from "./types.ts";
import { collectDiff } from "./git.ts";
import { loadConfig } from "./config.ts";
import { scanForSecrets } from "./secrets.ts";
import { resolveProvider, listProviders } from "./providers/index.ts";
import { generateQuiz } from "./generate.ts";
import { runDivergence } from "./divergence.ts";
import { playQuiz } from "./play.ts";
import { renderMarkdown, renderTerminal, renderPrint, type ReportMeta } from "./report.ts";
import { color, enableColor } from "./ansi.ts";
import { commandExists } from "./exec.ts";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const HELP = `diffquiz ${VERSION} — a 60-second quiz on your own diff before you open the PR.

Usage:
  diffquiz [options]              Generate a quiz for the current diff and play it
  diffquiz diverge [options]      Divergence mode: N independent LLM answer runs
  diffquiz doctor                 Check environment: git, providers, config

Options:
  -b, --base <ref>       Base ref to diff against (default: auto-detected)
      --staged           Quiz the staged changes (git diff --cached)
  -p, --provider <name>  claude | codex | custom | auto (default: auto)
      --model <name>     Model override passed to the provider CLI
  -n, --questions <3-5>  Number of questions (default: 3)
      --lang <code>      Language for questions/explanations (default: en)
      --max-lines <n>    Refuse diffs above n changed lines (default: 2000)
      --sample           Sample oversized diffs instead of refusing
      --no-secret-scan   Skip the secret heuristic warning
      --timeout <sec>    Provider timeout in seconds (default: 180)
      --print            Non-interactive: print questions WITH answers and exit
      --json             Machine-readable JSON result on stdout
  -o, --out <file>       Write the markdown report to a file
      --runs <n>         diverge only: independent answer runs (default: 3, max 5)
      --no-color         Disable ANSI colors (also honors NO_COLOR)
  -v, --version          Print version
  -h, --help             Print this help

diffquiz never blocks: the exit code is 0 whatever your score.
Your diff is sent only to the local LLM CLI you already use (claude, codex,
or a configured custom command). diffquiz itself makes no network calls.
`;

interface CliOptions {
  command: "play" | "diverge" | "doctor";
  base: string | undefined;
  staged: boolean;
  provider: string | undefined;
  model: string | undefined;
  questions: number;
  language: string;
  maxLines: number;
  sample: boolean;
  secretScan: boolean;
  timeoutMs: number;
  print: boolean;
  json: boolean;
  out: string | undefined;
  runs: number;
}

function parseIntOption(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new DiffQuizError("BAD_USAGE", `Invalid value for ${name}: "${value}"`, `Expected an integer between ${min} and ${max}.`);
  }
  return n;
}

function parseCli(argv: string[], config: DiffQuizConfig): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      base: { type: "string", short: "b" },
      staged: { type: "boolean", default: false },
      provider: { type: "string", short: "p" },
      model: { type: "string" },
      questions: { type: "string", short: "n" },
      lang: { type: "string" },
      "max-lines": { type: "string" },
      sample: { type: "boolean", default: false },
      "secret-scan": { type: "boolean", default: true },
      timeout: { type: "string" },
      print: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      runs: { type: "string" },
      color: { type: "boolean", default: true },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  let command: CliOptions["command"] = "play";
  const sub = positionals[0];
  if (sub === "diverge") command = "diverge";
  else if (sub === "doctor") command = "doctor";
  else if (sub !== undefined) {
    throw new DiffQuizError("BAD_USAGE", `Unknown command "${sub}"`, "Run diffquiz --help for usage.");
  }

  enableColor(values.color && !process.env["NO_COLOR"] && process.stdout.isTTY === true);

  return {
    command,
    base: values.base,
    staged: values.staged,
    provider: values.provider ?? config.provider,
    model: values.model ?? config.model,
    questions: parseIntOption(values.questions, "--questions", 3, 5, config.questions ?? 3),
    language: values.lang ?? config.language ?? "en",
    maxLines: parseIntOption(values["max-lines"], "--max-lines", 50, 100000, config.maxLines ?? 2000),
    sample: values.sample,
    secretScan: values["secret-scan"] && (config.secretScan ?? true),
    timeoutMs: parseIntOption(values.timeout, "--timeout", 10, 3600, config.timeoutSeconds ?? 180) * 1000,
    print: values.print,
    json: values.json,
    out: values.out,
    runs: parseIntOption(values.runs, "--runs", 2, 5, 3),
  };
}

async function confirmSecrets(diff: DiffSummary, opts: CliOptions): Promise<void> {
  if (!opts.secretScan) return;
  const findings = scanForSecrets(diff);
  if (findings.length === 0) return;

  process.stderr.write(color.yellow(`\n⚠ Possible secrets in this diff (${findings.length}):\n`));
  for (const f of findings.slice(0, 10)) {
    process.stderr.write(`  ${f.file}:${f.line}  ${f.kind}  ${color.dim(f.excerpt)}\n`);
  }
  if (findings.length > 10) process.stderr.write(color.dim(`  … and ${findings.length - 10} more\n`));

  if (!process.stdin.isTTY) {
    throw new DiffQuizError(
      "SECRETS_DETECTED",
      "Refusing to send a diff that may contain secrets (non-interactive).",
      "Review the findings, or re-run with --no-secret-scan to override.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question("Send this diff to the LLM anyway? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    throw new DiffQuizError("SECRETS_DETECTED", "Aborted: diff not sent.", "Remove the secrets from the diff, then re-run.");
  }
}

async function prepare(opts: CliOptions, cwd: string): Promise<{ diff: DiffSummary; provider: Provider }> {
  const config = await loadConfig(cwd);
  const diff = await collectDiff({
    cwd,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.staged ? { staged: true } : {}),
    maxLines: opts.maxLines,
    sample: opts.sample,
  });
  await confirmSecrets(diff, opts);
  const provider = await resolveProvider(opts.provider, config);
  return { diff, provider };
}

function meta(diff: DiffSummary, provider: Provider, opts: CliOptions): ReportMeta {
  return {
    baseDescription: diff.baseDescription,
    provider: provider.name,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    truncated: diff.truncated,
    version: VERSION,
  };
}

async function runPlay(opts: CliOptions, cwd: string): Promise<void> {
  if (!opts.print && !process.stdin.isTTY) {
    throw new DiffQuizError(
      "BAD_USAGE",
      "Interactive quiz needs a terminal.",
      "Use --print to see questions with answers, or run diffquiz in a TTY.",
    );
  }

  const { diff, provider } = await prepare(opts, cwd);
  process.stderr.write(color.dim(`Generating ${opts.questions} questions via ${provider.name} (${diff.baseDescription})…\n`));
  const quiz = await generateQuiz(diff, provider, {
    count: opts.questions,
    language: opts.language,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    timeoutMs: opts.timeoutMs,
  });

  if (opts.print) {
    process.stdout.write(renderPrint(quiz));
    if (opts.out !== undefined) {
      await writeFile(opts.out, renderMarkdown(quiz, null, null, meta(diff, provider, opts)), "utf8");
      process.stderr.write(color.dim(`Markdown report written to ${opts.out}\n`));
    }
    return;
  }

  let result;
  try {
    result = await playQuiz(quiz, { input: process.stdin, output: process.stdout });
  } catch (err) {
    // Ctrl+C/Ctrl+D mid-quiz is a legitimate way out of a non-blocking tool.
    if (err instanceof Error && (err.name === "AbortError" || ("code" in err && err.code === "ABORT_ERR"))) {
      process.stderr.write("\nQuiz aborted — nothing recorded.\n");
      return;
    }
    throw err;
  }
  process.stdout.write(renderTerminal(quiz, result, meta(diff, provider, opts)));

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ quiz, result }, null, 2)}\n`);
  }
  if (opts.out !== undefined) {
    await writeFile(opts.out, renderMarkdown(quiz, result, null, meta(diff, provider, opts)), "utf8");
    process.stderr.write(color.dim(`Markdown report written to ${opts.out}\n`));
  }
}

async function runDiverge(opts: CliOptions, cwd: string): Promise<void> {
  const { diff, provider } = await prepare(opts, cwd);
  process.stderr.write(color.dim(`Generating ${opts.questions} questions via ${provider.name} (${diff.baseDescription})…\n`));
  const quiz = await generateQuiz(diff, provider, {
    count: opts.questions,
    language: opts.language,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    timeoutMs: opts.timeoutMs,
  });

  process.stderr.write(color.dim(`Running ${opts.runs} independent answer passes…\n`));
  const divergence = await runDivergence(diff, quiz, provider, {
    runs: opts.runs,
    language: opts.language,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    timeoutMs: opts.timeoutMs,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ quiz, divergence }, null, 2)}\n`);
  } else {
    const flagged = divergence.flaggedQuestionIds;
    process.stdout.write(renderPrint(quiz));
    if (flagged.length === 0) {
      process.stdout.write(color.green(`\nNo divergence across ${opts.runs} runs — the change reads unambiguously.\n`));
    } else {
      process.stdout.write(color.yellow(`\nDivergence on ${flagged.length} question(s): ${flagged.join(", ")}\n`));
      process.stdout.write("Where independent readers disagree, the change is ambiguous or underspecified.\n");
    }
  }
  if (opts.out !== undefined) {
    await writeFile(opts.out, renderMarkdown(quiz, null, divergence, meta(diff, provider, opts)), "utf8");
    process.stderr.write(color.dim(`Markdown report written to ${opts.out}\n`));
  }
}

async function runDoctor(cwd: string): Promise<void> {
  const lines: string[] = [`diffquiz ${VERSION}`];
  lines.push(`git: ${(await commandExists("git")) ? color.green("found") : color.red("missing")}`);

  let config: DiffQuizConfig = {};
  try {
    config = await loadConfig(cwd);
    lines.push("config: ok");
  } catch (err) {
    lines.push(`config: ${color.red(err instanceof Error ? err.message : String(err))}`);
  }
  for (const p of await listProviders(config)) {
    lines.push(`provider ${p.name}: ${p.available ? color.green("available") : color.dim("not found")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  let opts: CliOptions;
  try {
    opts = parseCli(process.argv.slice(2), await loadConfig(cwd));
  } catch (err) {
    if (err instanceof DiffQuizError) throw err;
    throw new DiffQuizError("BAD_USAGE", err instanceof Error ? err.message : String(err), "Run diffquiz --help for usage.");
  }

  switch (opts.command) {
    case "play":
      await runPlay(opts, cwd);
      break;
    case "diverge":
      await runDiverge(opts, cwd);
      break;
    case "doctor":
      await runDoctor(cwd);
      break;
  }
}

main().catch((err: unknown) => {
  if (err instanceof DiffQuizError) {
    process.stderr.write(`${color.red("error:")} ${err.message}\n`);
    if (err.hint !== undefined) process.stderr.write(color.dim(`hint: ${err.hint}\n`));
    process.exit(err.exitCode);
  }
  process.stderr.write(`${color.red("unexpected error:")} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
