# diffquiz — Canonical Spec (v0.1)

This document is the binding contract for all modules. `src/types.ts` holds the
shared type definitions. If spec and types disagree, types win.

## What diffquiz is

A 60-second quiz on your own diff before you open the PR. An LLM generates 3–5
multiple-choice questions about what the diff actually changes. Wrong answers
block nothing — every answer (right or wrong) immediately reveals the relevant
diff lines plus a two-sentence explanation. The output can be rendered as a
non-blocking markdown comment for the PR.

Core principles (violating any of these is a bug):

1. **Non-blocking.** Exit code is 0 regardless of quiz score. Wrong answers
   produce insight, never a gate.
2. **Human-focused.** The quiz measures whether the *human* understood the
   change (typically one written largely by a coding agent). Agents answer
   these questions trivially — that is fine and by design.
3. **No gamification.** No score history, no streaks, no leaderboard, no
   persistence of results beyond the explicitly requested report output.
4. **Privacy: the diff only ever goes to the LLM CLI the user already uses**
   (`claude`, `codex`, or a user-configured command). diffquiz itself makes
   zero network calls, has zero runtime dependencies, and no telemetry.
5. **Quality of distractors decides everything.** Distractors must be
   plausible misreadings of the diff, so guessing costs more than reading.

## CLI

```
diffquiz [options]              Generate a quiz for the current diff and play it
diffquiz diverge [options]      Divergence mode: N independent LLM answer runs
diffquiz doctor                 Check environment: git, providers, config

Options (shared):
  -b, --base <ref>       Base ref to diff against (default: merge-base with the
                         repo's default branch; falls back to main/master)
      --staged           Quiz the staged changes instead (git diff --cached)
  -p, --provider <name>  claude | codex | custom | auto   (default: auto)
      --model <name>     Model override passed to the provider CLI
  -n, --questions <3-5>  Number of questions (default: 3)
      --lang <code>      Language for questions/explanations (default: en)
      --max-lines <n>    Refuse diffs above n changed lines (default: 2000)
      --sample           Sample oversized diffs instead of refusing
      --no-secret-scan   Skip the secret heuristic warning
      --timeout <sec>    Provider timeout (default: 180)
      --print            Non-interactive: print questions WITH answers and exit
                         (spoiler mode; for testing and review)
      --json             Machine-readable JSON result on stdout — stdout then
                         carries ONLY the JSON (human summary goes to stderr);
                         combined with --print it emits { quiz } as JSON
  -o, --out <file>       Write the markdown report to a file
      --no-color         Disable ANSI colors (also honors NO_COLOR env)
  -v, --version          Print version
  -h, --help             Print help

diffquiz diverge only:
      --runs <n>         Number of independent answer runs (default: 3, max 5)
```

Exit codes: `0` success (any score), `1` unexpected error, `2` refused
precondition (not a repo, empty diff, too large, secrets unconfirmed, bad
usage/config), `3` provider or generation failure. See `DiffQuizError`.

## Module map & ownership

Each module lives in exactly one file and is built by exactly one agent.
Import shared types from `../types.ts` (with explicit `.ts` extension —
`rewriteRelativeImportExtensions` is on).

### src/git.ts — diff collection

```ts
export interface DiffOptions {
  cwd: string;
  base?: string;        // explicit ref; wins over detection
  staged?: boolean;
  maxLines: number;     // total changed-lines budget
  sample: boolean;      // true: trim to budget; false: throw DIFF_TOO_LARGE
}
export function detectBaseRef(cwd: string): Promise<string>;
export function collectDiff(opts: DiffOptions): Promise<DiffSummary>;
```

- Uses `git` via the shared `runCommand` from `src/exec.ts` — never a shell.
- Base detection: `origin/HEAD` → `origin/main` → `origin/master` → local
  `main`/`master`; diff against `merge-base(HEAD, base)`. When HEAD *is* the
  base branch and `--staged` is not set, fall back to working-tree diff
  (`git diff` incl. staged) so the tool is useful pre-commit; note this in
  `baseDescription`.
