# FAQ

### Can't I just paste the questions into my agent and have it answer them?

Yes. Nothing stops you, and diffquiz has no way to detect it. But doing that
doesn't help you — it only produces a transcript that *looks* like you
understood the change. There's no score to game, no record kept, no check
that verifies a human typed the answer. The mechanism diffquiz relies on is
social, not technical: you're doing this because you want to know whether
you actually understood your own diff before you ask someone else to review
it. Delegating the quiz back to an agent just answers a question nobody
asked.

### Is this a gate? Can it fail my PR?

No. Exit code is `0` regardless of score, every time. There is no
configuration flag that changes this — it's a core principle, not a default.
diffquiz produces insight and an optional markdown report; it never blocks a
commit, a push, or a merge.

### Why is there no leaderboard, streak counter, or score history?

Because the moment a number exists, people optimise the number instead of
the thing it was supposed to measure. A streak or a leaderboard would turn
"did I understand this diff" into "how do I keep my streak alive", which is
a different — and much easier — game to win without reading anything.
diffquiz keeps no history beyond the report you explicitly ask it to write.

### What happens with huge diffs?

Above the configured line budget (`--max-lines`, default 2000), diffquiz
refuses by default rather than generating a quiz. That's deliberate: past a
certain size, a 3-5 question multiple-choice quiz can't meaningfully cover
the change, and the honest answer is "this PR should be smaller." The
refusal message says so. If you need to push through anyway — a large but
genuinely reviewable change, a big generated diff you've already vetted —
pass `--sample` to have diffquiz keep a representative slice (prioritising
non-generated, non-lockfile files) instead of refusing outright.

### Does my code go to TYLDA?

No. TYLDA Solutions GmbH publishes diffquiz as open source and receives
nothing from your usage of it — there's no telemetry, no analytics, no
callback of any kind built into the tool. Your diff goes only to the LLM CLI
you've configured (`claude`, `codex`, or your own `customCommand`), running
on your machine under your own account. See [SECURITY.md](../SECURITY.md)
for the full breakdown of what leaves your machine.

### Which LLM CLIs work?

- **`claude`** — the Claude Code CLI, invoked non-interactively
  (`claude -p --output-format json`). Fully supported.
- **`codex`** — the Codex CLI (`codex exec`). Supported, marked
  experimental: its non-interactive flag surface is less stable across
  versions, so behaviour is best-effort.
- **Anything else** via `customCommand` in `.diffquiz.json` — any CLI that
  reads a prompt on stdin and writes its completion to stdout works
  (`llm`, `gemini`, `ollama run <model>`, an internal wrapper, etc.).

Run `diffquiz doctor` to see what diffquiz detects as available on your
machine right now.
