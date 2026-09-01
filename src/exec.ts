/**
 * Safe subprocess runner. Every external command in diffquiz (git and the
 * LLM CLIs) goes through here: argv arrays only, no shell, hard timeout,
 * bounded output capture.
 */
import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs: number;
  cwd?: string;
}

export class CommandTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`Command "${cmd}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CommandTimeoutError";
  }
}

export function runCommand(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so a timeout kill reaches grandchildren too.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill();
        }
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new CommandTimeoutError(cmd, opts.timeoutMs));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    if (opts.stdin !== undefined) {
      child.stdin.on("error", () => {
        // Ignore EPIPE from processes that exit before reading stdin.
      });
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  // `command -v` is POSIX; on Windows fall back to `where`.
  const probe =
    process.platform === "win32"
      ? runCommand("where", [cmd], { timeoutMs: 5000 })
      : runCommand("/bin/sh", ["-c", "command -v -- \"$1\"", "sh", cmd], { timeoutMs: 5000 });
  try {
    const res = await probe;
    return res.code === 0;
  } catch {
    return false;
  }
}