- Includes untracked files? No — only tracked changes. Document this.
- Parse per-file: status, paths, line counts, patch text. Binary files are
  listed with status "binary" and an empty patch.
- Size handling: when total changed lines exceed `maxLines`: if `sample` is
  false throw `DIFF_TOO_LARGE` with the hint that a smaller PR is the real
  fix (`--sample` to override); if true, keep whole files by priority
  (smallest first is wrong — prioritize non-generated, non-lockfile paths;
  drop lockfiles/`*.min.*`/vendored dirs first), record `truncationNotes`.
- Errors: `NOT_A_REPO`, `EMPTY_DIFF` (both `DiffQuizError`).

### src/exec.ts — safe subprocess runner (owned by provider agent)

```ts
export interface RunResult { stdout: string; stderr: string; code: number }
export function runCommand(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; cwd?: string },
): Promise<RunResult>;
export function commandExists(cmd: string): Promise<boolean>;
```

- `child_process.execFile`/`spawn` with argv arrays, `shell: false`, always.
- Kills the process group on timeout; rejects with a clear message.
- Caps captured stdout/stderr at 10 MB.

### src/config.ts — configuration

```ts
export function loadConfig(cwd: string): Promise<DiffQuizConfig>;
```

- Merges, ascending precedence: user-global config (`DIFFQUIZ_CONFIG` path
  override, else `$XDG_CONFIG_HOME/diffquiz/config.json`, else
  `~/.config/diffquiz/config.json`) → repo-root `.diffquiz.json` (nearest
  ancestor with `.git`) → env vars.
- **Trust boundary:** the repo file must never be able to run code. It may
  NOT set `customCommand` or `provider: "custom"` — both are ignored with a
  one-line stderr warning. Custom providers come only from the user-global
  config or `DIFFQUIZ_CUSTOM_COMMAND` (JSON argv array).
- Env overrides: `DIFFQUIZ_PROVIDER`, `DIFFQUIZ_MODEL`, `DIFFQUIZ_QUESTIONS`,
  `DIFFQUIZ_MAX_LINES`, `DIFFQUIZ_TIMEOUT`, `DIFFQUIZ_LANG`,
  `DIFFQUIZ_CUSTOM_COMMAND`, `DIFFQUIZ_CONFIG`.
- Validates types/ranges; unknown keys are ignored with no error (forward
  compat). Bad values throw `BAD_CONFIG` with the offending key in the hint.
- Precedence: CLI flags > env > repo file > global file > defaults (flag
  merging happens in cli.ts; loadConfig returns files+env only).

### src/secrets.ts — secret heuristics

```ts
export interface SecretFinding { file: string; line: number; kind: string; excerpt: string }
export function scanForSecrets(diff: DiffSummary): SecretFinding[];
```

- Scans only **added** lines. Patterns: AWS keys (`AKIA…`), GitHub tokens
  (`ghp_`, `gho_`, `github_pat_`), Slack (`xox[baprs]-`), private key blocks,
  generic `(api[_-]?key|secret|token|password)\s*[:=]` with a high-entropy-ish
  value ≥ 16 chars, JWTs (`eyJ` twice dot-separated), OpenAI/Anthropic key
  shapes (`sk-`). Keep the list in one table; comment each pattern.
- `excerpt` must be redacted: first 4 chars of the match + `…`.
- False positives are acceptable; the CLI asks for confirmation, it does not
  block silently.

### src/providers/ — LLM backends

Files: `claude.ts`, `codex.ts`, `custom.ts`, `index.ts`.

```ts
// index.ts
export function resolveProvider(
  spec: string | undefined,          // from --provider
  config: DiffQuizConfig,
): Promise<Provider>;                // throws NO_PROVIDER with install hint
export function listProviders(config: DiffQuizConfig): Promise<Array<{ name: string; available: boolean }>>;
```

