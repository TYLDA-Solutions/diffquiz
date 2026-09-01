import assert from "node:assert/strict";
import test from "node:test";
import { scanForSecrets } from "../src/secrets.ts";
import type { DiffFile, DiffSummary } from "../src/types.ts";

function makeFile(path: string, patch: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    linesAdded: (patch.match(/^\+[^+]/gm) ?? []).length,
    linesRemoved: (patch.match(/^-[^-]/gm) ?? []).length,
    patch,
    ...overrides,
  };
}

function makeDiff(files: DiffFile[]): DiffSummary {
  return {
    baseDescription: "test",
    files,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    truncated: false,
    truncationNotes: [],
  };
}

function hunk(header: string, lines: string[]): string {
  return [`diff --git a/f b/f`, `index 000..111 100644`, `--- a/f`, `+++ b/f`, header, ...lines].join("\n");
}

test("no findings on a clean diff", () => {
  const patch = hunk("@@ -1,2 +1,3 @@", [" context line one", "+const greeting = 'hello world';", " context line two"]);
  const diff = makeDiff([makeFile("src/hello.ts", patch)]);
  assert.deepEqual(scanForSecrets(diff), []);
});

test("AWS access key detected only on added line, not context/removed", () => {
  const key = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 chars
  const patch = hunk("@@ -1,3 +1,3 @@", [` const contextKey = "${key}";`, `-const removedKey = "${key}";`, `+const addedKey = "${key}";`]);
  const diff = makeDiff([makeFile("src/aws.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "aws-access-key");
  assert.equal(findings[0]?.file, "src/aws.ts");
  assert.equal(findings[0]?.excerpt, `${key.slice(0, 4)}…`);
});

test("GitHub token detected", () => {
  const token = "ghp_" + "a".repeat(36);
  // Deliberately avoids the words key/secret/token/password so this line
  // only matches the github-token pattern, not the generic-secret one too.
  const patch = hunk("@@ -1,1 +1,1 @@", [`+GH_AUTH=${token}`]);
  const diff = makeDiff([makeFile("ci.yml", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "github-token");
  assert.equal(findings[0]?.excerpt, `${token.slice(0, 4)}…`);
});

test("GitHub token also flags the generic-secret pattern when assigned via TOKEN=", () => {
  // A realistic assignment like TOKEN=ghp_... legitimately matches both the
  // specific github-token pattern and the generic key/secret/token/password
  // heuristic — overlap is expected, not a bug (spec: false positives are fine).
  const token = "ghp_" + "a".repeat(36);
  const patch = hunk("@@ -1,1 +1,1 @@", [`+GITHUB_TOKEN=${token}`]);
  const diff = makeDiff([makeFile("ci.yml", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.kind).sort(),
    ["generic-secret", "github-token"],
  );
});

test("github_pat_ token detected", () => {
  const token = "github_pat_" + "B".repeat(30);
  const patch = hunk("@@ -1,1 +1,1 @@", [`+  token: "${token}"`]);
  const diff = makeDiff([makeFile("config.yml", patch)]);
  const findings = scanForSecrets(diff);
  assert.ok(findings.some((f) => f.kind === "github-token"));
});

test("Slack token detected", () => {
  const token = "xoxb-1234567890-abcdefghijklmno";
  // Avoids key/secret/token/password so only the slack-token pattern fires.
  const patch = hunk("@@ -1,1 +1,1 @@", [`+SLACK_BOT_CRED=${token}`]);
  const diff = makeDiff([makeFile("src/slack.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "slack-token");
});

test("private key block detected", () => {
  const patch = hunk("@@ -1,1 +1,1 @@", [`+-----BEGIN RSA PRIVATE KEY-----`]);
  const diff = makeDiff([makeFile("secrets.pem", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "private-key");
});

test("JWT detected", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const patch = hunk("@@ -1,1 +1,1 @@", [`+const token = "${jwt}";`]);
  const diff = makeDiff([makeFile("src/auth.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.ok(findings.some((f) => f.kind === "jwt"));
});

test("sk- style API key detected", () => {
  const key = "sk-" + "x".repeat(20);
  const patch = hunk("@@ -1,1 +1,1 @@", [`+const OPENAI_KEY = "${key}";`]);
  const diff = makeDiff([makeFile("src/llm.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.ok(findings.some((f) => f.kind === "sk-key"));
});

test("generic key/secret/token/password assignment detected with redacted excerpt", () => {
  const value = "abcdEFGH12345678zzzz";
  const patch = hunk("@@ -1,1 +1,1 @@", [`+  password = "${value}"`]);
  const diff = makeDiff([makeFile("src/db.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "generic-secret");
  assert.equal(findings[0]?.excerpt, "abcd…");
  assert.ok(!findings[0]?.excerpt.includes(value.slice(4)));
});

test("excerpt only reveals first 4 characters", () => {
  const key = "AKIA1234567890ABCDEF";
  const patch = hunk("@@ -1,1 +1,1 @@", [`+"${key}"`]);
  const diff = makeDiff([makeFile("f.ts", patch)]);
  const findings = scanForSecrets(diff);
  const excerpt = findings[0]?.excerpt ?? "";
  assert.equal(excerpt, "AKIA…");
  assert.equal(excerpt.length, 5); // 4 visible chars + ellipsis
});

test("binary files are never scanned", () => {
  const diff = makeDiff([makeFile("blob.bin", "", { status: "binary", linesAdded: 0, linesRemoved: 0 })]);
  assert.deepEqual(scanForSecrets(diff), []);
});

test("multiple added lines across multiple files each produce findings", () => {
  const key1 = "AKIAABCDEFGHIJKLMNOP";
  const key2 = "sk-" + "y".repeat(20);
  const patchA = hunk("@@ -1,1 +1,1 @@", [`+const a = "${key1}";`]);
  const patchB = [`diff --git a/g b/g`, `index 000..111 100644`, `--- a/g`, `+++ b/g`, `@@ -5,1 +5,1 @@`, `+const b = "${key2}";`].join(
    "\n",
  );
  const diff = makeDiff([makeFile("src/one.ts", patchA), makeFile("src/two.ts", patchB)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.file).sort(),
    ["src/one.ts", "src/two.ts"],
  );
});

test("line numbers track the new file version across context and added lines", () => {
  const key = "AKIAABCDEFGHIJKLMNOP";
  const patch = hunk("@@ -10,4 +10,5 @@", [
    " unchanged line 10",
    " unchanged line 11",
    `+const credential = "${key}";`, // this is new-file line 12
    " unchanged line 13",
  ]);
  const diff = makeDiff([makeFile("src/lines.ts", patch)]);
  const findings = scanForSecrets(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 12);
});
