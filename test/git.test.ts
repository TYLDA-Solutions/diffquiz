import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDiff, detectBaseRef } from "../src/git.ts";
import { DiffQuizError } from "../src/types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string, branch = "main"): void {
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function makeTempRepo(branch = "main"): string {
  const dir = mkdtempSync(join(tmpdir(), "diffquiz-git-"));
  initRepo(dir, branch);
  return dir;
}

// ---------------------------------------------------------------------------
// detectBaseRef
// ---------------------------------------------------------------------------

test("detectBaseRef falls back to local main when no origin exists", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  commitAll(dir, "init");

  const ref = await detectBaseRef(dir);
  assert.equal(ref, "main");
});

test("detectBaseRef falls back to local master when only master exists", async (t) => {
  const dir = makeTempRepo("master");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  commitAll(dir, "init");

  const ref = await detectBaseRef(dir);
  assert.equal(ref, "master");
});

test("detectBaseRef prefers origin/HEAD over local branches", async (t) => {
  const remoteDir = mkdtempSync(join(tmpdir(), "diffquiz-remote-"));
  git(remoteDir, ["init", "-q", "--bare", "-b", "main"]);
  const dir = makeTempRepo("main");
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "a.txt"), "hello\n");
  commitAll(dir, "init");
  git(dir, ["remote", "add", "origin", remoteDir]);
  git(dir, ["push", "-q", "origin", "main"]);
  git(dir, ["fetch", "-q", "origin"]);
  git(dir, ["remote", "set-head", "origin", "main"]);

  const ref = await detectBaseRef(dir);
  assert.equal(ref, "origin/HEAD");
});

test("detectBaseRef throws BAD_USAGE when no candidate ref exists", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "diffquiz-git-"));
  initRepo(dir, "trunk"); // neither main nor master
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  commitAll(dir, "init");

  await assert.rejects(
    () => detectBaseRef(dir),
    (err: unknown) => err instanceof DiffQuizError && err.code === "BAD_USAGE",
  );
});

// ---------------------------------------------------------------------------
// collectDiff: staged mode
// ---------------------------------------------------------------------------

test("collectDiff staged mode captures git diff --cached", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  commitAll(dir, "init");

  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, ["add", "a.txt"]);

  const summary = await collectDiff({ cwd: dir, staged: true, maxLines: 2000, sample: false });
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0]?.path, "a.txt");
  assert.equal(summary.files[0]?.status, "modified");
  assert.equal(summary.files[0]?.linesAdded, 1);
  assert.match(summary.baseDescription, /staged/);
});

test("collectDiff throws EMPTY_DIFF when nothing is staged", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "one\n");
  commitAll(dir, "init");

  await assert.rejects(
    () => collectDiff({ cwd: dir, staged: true, maxLines: 2000, sample: false }),
    (err: unknown) => err instanceof DiffQuizError && err.code === "EMPTY_DIFF",
  );
});

// ---------------------------------------------------------------------------
// collectDiff: base detection + working-tree fallback
// ---------------------------------------------------------------------------

test("collectDiff falls back to working tree diff when HEAD is the base branch", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "one\n");
  commitAll(dir, "init");

  // Still on main, with an uncommitted (unstaged) change — no feature branch.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 2000, sample: false });
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0]?.linesAdded, 1);
  assert.match(summary.baseDescription, /working tree/);
});

test("collectDiff diffs merge-base..HEAD on a feature branch and ignores uncommitted changes", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.txt"), "base\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), "feature content\n");
  commitAll(dir, "add feature file");

  // Uncommitted straggler after the feature commit — must NOT appear, since
  // committed-diff mode diffs merge-base..HEAD, not the working tree.
  writeFileSync(join(dir, "stray.txt"), "uncommitted\n");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 2000, sample: false });
  const paths = summary.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["feature.txt"]);
  assert.match(summary.baseDescription, /merge-base/);
});

test("collectDiff respects an explicit --base ref", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.txt"), "base\n");
  commitAll(dir, "init");
  git(dir, ["branch", "release"]);

  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), "content\n");
  commitAll(dir, "add feature file");

  const summary = await collectDiff({ cwd: dir, base: "release", staged: false, maxLines: 2000, sample: false });
  assert.deepEqual(
    summary.files.map((f) => f.path),
    ["feature.txt"],
  );
  assert.match(summary.baseDescription, /release/);
});