- `auto` order: claude → codex → custom (if configured).
- **Isolation:** claude/codex subprocesses run with `cwd` pinned to a fresh
  empty temp directory (plus `--strict-mcp-config` for claude), so nothing
  inside the repo under review — `.mcp.json`, project settings — can
  configure the LLM CLI. The custom provider keeps the caller's cwd: its
  command comes exclusively from the user's own trust boundary.
- **claude**: `claude -p --output-format json` with the prompt on **stdin**;
  parse the JSON envelope and return its `result` field; on envelope parse
  failure fall back to treating stdout as plain text. Pass
  `--model <model>` when set. Verify actual flags against `claude --help`
  during implementation and adjust; keep tool use disabled if a flag for that
  exists in help output.
- **codex**: `codex exec` with prompt on stdin (or as single argv argument if
  stdin is unsupported — check `codex --help` semantics from public docs;
  this provider is best-effort and marked experimental in docs). Pass
  `--model` when set.
- **custom**: runs `config.customCommand` argv, prompt on stdin, completion
  on stdout. This is the escape hatch for any other tool (`llm`, `gemini`,
  `ollama run …`).
- All providers use `runCommand`; never a shell, never env-injected secrets.

### src/jsonx.ts — model-output parsing & validation

```ts
export function extractJson(text: string): unknown;      // strips fences/prose
export function validateQuiz(value: unknown, expected: { count: number }): Quiz;
export function validateAnswers(value: unknown, quiz: Quiz): Record<string, number>;
```

