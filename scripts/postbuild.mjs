// Ensures the compiled CLI entry point is executable after `tsc` emits it.
import { chmodSync } from "node:fs";

chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
