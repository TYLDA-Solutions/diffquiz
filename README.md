# diffquiz

**A 60-second quiz on your own diff before you open the PR.** 🎯

Coding agents write more code than humans read. diffquiz asks you 3-5
multiple-choice questions about what your change actually does. Wrong
answers block nothing — every answer immediately reveals the relevant lines
and a two-sentence explanation. It measures whether *you* understood the
change, not whether the change is correct.

> A question you can answer wrongly is the difference between a review and
> a checkbox.

## Why

Agents now generate a large share of the diffs humans are asked to approve,
and the honest failure mode isn't a bad diff — it's a human clicking
"Approve" on a diff they skimmed rather than read. Review theater looks
identical to review from the outside: same comment, same green checkmark,
same merged PR. diffquiz doesn't try to catch bad code; it gives the author
a private, 60-second way to find out whether they could explain their own
change before someone else has to ask.

## Quick start

Requires Node >= 22.18 and one of the `claude` or `codex` CLIs installed
(or a custom provider command configured in your own user-global config —
see [Configuration](#configuration)).

```
npm i -g diffquiz
```

Then, inside a git repository with uncommitted or unpushed changes:

```
diffquiz
```

### Sample session

Illustrative — the real questions depend entirely on your diff.

```
$ diffquiz
Generating 3 questions via claude (merge-base(HEAD, origin/main))…
diffquiz — 3 questions
Wrong answers just get explained — nothing here blocks you.

[behavior] Question 1/3
What happens when `parseConfig()` receives a config file with no
`provider` key?

  1) It throws BAD_CONFIG immediately
  2) It falls back to "auto" and continues
  3) It silently disables the secret scan
  4) It retries with the previous config

> 2
✓ Correct
`provider` is optional in DiffQuizConfig; when absent, resolveProvider()
falls back to the auto-detection order.
See: src/config.ts:34

[failure] Question 2/3
If the diff exceeds --max-lines and --sample was not passed, what does
diffquiz do?

  1) Truncates silently and continues
  2) Throws DIFF_TOO_LARGE and exits with code 2
  3) Sends only the file list to the provider
  4) Prompts interactively for confirmation

> 2
✓ Correct
Over-budget diffs without --sample throw DIFF_TOO_LARGE, with a hint that a
smaller PR is the real fix.
See: src/git.ts:96

[no-change] Question 3/3
Which of these best describes the change in `src/report.ts`?

  1) The markdown renderer logic changed
  2) `renderTerminal` was moved below `renderPrint` with no logic change
  3) A new report format was added
  4) The function signature changed

> 1
✗ Not quite — correct answer: `renderTerminal` was moved below
`renderPrint` with no logic change
This is a pure relocation; diff the reordered block against itself and the
bodies are identical.
See: src/report.ts:180-210

2/3 in 41s
diffquiz — 2/3 in 41s
✓ q1  ✓ q2  ✗ q3
via claude · diff vs merge-base(HEAD, origin/main)
```

Pass `-o report.md` to also write a markdown report for the PR description
(prints `Markdown report written to report.md` on stderr).

## How it works

1. Collects your diff (working tree, staged, or against a ref you choose)
   via `git`, never a shell — see [Configuration](#configuration) for the
   base-ref detection order.
2. Runs a heuristic secret scan over added lines and asks for confirmation
   before sending anything, unless disabled.
3. Sends the diff to the LLM CLI you already use (`claude`, `codex`, or a
   custom command) with a prompt that asks for 3-5 multiple-choice
   questions about the change's *effect*.
4. Plays the quiz in your terminal, one question at a time, revealing the
   answer and a two-sentence explanation immediately after each one.
5. Prints a summary and, if asked, writes a markdown report you can paste
   into the PR description.

**Exit codes are non-blocking by design:** `0` on success regardless of
quiz score, `1` for an unexpected error, `2` for a refused precondition (not
a repo, empty diff, diff too large, unconfirmed secrets, bad usage/config),
`3` for a provider or generation failure. No score, in any mode, ever
changes the exit code — diffquiz cannot fail a CI check based on how well
you did.

## Divergence mode

```
diffquiz diverge
```

Instead of asking you, `diverge` has N independent LLM runs (`--runs`,
default 3, max 5) answer the *same* questions the generator produced,
executed sequentially and without seeing each other's answers. Where the
runs disagree, the question is flagged — that disagreement is a signal
normal review doesn't produce: either the change is genuinely ambiguous, or
it's underspecified in a way a single reviewer is unlikely to notice on
their own. A question is flagged when at least two runs disagree
(`diverged`) *and* no single answer holds a strict majority (`scattered` is
the opposite case — that usually means the question itself is bad, not that
the code is unclear).

## Claude Code plugin

For a seamless in-session experience, diffquiz ships a Claude Code plugin
that skips the external LLM call entirely — Claude, already in your
session, writes and asks the questions.

```
claude plugin marketplace add TYLDA-Solutions/diffquiz
claude plugin install diffquiz@diffquiz
```

Then, inside a session: `/diffquiz:diffquiz`, or just ask Claude to "quiz me
on my diff before I open this PR." See
[`plugin/diffquiz/README.md`](./plugin/diffquiz/README.md) for details.

## Configuration

Precedence (highest wins): **CLI flags > environment variables > repo
`.diffquiz.json` > user-global config > defaults.**

### `.diffquiz.json` (repo, shareable)

Committed at the repo root (nearest ancestor containing `.git`) — safe to
check in, since it's meant to be shared with everyone who clones the repo:

```json
{
  "provider": "auto",
  "model": "claude-sonnet-4-5",
  "questions": 4,
  "maxLines": 2000,
  "secretScan": true,
  "timeoutSeconds": 180,
  "language": "en"
}
```

**Trust boundary:** the repo file can never configure a custom command.
`"provider": "custom"` and `"customCommand"` are silently ignored (with a
one-line stderr warning) when they come from `.diffquiz.json` — otherwise
cloning a hostile repo and running `diffquiz` in it could execute whatever
command the repo's author chose. Every other key above still works from the
repo file. Unknown keys are ignored (forward compatible); invalid values
throw with the offending key named in the error.

### User-global config / env (trusted: custom providers live here)

A custom provider command can only come from your own machine, never from a
cloned repo:

- **User-global config file** — a JSON file with the same shape as
  `.diffquiz.json`, plus `customCommand` and `"provider": "custom"`, which
  are only honored here. Location: the path in `DIFFQUIZ_CONFIG`, else
  `$XDG_CONFIG_HOME/diffquiz/config.json`, else
  `~/.config/diffquiz/config.json`.
- **`DIFFQUIZ_CUSTOM_COMMAND`** — a JSON array of argv strings, e.g.
  `DIFFQUIZ_CUSTOM_COMMAND='["llm","-m","gpt-5"]'`.

```json
// ~/.config/diffquiz/config.json
{
  "provider": "custom",
  "customCommand": ["llm", "-m", "gpt-5"]
}
```

### Environment variables

| Variable | Overrides |
|---|---|
| `DIFFQUIZ_PROVIDER` | `provider` |
| `DIFFQUIZ_MODEL` | `model` |
| `DIFFQUIZ_QUESTIONS` | `questions` |
| `DIFFQUIZ_MAX_LINES` | `maxLines` |
| `DIFFQUIZ_TIMEOUT` | `timeoutSeconds` |
| `DIFFQUIZ_LANG` | `language` |
| `DIFFQUIZ_CUSTOM_COMMAND` | `customCommand` (JSON argv array — trusted, see above) |
| `DIFFQUIZ_CONFIG` | path to the user-global config file |
| `NO_COLOR` | disables ANSI colour, same as `--no-color` |

### CLI flags

```
diffquiz [options]              Generate a quiz for the current diff and play it
diffquiz diverge [options]      Divergence mode: N independent LLM answer runs
diffquiz doctor                 Check environment: git, providers, config
```

| Flag | Default | Description |
|---|---|---|
| `-b, --base <ref>` | merge-base with default branch | Base ref to diff against |
| `--staged` | off | Quiz the staged changes instead (`git diff --cached`) |
| `-p, --provider <name>` | `auto` | `claude` \| `codex` \| `custom` \| `auto` |
| `--model <name>` | — | Model override passed to the provider CLI |
| `-n, --questions <3-5>` | `3` | Number of quiz questions |
| `--lang <code>` | `en` | Language for questions/explanations |
| `--max-lines <n>` | `2000` | Refuse diffs above n changed lines |
| `--sample` | off | Sample oversized diffs instead of refusing |
| `--no-secret-scan` | off | Skip the secret heuristic warning |
| `--timeout <sec>` | `180` | Provider timeout |
| `--print` | off | Non-interactive: print questions with answers and exit (spoiler mode, for testing/review) |
| `--json` | off | Machine-readable JSON result on stdout |
| `-o, --out <file>` | — | Write the markdown report to a file |
| `--no-color` | off | Disable ANSI colours (also honours `NO_COLOR`) |
| `-v, --version` | — | Print version |
| `-h, --help` | — | Print help |
| `--runs <n>` (`diverge` only) | `3` | Number of independent answer runs (max 5) |

## Privacy & security

- **The diff goes to exactly one place:** the LLM CLI you already have
  configured (`claude`, `codex`, or a custom command — configurable only
  from your own trust boundary, never from a cloned repo; see
  [Configuration](#configuration)), running locally under your own account.
- **diffquiz itself has zero runtime dependencies, makes zero network
  calls, and has zero telemetry.** There is no account and nothing to sign
  up for.
- **Secret pre-scan:** added lines are checked against common secret
  patterns before anything is sent; a hit asks for interactive confirmation
  rather than blocking or proceeding silently. It's a heuristic, not a
  guarantee — don't rely on it as your only safeguard.
- **Prompt-injection hardening:** the diff is treated as untrusted data,
  wrapped in per-invocation random nonce delimiters (unpredictable to
  anyone crafting the diff offline), with the model instructed to ignore
  any instructions it contains. Model output must be strict,
  schema-validated JSON and is only ever displayed, never executed.
- **Subprocess isolation:** the `claude`/`codex` subprocess runs with its
  working directory pinned to a fresh, empty temp directory (plus
  `--strict-mcp-config --setting-sources user` for `claude`), so a
  checked-out repo's `.mcp.json` or project/local settings can never
  reconfigure the LLM CLI diffquiz invokes.
- **Output sanitization:** model-generated text is sanitized before it's
  ever displayed — control characters and ANSI/CSI/OSC escape sequences are
  stripped before any string is accepted into a quiz, and the markdown/PR
  report additionally escapes `<`/`>`, backticks, pipes, and brackets so a
  crafted diff can't break the report's structure or inject a markdown
  link.

Full threat model and vulnerability reporting: [SECURITY.md](./SECURITY.md).

## What it is not

- **Not a gate.** Exit code is always 0 regardless of score.
- **Not a score tracker.** No history, no persistence beyond a report you
  explicitly ask for.
- **Not gamified.** No streaks, no leaderboard — any number to optimise
  replaces the understanding it was meant to measure.
- **Not a replacement for code review.** It checks whether the author
  understood their own change; it says nothing about whether the change is
  correct, well-designed, or safe to merge.

See [docs/FAQ.md](./docs/FAQ.md) for the honest answers to the harder
questions this raises.

## Roadmap

- GitHub Action that posts the quiz result as a non-blocking PR comment
  (follow-up; not part of the CLI today).

## License

MIT — see [LICENSE](./LICENSE). Built by
[TYLDA Solutions GmbH](https://tylda.solutions).
