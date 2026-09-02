---
description: Show diffquiz's current mode (auto/on-demand), which config file it comes from, and whether this repo has a fresh quiz marker. Use when the user asks "what mode is diffquiz in", "diffquiz status", or runs /diffquiz:status.
---

# diffquiz: status

Report the current plugin mode and quiz-marker freshness for this repo.
Invoked as `/diffquiz:status`. Read-only — never writes anything.

## Steps

1. Resolve and read the user-global config the same way `/diffquiz:auto`
   does:
   - `$DIFFQUIZ_CONFIG` if set, else
   - `$XDG_CONFIG_HOME/diffquiz/config.json` if `$XDG_CONFIG_HOME` is set,
     else
   - `~/.config/diffquiz/config.json`

   A missing file or directory just means no mode has been set yet.

2. Determine the mode: the `mode` key if present and one of `"auto"` /
   `"ondemand"`, else `"ondemand"` (the default).

3. Determine quiz-marker freshness for the current repo:
   - Cache dir: `$DIFFQUIZ_CACHE_DIR` if set, else `$XDG_CACHE_HOME/diffquiz`
     if `$XDG_CACHE_HOME` is set, else `~/.cache/diffquiz`.
   - Marker file: `quizzed-<first 16 hex chars of sha256(absolute repo root
     path)>`.
   - Fresh = the marker's `head` equals the repo's current `HEAD` sha AND its
     `at` timestamp is less than 60 minutes old.
   - If the current directory isn't inside a git repository, skip this part
     and say so — mode can still be reported on its own.

   One reliable way to compute all of this in a single step:

   ```bash
   node -e '
   const { execSync } = require("node:child_process");
   const crypto = require("node:crypto");
   const fs = require("node:fs");
   const os = require("node:os");
   const path = require("node:path");

   const configPath = process.env.DIFFQUIZ_CONFIG
     || (process.env.XDG_CONFIG_HOME
       ? path.join(process.env.XDG_CONFIG_HOME, "diffquiz", "config.json")
       : path.join(os.homedir(), ".config", "diffquiz", "config.json"));
   let mode = "ondemand";
   if (fs.existsSync(configPath)) {
     const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
     if (config.mode === "auto" || config.mode === "ondemand") mode = config.mode;
   }

   let fresh = null; // null = not inside a git repo
   try {
     const root = execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
     const head = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
     const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
     const cacheDir = process.env.DIFFQUIZ_CACHE_DIR
       || (process.env.XDG_CACHE_HOME
         ? path.join(process.env.XDG_CACHE_HOME, "diffquiz")
         : path.join(os.homedir(), ".cache", "diffquiz"));
     const markerPath = path.join(cacheDir, `quizzed-${hash}`);
     fresh = false;
     if (fs.existsSync(markerPath)) {
       const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
       const ageMs = Date.now() - new Date(marker.at).getTime();
       fresh = marker.head === head && ageMs >= 0 && ageMs < 60 * 60 * 1000;
     }
   } catch {
     fresh = null;
   }

   console.log(JSON.stringify({ mode, configPath, fresh }));
   '
   ```

4. Report in a few lines: current mode, the config file path used, and
   whether a fresh quiz marker exists for this repo (fresh means the next
   push/PR in auto mode will not be intercepted).

Example output:

```
Mode: auto (config: ~/.config/diffquiz/config.json)
Quiz marker for this repo: fresh — next push/PR won't be intercepted.
```

```
Mode: ondemand (config: ~/.config/diffquiz/config.json — no "mode" key set, this is the default)
Not inside a git repository, so no quiz marker to check.
```
