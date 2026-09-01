/**
 * Shared type contracts for diffquiz.
 *
 * This file is the single source of truth for the shapes passed between
 * modules. Changes here ripple everywhere — keep it minimal and stable.
 */

// ---------------------------------------------------------------------------
// Diff collection
// ---------------------------------------------------------------------------

export interface DiffFile {
  /** Path relative to the repo root (the "b/" side; for deletions the "a/" side). */
  path: string;
  /** Change type derived from the diff header. */
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  /** Previous path for renames, otherwise undefined. */
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
  /** The raw unified-diff hunk text for this file (headers included). Empty for binary files. */
  patch: string;
}

export interface DiffSummary {
  /** Ref the diff was computed against (e.g. "merge-base(HEAD, origin/main)"). */
  baseDescription: string;
  files: DiffFile[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  /** True when large files/hunks were sampled or truncated to fit the size budget. */
  truncated: boolean;
  /** Human-readable notes about what was left out, empty when truncated is false. */
  truncationNotes: string[];
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export type QuestionKind =
  | "behavior" // what does the change do at runtime
  | "data" // effect on existing data / state / persistence
  | "failure" // what breaks / edge cases / error paths
  | "no-change"; // which part is a pure move/no-op (guessing counterweight)

export interface DiffRef {
  /** File path as it appears in DiffFile.path. */
  file: string;
  /** 1-based line numbers in the NEW file version (or old version for pure deletions). */
  lines: number[];
}

export interface QuizQuestion {
  /** Stable id within the quiz, "q1".."q5". */
  id: string;
  kind: QuestionKind;
  question: string;
  /** Exactly 4 answer options, plain text, no "A)"-style prefixes. */
  options: [string, string, string, string];
  /** Index into options, 0-3. */
  correctIndex: number;
  /** Max two sentences, references concrete lines ("src/auth.ts:42"). */
  explanation: string;
  diffRefs: DiffRef[];
}

export interface Quiz {
  questions: QuizQuestion[];
  /** Provider that generated the quiz, e.g. "claude". */
  generatedBy: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

export interface AnswerRecord {
  questionId: string;
  /** Index the player chose, or null when the question was skipped (non-TTY abort). */
  chosenIndex: number | null;
  correct: boolean;
}

export interface QuizResult {
  answers: AnswerRecord[];
  correctCount: number;
  questionCount: number;
  durationMs: number;
  /** ISO timestamp of when the quiz was played. */
  playedAt: string;
}

// ---------------------------------------------------------------------------
// Divergence mode
// ---------------------------------------------------------------------------

export interface DivergenceRun {
  /** 0-based run number. */
  run: number;
  /** Chosen option index per question id; null when the run failed to answer. */
  answers: Record<string, number | null>;
}

export interface DivergenceQuestionReport {
  questionId: string;
  /** Distinct option indexes chosen across runs (nulls excluded). */
  distinctAnswers: number[];
  /** True when at least two runs disagree — the ambiguity signal. */
  diverged: boolean;
  /** True when runs scattered with no majority — likely a bad question, not unclear code. */
  scattered: boolean;
  /** How many runs picked the generator's correctIndex. */
  agreeWithKey: number;
}

export interface DivergenceReport {
  runs: DivergenceRun[];
  perQuestion: DivergenceQuestionReport[];
  /** Question ids worth flagging in a PR comment (diverged, not scattered). */
  flaggedQuestionIds: string[];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  /** Model override passed through to the underlying CLI when supported. */
  model?: string;
  timeoutMs: number;
}

export interface Provider {
  /** Short name used in --provider and in reports, e.g. "claude", "codex", "custom". */
  readonly name: string;
  /** True when the underlying CLI is installed and usable. */
  available(): Promise<boolean>;
  /**
   * Send one prompt, return the raw completion text.
   * Must never invoke a shell; must enforce opts.timeoutMs.
   */
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiffQuizConfig {
  /** "claude" | "codex" | "auto" | "custom". Default "auto". */
  provider?: string;
  model?: string;
  /** 3..5, default 3. */
  questions?: number;
  /** Max changed lines before refusing / sampling. Default 2000. */
  maxLines?: number;
  /** Default true. */
  secretScan?: boolean;
  /** Provider timeout in seconds. Default 180. */
  timeoutSeconds?: number;
  /** Language for questions/explanations, BCP-47-ish ("en", "de"). Default "en". */
  language?: string;
  /**
   * Custom provider command, argv array; the prompt is written to stdin,
   * the completion is read from stdout. Example: ["llm", "-m", "gpt-5"].
   */
  customCommand?: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "NOT_A_REPO"
  | "EMPTY_DIFF"
  | "DIFF_TOO_LARGE"
  | "SECRETS_DETECTED"
  | "NO_PROVIDER"
  | "PROVIDER_FAILED"
  | "INVALID_MODEL_OUTPUT"
  | "BAD_CONFIG"
  | "BAD_USAGE";

/** Exit codes: 0 success (any score — never blocks), 1 unexpected, 2 refused precondition, 3 provider/generation failure. */
export class DiffQuizError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "DiffQuizError";
    this.code = code;
    this.hint = hint;
  }

  get exitCode(): number {
    switch (this.code) {
      case "NOT_A_REPO":
      case "EMPTY_DIFF":
      case "DIFF_TOO_LARGE":
      case "SECRETS_DETECTED":
      case "BAD_CONFIG":
      case "BAD_USAGE":
        return 2;
      case "NO_PROVIDER":
      case "PROVIDER_FAILED":
      case "INVALID_MODEL_OUTPUT":
        return 3;
    }
  }
}
