# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-01

### Added

- Initial release of `diffquiz`: generate a 3-5 question multiple-choice quiz
  on the current diff, play it interactively in the terminal, and score it
  without blocking (exit code 0 regardless of result).
- `diffquiz diverge` — run N independent LLM answer passes over the same
  quiz and flag questions where the runs disagree.
- `diffquiz doctor` — check git, provider availability, and config.
- Providers: `claude`, `codex` (experimental), and `custom` (any stdin/stdout
  CLI).
- Secret pre-scan on added lines with an interactive confirmation before the
  diff is sent to a provider.
- `.diffquiz.json` configuration file and `DIFFQUIZ_*` environment variable
  overrides.
- `--print` (spoiler mode), `--json`, and `-o/--out` markdown report output
  for use in PR descriptions.
- Claude Code plugin (`plugin/diffquiz`) providing an in-session
  `/diffquiz:diffquiz` skill that quizzes the user without an external LLM
  call.

[0.1.0]: https://github.com/TYLDA-Solutions/diffquiz/releases/tag/v0.1.0
