---
description: Switch diffquiz to on-demand mode — quiz only when the user asks, no automatic interception of git push / gh pr create. Use when the user says "diffquiz ondemand", "turn off auto mode", "stop quizzing me automatically", or runs /diffquiz:ondemand.
---

# diffquiz: on-demand mode

Set `mode: "ondemand"` in the user-global diffquiz config, touching no other
key. Invoked as `/diffquiz:ondemand`. This is also the default when no mode
has ever been set.

## Steps

1. Resolve the user-global config path — never the repo-local
   `.diffquiz.json`, which this command must not touch:
   - `$DIFFQUIZ_CONFIG` if set, else
   - `$XDG_CONFIG_HOME/diffquiz/config.json` if `$XDG_CONFIG_HOME` is set,
     else
   - `~/.config/diffquiz/config.json`

2. Read the file if it exists. Tolerate a missing file or missing parent
   directory (treat as `{}`). If it exists but fails to parse as JSON, stop
   and tell the user instead of overwriting it.

3. Set `mode` to `"ondemand"`, preserving every other key exactly as found.
   Create the parent directory if needed, then write the file back as
   pretty-printed JSON (2-space indent, trailing newline).

   One reliable way to do all of this in a single step:

   ```bash
   node -e '
   const fs = require("node:fs");
   const os = require("node:os");
   const path = require("node:path");
   const configPath = process.env.DIFFQUIZ_CONFIG
     || (process.env.XDG_CONFIG_HOME
       ? path.join(process.env.XDG_CONFIG_HOME, "diffquiz", "config.json")
       : path.join(os.homedir(), ".config", "diffquiz", "config.json"));
   let config = {};
   if (fs.existsSync(configPath)) {
     config = JSON.parse(fs.readFileSync(configPath, "utf8"));
   }
   config.mode = "ondemand";
   fs.mkdirSync(path.dirname(configPath), { recursive: true });
   fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
   console.log(configPath);
   '
   ```

4. Confirm in one short line that on-demand mode is now active and what it
   means: "I'll quiz only when you ask." Mention `/diffquiz:auto` as the
   way to make it automatic again.

Never touch a repo-local `.diffquiz.json` — mode is a user-global choice,
same as it is for the CLI's `customCommand`.