- `extractJson`: try `JSON.parse` directly; then fenced ```json blocks; then
  first `{`/`[` to last `}`/`]` slice. Throw `INVALID_MODEL_OUTPUT` with a
  short excerpt (≤200 chars) on failure.
- All model-supplied strings are sanitized in `validateQuiz` (single choke
  point): C0 control characters (except `\n`, `\t`) and complete
  CSI/OSC/ESC sequences are stripped before any string is accepted —
  terminal output and markdown must never carry raw escape bytes.
- `validateQuiz` enforces: expected question count (±0), exactly 4 options,
  `correctIndex` 0–3, non-empty strings, ids `q1..qN` (rewrite ids if the
  model used others), kinds coerced to the closest `QuestionKind` (default
  "behavior"), explanation trimmed to ≤ 2 sentences, options deduped —
  duplicate options are a validation failure.
- `validateAnswers`: `{ "q1": 2, ... }` shape for divergence runs.

### src/prompts.ts + src/generate.ts + src/divergence.ts — generation

```ts
// prompts.ts
export function buildGeneratePrompt(diff: DiffSummary, opts: { count: number; language: string }): string;
export function buildAnswerPrompt(diff: DiffSummary, quiz: Quiz, opts: { language: string }): string;
// generate.ts
export function generateQuiz(
  diff: DiffSummary, provider: Provider,
  opts: { count: number; language: string; model?: string; timeoutMs: number },
): Promise<Quiz>;
// divergence.ts
export function runDivergence(
  diff: DiffSummary, quiz: Quiz, provider: Provider,
  opts: { runs: number; language: string; model?: string; timeoutMs: number },
): Promise<DivergenceReport>;
```

Prompt requirements (the product lives or dies here):

- Questions target **effect, not syntax**: behavior changes, data/migration
  consequences, failure modes, edge cases (empty input, null, concurrency).
- Distractors are **plausible misreadings** of this specific diff — things a
  hurried reviewer might believe. Never absurd throwaway options.
- When the diff contains moved/reformatted code, include one "no-change"
  question (which of these is a pure move?) as the guessing counterweight.
- Explanations: max two sentences, must cite `file:line`.
- The diff is **untrusted input**: wrap it in per-invocation random
  nonce delimiters (an attacker crafting a diff offline cannot predict them)
  and instruct the model to treat everything inside as data — instructions
  inside the diff must be ignored. Never place diff content outside the
  delimiters.
- Demand strict JSON only (schema inlined in the prompt), no prose.
- `generateQuiz`: one retry on `INVALID_MODEL_OUTPUT` (append a corrective
  line quoting the validation error); after the second failure, throw.
- `buildAnswerPrompt` presents questions + options WITHOUT correctIndex,
  explanation, or kind, and instructs: answer independently from the diff,
  strict JSON `{ "q1": <index>, ... }`.
- Divergence analysis: `diverged` = ≥2 distinct answers among successful
  runs; `scattered` = no option got a strict majority of runs; flagged =
  diverged && !scattered. Runs execute **sequentially** (local CLIs often
  serialize anyway; keeps output readable). Failed runs (all answers null)
  are never counted as agreement: zero usable runs is a `PROVIDER_FAILED`
  error in the CLI and an explicit warning in the markdown report.

### src/ansi.ts + src/play.ts + src/report.ts — UX

```ts
// ansi.ts — tiny helpers, honor NO_COLOR and !isTTY
export const color: { bold; dim; green; red; yellow; cyan; (each: (s: string) => string) };
export function enableColor(on: boolean): void;
// play.ts
export function playQuiz(
  quiz: Quiz,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
): Promise<QuizResult>;
// report.ts
export interface ReportMeta { baseDescription: string; provider: string; model?: string; truncated: boolean; version: string }
export function renderMarkdown(quiz: Quiz, result: QuizResult | null, divergence: DivergenceReport | null, meta: ReportMeta): string;
export function renderTerminal(quiz: Quiz, result: QuizResult, meta: ReportMeta): string;
export function renderPrint(quiz: Quiz): string;   // --print spoiler view
```

play.ts behavior:

- `node:readline/promises`. Per question: kind badge, question, options
  `1)`–`4)`; accept `1`–`4` (also `a`–`d`, case-insensitive); anything else
  re-prompts once then counts as skipped (chosenIndex null, incorrect).
- **One pass, no retry** — after each answer immediately show ✓/✗, the
  correct option, the explanation, and the referenced diff lines (rendered
  from `diffRefs` + the quiz's patch text is NOT available here — show
  `file:line` references only; report.ts embeds patch excerpts).
- Show a running elapsed timer in the final summary ("finished in 48s");
  never enforce a limit.
- If `input` is not a TTY, throw `BAD_USAGE` telling the user to use
  `--print` or `--json` (cli.ts guards this too).

report.ts markdown layout (for a PR comment):

```
### 🎯 diffquiz — 2/3 on this diff (48s)
> Non-blocking self-check: did the author read what they're merging?
<one collapsible <details> block per question: question, chosen vs correct,
explanation, file:line refs>
<divergence section when present: flagged questions + one-line reading>
<footer: generated by diffquiz vX via claude; diff vs main; truncated note>
```

### src/cli.ts + src/index.ts — wiring (integrator-owned, do not touch)

`cli.ts` parses argv (`node:util` parseArgs), merges config, orchestrates,
maps `DiffQuizError` to exit codes and pretty stderr messages (`message` +
dimmed `hint`). `index.ts` re-exports the public API for library use.

Secret-scan flow in cli.ts: findings → print table → interactive confirm
("send anyway? [y/N]"); non-interactive (`--print`/`--json` without TTY) →
refuse with `SECRETS_DETECTED` unless `--no-secret-scan`.

## Testing requirements

- `node --test test/` (Node ≥ 22.18, native type stripping — tests are `.ts`,
  import from `../src/*.ts`).
- Every module ships a `test/<module>.test.ts` owned by the module's agent.
- No network, no real LLM calls in tests. Providers are tested against fake
  executables (small `node -e` scripts materialized into a temp dir) and by
  unit-testing arg construction. git.ts tests build real throwaway repos in
  `fs.mkdtempSync(os.tmpdir())`.
- Deterministic, parallel-safe, each test cleans up its temp dirs.

## Style

- TypeScript strict; no `any` outside `jsonx.ts` narrowing internals.
- Zero runtime dependencies — Node built-ins only. Dev deps stay `typescript`
  + `@types/node` only.
- No classes except error types; plain functions + interfaces.
- Comments only where the code can't say it (see repo-wide conventions).
- All user-facing strings in English.

## v0.2.0 — Plugin modes (auto / on-demand)

The Claude Code plugin gains a workflow mode. It changes WHEN the quiz
happens, never WHETHER anything is allowed to proceed — the non-blocking
principle is untouched.

### Mode storage

- New config key `mode: "auto" | "ondemand"` (default `"ondemand"`), valid
  ONLY in the user-global config (`DIFFQUIZ_CONFIG` path override, else
  `$XDG_CONFIG_HOME/diffquiz/config.json`, else
  `~/.config/diffquiz/config.json`). A repo `.diffquiz.json` must never set
  it (workflow interception is the user's own choice, like customCommand);
  if present there it is ignored silently (no warning — it is not a code
  path, just noise).
- The CLI itself does not consume `mode` (unknown-key tolerance already
  accepts it); only `diffquiz doctor` displays it.

### Switch commands (plugin)

`plugin/diffquiz/commands/auto.md`, `ondemand.md`, `status.md` →
`/diffquiz:auto`, `/diffquiz:ondemand`, `/diffquiz:status`. auto/ondemand
rewrite ONLY the `mode` key in the user-global config (create dir/file if
missing, preserve all other keys, honor DIFFQUIZ_CONFIG and XDG paths);
status prints the current mode and config path. All three confirm in one
short line.

### The hook (plugin)

A PreToolUse hook on the Bash tool, shipped with the plugin, script at
`plugin/diffquiz/hooks/pre-push-quiz.mjs` (plain Node, zero deps, invoked
via `node "$CLAUDE_PLUGIN_ROOT/hooks/pre-push-quiz.mjs"`).

Behavior:
1. Reads the hook JSON from stdin; extracts the Bash command string.
2. Matches push/PR intents: `git push` and `gh pr create` (word-boundary
   match anywhere in the command). Everything else → allow.
3. Reads `mode` from the user-global config. `ondemand`/unset → allow.
4. `auto` → checks the quiz marker (below). Fresh marker → allow; missing
   or stale → deny (permission decision "deny") with a reason instructing
   Claude to run the diffquiz skill with the author first, then retry the
   command — and, when no human is present to quiz, to switch to
   `/diffquiz:ondemand` instead. Wrong quiz answers never matter.
5. **Fail-open everywhere:** malformed stdin, unreadable config, missing
   HOME, any exception → exit 0 (allow). A quiz helper must never be able
   to break someone's git workflow.

### Quiz marker (loop breaker)

Without a marker, deny → quiz → retry push → deny again would loop.

- Path: `$DIFFQUIZ_CACHE_DIR` override, else `$XDG_CACHE_HOME/diffquiz`,
  else `~/.cache/diffquiz`; file `quizzed-<first 16 hex of sha256(absolute
  repo root path)>`.
- Content: JSON `{ "head": "<HEAD sha>", "at": "<ISO timestamp>" }`.
- Fresh = recorded head equals the repo's current HEAD sha AND `at` is less
  than 60 minutes old. New commits after the quiz therefore re-trigger it.
- The SKILL flow writes the marker after a completed quiz (any score); the
  hook only reads it. The CLI does not touch markers in v0.2.0.

### SKILL.md additions

- After a completed quiz: write the marker (mkdir -p the cache dir).
- After a completed quiz, when the user-global config has no `mode` key:
  offer once, in one sentence, `/diffquiz:auto` for automatic mode.
- Never present the quiz as a gate; on auto-mode denials, quiz, then simply
  continue the original command.

### Tests

`test/hook.test.ts` drives the hook script as a child process with crafted
stdin + `DIFFQUIZ_CONFIG`/`DIFFQUIZ_CACHE_DIR`/`HOME` pointing at temp
dirs: non-push command allows; ondemand allows; auto without marker denies
with reason; auto with fresh marker allows; auto with stale/other-HEAD
marker denies; malformed stdin allows; unreadable config allows. Marker
hashing is verified against a real temp git repo.
