/**
 * Secret heuristics: flags likely credentials on *added* diff lines so the
 * CLI can ask for confirmation before sending the diff to an LLM. Heuristic
 * only — false positives are fine, false negatives are the real risk.
 */
import type { DiffSummary } from "./types.ts";

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  excerpt: string;
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
  /** Substring to redact for the excerpt; defaults to the whole match. */
  extractSecret?: (match: RegExpExecArray) => string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // AWS access key IDs: fixed "AKIA" prefix + 16 uppercase alphanumerics.
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub personal access tokens (classic + fine-grained) share stable prefixes.
  { kind: "github-token", regex: /\b(?:ghp|gho)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  // Slack bot/user/app/refresh tokens: "xox" + one of b/a/p/r/s + "-".
  { kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // PEM-style private key block header (RSA/EC/DSA/OpenSSH/plain).
  { kind: "private-key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/ },
  // JWTs: header and payload are base64url JSON, so both conventionally
  // start with "eyJ" (the encoding of `{"`); three dot-separated segments.
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  // OpenAI/Anthropic-style API keys.
  { kind: "sk-key", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  // Generic "key/secret/token/password = <16+ char value>" assignment.
  {
    kind: "generic-secret",
    regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([A-Za-z0-9_\-/+=]{16,})['"]?/i,
    extractSecret: (m) => m[1] ?? m[0] ?? "",
  },
];

export function scanForSecrets(diff: DiffSummary): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of diff.files) {
    if (file.status === "binary" || file.patch === "") continue;
    findings.push(...scanPatch(file.path, file.patch));
  }
  return findings;
}

function scanPatch(path: string, patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of patch.split("\n")) {
    if (rawLine.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
      newLine = m?.[1] !== undefined ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // skip file headers before the first hunk

    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;

    if (rawLine.startsWith("+")) {
      const content = rawLine.slice(1);
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(content);
        if (match) {
          const secret = pattern.extractSecret ? pattern.extractSecret(match) : match[0];
          findings.push({ file: path, line: newLine, kind: pattern.kind, excerpt: redact(secret) });
        }
      }
      newLine++;
    } else if (rawLine.startsWith("-")) {
      // Removed line: doesn't exist in the new file, no line to advance and
      // never scanned — findings only ever come from added lines.
    } else if (rawLine.startsWith("\\")) {
      // "\ No newline at end of file" marker.
    } else {
      // Context line, present in both old and new — advance the new-file counter.
      newLine++;
    }
  }

  return findings;
}

function redact(secret: string): string {
  return `${secret.slice(0, 4)}…`;
}
