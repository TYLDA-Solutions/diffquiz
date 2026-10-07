#!/bin/sh
# diffquiz auto-mode hook launcher.
#
# Claude Code runs plugin hooks with the environment of its own process. When
# the desktop app is launched from the Dock, that PATH is the bare system
# default (/usr/bin:/bin:/usr/sbin:/sbin) — no Homebrew, nvm, volta or fnm —
# so a hook command of plain `node …` fails with exit 127 and Claude Code
# treats it as a non-blocking error: the push proceeds and auto mode silently
# never fires. This launcher locates a Node binary itself.
#
# Contract: exit 0 with no output = allow; exit 0 with JSON = the hook's own
# decision; exit 1 with a stderr line = allow, but Claude Code shows the line
# as a hook error notice so the user learns why auto mode didn't run.
#
# Usage: sh pre-push-quiz.sh            (hook mode, stdin = hook JSON)
#        sh pre-push-quiz.sh --probe    (print the Node binary it would use)

HERE=$(cd "$(dirname "$0")" && pwd)
HOOK="$HERE/pre-push-quiz.mjs"

find_node() {
  # 1. Explicit override, authoritative even when it doesn't exist (so a typo
  #    surfaces as an error instead of silently falling back).
  if [ -n "$DIFFQUIZ_NODE" ]; then
    printf '%s\n' "$DIFFQUIZ_NODE"
    return 0
  fi
  # 2. Whatever is on PATH.
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # 3. Common install locations that GUI-launched processes can't see.
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.nodenv/shims/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    /usr/bin/node \
    /snap/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  # 4. nvm: newest installed version wins.
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm_dir/versions/node" ]; then
    newest=$(ls -1 "$nvm_dir/versions/node" 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    if [ -n "$newest" ] && [ -x "$nvm_dir/versions/node/$newest/bin/node" ]; then
      printf '%s\n' "$nvm_dir/versions/node/$newest/bin/node"
      return 0
    fi
  fi
  return 1
}

config_mode_is_auto() {
  cfg="$DIFFQUIZ_CONFIG"
  if [ -z "$cfg" ]; then
    if [ -n "$XDG_CONFIG_HOME" ]; then cfg="$XDG_CONFIG_HOME/diffquiz/config.json"; else cfg="$HOME/.config/diffquiz/config.json"; fi
  fi
  [ -r "$cfg" ] && grep -Eq '"mode"[[:space:]]*:[[:space:]]*"auto"' "$cfg"
}

NODE=$(find_node)
FOUND=$?

if [ "$1" = "--probe" ]; then
  if [ "$FOUND" -eq 0 ] && [ -x "$NODE" ]; then
    printf 'node: %s (%s)\n' "$NODE" "$("$NODE" --version 2>/dev/null)"
    exit 0
  fi
  printf 'node: NOT FOUND — auto mode cannot run in this environment (PATH=%s)\n' "$PATH"
  exit 1
fi

if [ "$FOUND" -ne 0 ] || [ ! -x "$NODE" ]; then
  if config_mode_is_auto; then
    # Loud fail-open: the push proceeds, but the user sees why no quiz came.
    printf 'diffquiz auto mode skipped: no Node binary found (PATH=%s). Install Node or set DIFFQUIZ_NODE=/path/to/node; run /diffquiz:status to check.\n' "$PATH" >&2
    exit 1
  fi
  exit 0
fi

exec "$NODE" "$HOOK"
