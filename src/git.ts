/**
 * Diff collection. Talks to `git` exclusively through `runCommand` (argv
 * arrays, no shell) and turns the raw unified diff into a `DiffSummary`.
 */
import { runCommand, type RunResult } from "./exec.ts";
import { DiffQuizError, type DiffFile, type DiffSummary } from "./types.ts";

export interface DiffOptions {
  cwd: string;
  base?: string;
  staged?: boolean;
  maxLines: number;
  sample: boolean;
}

const GIT_TIMEOUT_MS = 30_000;

// Checked in this order; the first ref that resolves wins.
const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

// Dropped first when sampling an oversized diff.
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "mix.lock",
  "flake.lock",
]);
const VENDORED_DIR_RE = /(^|\/)(vendor|node_modules|third_party|dist|build|\.venv|target)\//;
const MINIFIED_RE = /\.min\.[^/.]+$/;

export async function detectBaseRef(cwd: string): Promise<string> {
  await ensureRepo(cwd);
  for (const candidate of BASE_CANDIDATES) {
    if (await refExists(cwd, candidate)) return candidate;
  }
  throw new DiffQuizError(
    "BAD_USAGE",
    "Could not auto-detect a base branch.",
    "None of origin/HEAD, origin/main, origin/master, main, master were found in this repository — pass --base <ref> explicitly.",
  );
}

