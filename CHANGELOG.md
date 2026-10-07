# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-07

### Fixed

- Auto mode never fired from a Dock-launched Claude Code desktop app. Claude
  Code runs plugin hooks with its own process environment, whose PATH is the
  bare system default without Homebrew/nvm/volta, so the hook command `node …`
  failed with exit 127 — which Claude Code treats as a non-blocking error, so
  pushes proceeded silently. The hook is now started through a POSIX `sh`
  launcher that locates a Node binary itself (PATH, then common install
  locations, nvm, or `DIFFQUIZ_NODE`). If no Node is found while auto mode is
  on, the launcher fails open *loudly* with a hook-error notice instead of
  silently.
- Pushes issued as `cd <repo> && git push` or `git -C <repo> push` from a
  session started outside the repo are now resolved to that repo for the
  quiz-marker check.
- `/diffquiz:status` probes the hook runtime under the minimal GUI PATH and
  reports the Node binary the hook will use.

## [0.2.0] - 2026-09-02

### Added

- Claude Code plugin modes: `ondemand` (default — quiz only when asked) and
  `auto` (a PreToolUse hook intercepts `git push` and `gh pr create` inside
  Claude Code sessions, has Claude quiz the author first, then the command
  proceeds — wrong answers never block anything).
- `/diffquiz:auto`, `/diffquiz:ondemand`, `/diffquiz:status` — switch and
  inspect the mode. It lives only in the user-global config
  (`DIFFQUIZ_CONFIG`/`$XDG_CONFIG_HOME`/`~/.config/diffquiz/config.json`); a
  repo's `.diffquiz.json` cannot set it.
- Pre-push quiz marker (`~/.cache/diffquiz/quizzed-<repo-hash>`, or under
  `$DIFFQUIZ_CACHE_DIR`/XDG cache paths) as the loop breaker for `auto`
  mode: records the `HEAD` sha and a timestamp, valid 60 minutes for the
  same `HEAD`, so a retried push after a completed quiz isn't quizzed
  again — new commits re-trigger it.
- `diffquiz doctor` now also displays the current mode.

### Unchanged

- The standalone CLI's own behavior is unaffected by modes — `mode` is a
  plugin-only concept the CLI already tolerates as an unknown config key.

[0.2.1]: https://github.com/TYLDA-Solutions/diffquiz/releases/tag/v0.2.1
[0.2.0]: https://github.com/TYLDA-Solutions/diffquiz/releases/tag/v0.2.0

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