// ---------------------------------------------------------------------------
// collectDiff: per-file parsing
// ---------------------------------------------------------------------------

test("collectDiff detects a pure rename", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "old-name.txt"), "content that stays identical\nline two\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  git(dir, ["mv", "old-name.txt", "new-name.txt"]);
  commitAll(dir, "rename file");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 2000, sample: false });
  assert.equal(summary.files.length, 1);
  const file = summary.files[0];
  assert.equal(file?.status, "renamed");
  assert.equal(file?.path, "new-name.txt");
  assert.equal(file?.oldPath, "old-name.txt");
  assert.equal(file?.linesAdded, 0);
  assert.equal(file?.linesRemoved, 0);
});

test("collectDiff detects a binary file with empty patch", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.txt"), "base\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  const binaryContent = Buffer.from([0, 1, 2, 3, 0, 255, 254, 253, 0, 10]);
  writeFileSync(join(dir, "blob.bin"), binaryContent);
  commitAll(dir, "add binary");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 2000, sample: false });
  const file = summary.files.find((f) => f.path === "blob.bin");
  assert.ok(file);
  assert.equal(file?.status, "binary");
  assert.equal(file?.patch, "");
  assert.equal(file?.linesAdded, 0);
  assert.equal(file?.linesRemoved, 0);
});

test("collectDiff parses added and deleted files with correct line counts", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "to-delete.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(dir, "unchanged.txt"), "same\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  git(dir, ["rm", "-q", "to-delete.txt"]);
  writeFileSync(join(dir, "new-file.txt"), "a\nb\nc\nd\n");
  git(dir, ["add", "new-file.txt"]);
  commitAll(dir, "add/remove files");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 2000, sample: false });
  const byPath = new Map(summary.files.map((f) => [f.path, f]));

  const added = byPath.get("new-file.txt");
  assert.equal(added?.status, "added");
  assert.equal(added?.linesAdded, 4);
  assert.equal(added?.linesRemoved, 0);

  const deleted = byPath.get("to-delete.txt");
  assert.equal(deleted?.status, "deleted");
  assert.equal(deleted?.linesAdded, 0);
  assert.equal(deleted?.linesRemoved, 3);

  assert.equal(summary.totalLinesAdded, 4);
  assert.equal(summary.totalLinesRemoved, 3);
  // unchanged.txt must not appear at all
  assert.equal(byPath.has("unchanged.txt"), false);
});

// ---------------------------------------------------------------------------
// collectDiff: size budget / sampling
// ---------------------------------------------------------------------------

test("collectDiff throws DIFF_TOO_LARGE when over budget and sample is false", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.txt"), "base\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  const bigContent = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(dir, "big.txt"), bigContent);
  commitAll(dir, "add big file");

  await assert.rejects(
    () => collectDiff({ cwd: dir, staged: false, maxLines: 50, sample: false }),
    (err: unknown) => err instanceof DiffQuizError && err.code === "DIFF_TOO_LARGE",
  );
});

test("collectDiff with sample=true drops lockfiles first and records truncationNotes", async (t) => {
  const dir = makeTempRepo("main");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.txt"), "base\n");
  commitAll(dir, "init");

  git(dir, ["checkout", "-q", "-b", "feature"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  const smallContent = Array.from({ length: 20 }, (_, i) => `real line ${i}`).join("\n") + "\n";
  writeFileSync(join(dir, "src", "real.ts"), smallContent);
  const lockContent = Array.from({ length: 500 }, (_, i) => `"dep${i}": "1.0.${i}"`).join("\n") + "\n";
  writeFileSync(join(dir, "package-lock.json"), lockContent);
  commitAll(dir, "add real file and lockfile");

  const summary = await collectDiff({ cwd: dir, staged: false, maxLines: 30, sample: true });
  assert.equal(summary.truncated, true);
  const paths = summary.files.map((f) => f.path);
  assert.ok(paths.includes("src/real.ts"));
  assert.ok(!paths.includes("package-lock.json"));
  assert.equal(summary.truncationNotes.length, 1);
  assert.match(summary.truncationNotes[0] ?? "", /package-lock\.json/);
  assert.ok(summary.totalLinesAdded + summary.totalLinesRemoved <= 30);
});