export async function collectDiff(opts: DiffOptions): Promise<DiffSummary> {
  await ensureRepo(opts.cwd);

  let baseDescription: string;
  let rawDiff: string;

  if (opts.staged) {
    rawDiff = await gitDiff(opts.cwd, ["--cached"]);
    baseDescription = "staged changes (git diff --cached)";
  } else {
    await ensureHasCommits(opts.cwd);
    const baseRef = opts.base ?? (await detectBaseRef(opts.cwd));
    const mergeBase = await resolveMergeBase(opts.cwd, baseRef);
    const headSha = await revParse(opts.cwd, "HEAD");
    if (mergeBase === headSha) {
      // HEAD *is* the base branch (no divergence) — mergeBase..HEAD would be
      // empty even though there may be real pre-commit work to quiz. Fall
      // back to the working tree (staged + unstaged) so the tool stays useful.
      rawDiff = await gitDiff(opts.cwd, []);
      baseDescription = `working tree vs HEAD (HEAD has no commits beyond "${baseRef}"; showing uncommitted changes incl. staged)`;
    } else {
      rawDiff = await gitDiff(opts.cwd, [mergeBase, "HEAD"]);
      baseDescription = `merge-base(HEAD, ${baseRef})`;
    }
  }

  const files = parseUnifiedDiff(rawDiff);
  if (files.length === 0) {
    throw new DiffQuizError(
      "EMPTY_DIFF",
      "No changes found in the selected diff.",
      "Make some changes, or check your --base/--staged selection.",
    );
  }

  const totalAdded = sumLines(files, "linesAdded");
  const totalRemoved = sumLines(files, "linesRemoved");

  if (totalAdded + totalRemoved <= opts.maxLines) {
    return {
      baseDescription,
      files,
      totalLinesAdded: totalAdded,
      totalLinesRemoved: totalRemoved,
      truncated: false,
      truncationNotes: [],
    };
  }

  if (!opts.sample) {
    throw new DiffQuizError(
      "DIFF_TOO_LARGE",
      `Diff has ${totalAdded + totalRemoved} changed lines, exceeding the ${opts.maxLines}-line budget.`,
      "A smaller PR is the real fix — split it up, or pass --sample to quiz a truncated sample instead.",
    );
  }

  const { kept, notes } = truncateToBudget(files, opts.maxLines);
  return {
    baseDescription,
    files: kept,
    totalLinesAdded: sumLines(kept, "linesAdded"),
    totalLinesRemoved: sumLines(kept, "linesRemoved"),
    truncated: true,
    truncationNotes: notes,
  };
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

async function runGit(cwd: string, args: string[]): Promise<RunResult> {
  try {
    return await runCommand("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    throw new DiffQuizError(
      "NOT_A_REPO",
      `Failed to run git ${args.join(" ")}: ${(err as Error).message}`,
      "Ensure git is installed and on PATH.",
    );
  }
}

async function ensureRepo(cwd: string): Promise<void> {
  const res = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (res.code !== 0 || res.stdout.trim() !== "true") {
    throw new DiffQuizError(
      "NOT_A_REPO",
      `"${cwd}" is not inside a git repository.`,
      "Run diffquiz from inside a git working tree.",
    );
  }
}

async function ensureHasCommits(cwd: string): Promise<void> {
  const res = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (res.code !== 0) {
    throw new DiffQuizError(
      "EMPTY_DIFF",
      "This repository has no commits yet.",
      "Make an initial commit before running diffquiz, or use --staged.",
    );
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const res = await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return res.code === 0;
}

async function resolveMergeBase(cwd: string, baseRef: string): Promise<string> {
  const res = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
  if (res.code !== 0) {
    throw new DiffQuizError(
      "BAD_USAGE",
      `Could not compute a merge base with "${baseRef}".`,
      res.stderr.trim() || `Check that "${baseRef}" is a valid ref reachable from this repository.`,
    );
  }
  return res.stdout.trim();
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const res = await runGit(cwd, ["rev-parse", ref]);
  if (res.code !== 0) {
    throw new DiffQuizError("NOT_A_REPO", `Could not resolve ref "${ref}".`, res.stderr.trim());
  }
  return res.stdout.trim();
}

async function gitDiff(cwd: string, args: string[]): Promise<string> {
  // core.quotePath=false: without it, git C-style-escapes (octal-escapes)
  // any non-ASCII byte in a path and wraps it in double quotes (e.g.
  // "caf\303\251.txt" for "café.txt"). unquote() below only strips the
  // surrounding quotes — it does not decode that escaping — so paths would
  // otherwise come out mangled. Disabling quotePath makes git emit the raw
  // UTF-8 bytes instead.
  const res = await runGit(cwd, ["-c", "core.quotePath=false", "diff", "--no-color", "-M", ...args]);
  if (res.code !== 0) {
    throw new DiffQuizError(
      "NOT_A_REPO",
      `git diff failed: ${res.stderr.trim()}`,
      "Check the repository state and the --base ref.",
    );
  }
  return res.stdout;
}

// ---------------------------------------------------------------------------
// unified diff parsing
// ---------------------------------------------------------------------------

function parseUnifiedDiff(diffText: string): DiffFile[] {
  if (diffText.trim() === "") return [];

  const lines = diffText.split("\n");
  const chunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current);

  return chunks.map(parseChunk);
}

function parseChunk(chunkLines: string[]): DiffFile {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let isRename = false;
  let isNewFile = false;
  let isDeletedFile = false;
  let isBinary = false;
  let binaryOld: string | undefined;
  let binaryNew: string | undefined;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of chunkLines) {
    if (line.startsWith("rename from ")) {
      renameOld = unquote(line.slice("rename from ".length));
      isRename = true;
    } else if (line.startsWith("rename to ")) {
      renameNew = unquote(line.slice("rename to ".length));
      isRename = true;
    } else if (line.startsWith("new file mode")) {
      isNewFile = true;
    } else if (line.startsWith("deleted file mode")) {
      isDeletedFile = true;
    } else if (line.startsWith("--- ")) {
      const p = unquote(line.slice(4));
      if (p !== "/dev/null") oldPath = stripAbPrefix(p);
    } else if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      if (p !== "/dev/null") newPath = stripAbPrefix(p);
    } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      isBinary = true;
      const m = /^Binary files (.+) and (.+) differ$/.exec(line);
      const left = m?.[1];
      const right = m?.[2];
      if (left !== undefined) binaryOld = left === "/dev/null" ? undefined : stripAbPrefix(left);
      if (right !== undefined) binaryNew = right === "/dev/null" ? undefined : stripAbPrefix(right);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      linesAdded++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      linesRemoved++;
    }
  }

  // Mode-only changes (e.g. `chmod +x` on a tracked file) produce a diff with
  // only the `diff --git a/X b/X` header plus old/new mode lines — no ---/+++
  // lines, so oldPath/newPath are never set above. Fall back to parsing the
  // header line itself whenever both remain unset.
  if (oldPath === undefined && newPath === undefined) {
    const headerLine = chunkLines[0];
    if (headerLine !== undefined) {
      const headerPaths = parseDiffGitHeader(headerLine);
      if (headerPaths) {
        oldPath = headerPaths.oldPath;
        newPath = headerPaths.newPath;
      }
    }
  }

  let status: DiffFile["status"];
  let path: string;
  let finalOldPath: string | undefined;

  if (isBinary) {
    status = "binary";
    path = binaryNew ?? binaryOld ?? "unknown";
    if (binaryOld !== undefined && binaryNew !== undefined && binaryOld !== binaryNew) {
      finalOldPath = binaryOld;
    }
  } else if (isRename) {
    status = "renamed";
    path = renameNew ?? newPath ?? "unknown";
    finalOldPath = renameOld ?? oldPath;
  } else if (isNewFile) {
    status = "added";
    path = newPath ?? oldPath ?? "unknown";
  } else if (isDeletedFile) {
    status = "deleted";
    path = oldPath ?? newPath ?? "unknown";
  } else {
    status = "modified";
    path = newPath ?? oldPath ?? "unknown";
  }

  const patch = isBinary ? "" : chunkLines.join("\n").replace(/\n$/, "");

  const file: DiffFile = {
    path,
    status,
    linesAdded: isBinary ? 0 : linesAdded,
    linesRemoved: isBinary ? 0 : linesRemoved,
    patch,
  };
  if (finalOldPath !== undefined) file.oldPath = finalOldPath;
  return file;
}

