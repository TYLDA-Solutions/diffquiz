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
- `.diffquiz.json` (repo) and user-global config file, plus `DIFFQUIZ_*`
  environment variable overrides.
- `--print` (spoiler mode), `--json`, and `-o/--out` markdown report output
  for use in PR descriptions.
- Claude Code plugin (`plugin/diffquiz`) providing an in-session
  `/diffquiz:diffquiz` skill that quizzes the user without an external LLM
  call.

### Security

- **Config trust boundary:** a repo-committed `.diffquiz.json` can no
  longer set `customCommand` or `provider: "custom"` — both are silently
  ignored (with a stderr warning) so a cloned repo can never make diffquiz
  execute an arbitrary command. Custom providers are now configured only
  from a user-global config file (`DIFFQUIZ_CONFIG`,
  `$XDG_CONFIG_HOME/diffquiz/config.json`, or
  `~/.config/diffquiz/config.json`) or the new `DIFFQUIZ_CUSTOM_COMMAND`
  environment variable (a JSON argv array).
- **Subprocess isolation:** the `claude`/`codex` subprocesses now run with
  `cwd` pinned to a fresh, empty temp directory (plus
  `--strict-mcp-config --setting-sources user` for `claude`), so a
  checked-out repo's `.mcp.json` or project/local settings can never
  reconfigure the LLM CLI diffquiz invokes.
- **Output sanitization:** all model-generated text is sanitized before
  it's ever displayed. Control characters and ANSI/CSI/OSC escape sequences
  are stripped before any string enters a `Quiz` (terminal and `--print`
  paths render this sanitized text directly). The markdown/PR-report
  renderer additionally escapes `<`/`>`, backticks, pipes, and brackets/
  parens in question text, options, and explanations, so a crafted diff
  can't break the `<details>` block structure or inject a markdown
  link/image into a PR comment.
- **Nonce delimiters:** the diff is wrapped in per-invocation random nonce
  delimiters in the generation and answer prompts, unpredictable to anyone
  crafting the diff offline, hardening the untrusted-diff boundary against
  prompt injection.

[0.1.0]: https://github.com/TYLDA-Solutions/diffquiz/releases/tag/v0.1.0
