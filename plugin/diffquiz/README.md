# diffquiz (Claude Code plugin)

Quiz yourself on your own diff before you open the PR — without leaving the
session. Claude reads your current diff, writes 3-5 multiple-choice
questions about what it actually does, and asks them one at a time. Every
answer, right or wrong, immediately gets a two-sentence explanation with
`file:line` references. Non-blocking: there is nothing to fail.

See the [main README](../../README.md) for the full concept and the
standalone `diffquiz` CLI this plugin complements.

## Install

```
claude plugin marketplace add TYLDA-Solutions/diffquiz
claude plugin install diffquiz@diffquiz
```

## Use

Inside a Claude Code session, in a git repository with a diff:

```
/diffquiz:diffquiz
```

Optionally pass a base ref: `/diffquiz:diffquiz main`. Claude will also
trigger the skill on its own for requests like "quiz me on my diff" or
"check my understanding before I open this PR".

## What it does

1. Computes your diff against the merge-base with the default branch (or the
   ref you pass, or staged changes if you ask for those).
2. Writes 3-5 multiple-choice questions about the diff's effect, not its
   syntax.
3. Asks them one at a time via Claude Code's question UI, revealing the
   correct answer and a short explanation after each one.
4. Offers a short summary and an optional markdown report you can paste into
   the PR description.

Full behaviour and craft rules live in
[`skills/diffquiz/SKILL.md`](./skills/diffquiz/SKILL.md).

License: MIT. Built by [TYLDA Solutions GmbH](https://tylda.solutions).