// Git quotes paths containing unusual characters in double quotes; this is a
// best-effort unwrap (no C-style escape decoding — good enough for the
// redaction/reporting use cases here).
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function stripAbPrefix(raw: string): string {
  const s = unquote(raw);
  return s.startsWith("a/") || s.startsWith("b/") ? s.slice(2) : s;
}

// Fallback path source for diffs that carry no ---/+++ lines (mode-only
// changes). Format: `diff --git a/<old> b/<new>`. With core.quotePath=false
// (see gitDiff) the common case — including non-ASCII paths — is unquoted,
// so a heuristic split on the " b/" separator is enough; paths containing a
// literal " b/" substring are a known, accepted limitation of this format.
// The (rarer) quoted form, e.g. when a path itself needs backslash/quote
// escaping, is best-efforted via unquote() on each side.
function parseDiffGitHeader(headerLine: string): { oldPath: string; newPath: string } | undefined {
  const prefix = "diff --git ";
  if (!headerLine.startsWith(prefix)) return undefined;
  const rest = headerLine.slice(prefix.length);
  const marker = " b/";
  const idx = rest.indexOf(marker);
  if (idx === -1) return undefined;
  const left = unquote(rest.slice(0, idx));
  const right = unquote(rest.slice(idx + 1));
  const oldPath = left.startsWith("a/") ? left.slice(2) : left;
  const newPath = right.startsWith("b/") ? right.slice(2) : right;
  if (oldPath.length === 0 || newPath.length === 0) return undefined;
  return { oldPath, newPath };
}

// ---------------------------------------------------------------------------
// size budget / sampling
// ---------------------------------------------------------------------------

function sumLines(files: DiffFile[], key: "linesAdded" | "linesRemoved"): number {
  return files.reduce((acc, f) => acc + f[key], 0);
}

function isLowPriority(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return LOCKFILE_BASENAMES.has(base) || MINIFIED_RE.test(path) || VENDORED_DIR_RE.test(path);
}

function truncateToBudget(files: DiffFile[], maxLines: number): { kept: DiffFile[]; notes: string[] } {
  // Non-generated files first (so they're evaluated — and kept — before
  // lockfiles/minified/vendored paths, which are dropped first).
  const ordered = [...files.filter((f) => !isLowPriority(f.path)), ...files.filter((f) => isLowPriority(f.path))];

  const kept: DiffFile[] = [];
  const dropped: DiffFile[] = [];
  let running = 0;
  for (const f of ordered) {
    const size = f.linesAdded + f.linesRemoved;
    if (kept.length === 0 || running + size <= maxLines) {
      kept.push(f);
      running += size;
    } else {
      dropped.push(f);
    }
  }

  const keptSet = new Set(kept);
  const keptInOriginalOrder = files.filter((f) => keptSet.has(f));

  const notes =
    dropped.length > 0
      ? [
          `Dropped ${dropped.length} file(s) to fit the ${maxLines}-line budget (lockfiles/minified/vendored paths dropped first): ${dropped
            .map((f) => f.path)
            .join(", ")}`,
        ]
      : [];

  return { kept: keptInOriginalOrder, notes };
}
