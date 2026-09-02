/**
 * Model-output parsing & validation.
 *
 * LLM CLIs are chatty: even with "JSON only" instructions they sometimes wrap
 * output in prose or fenced code blocks, use the wrong field names, or invent
 * a 5th option. Everything here is deliberately paranoid — malformed output
 * must fail loudly with `INVALID_MODEL_OUTPUT`, never silently degrade into a
 * broken quiz.
 */
import { DiffQuizError, type DiffRef, type Quiz, type QuestionKind, type QuizQuestion } from "./types.ts";

const EXCERPT_MAX = 200;

function excerpt(text: string, max: number = EXCERPT_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Recovers a JSON value from raw model output. Tries, in order: direct
 * `JSON.parse`, the contents of a fenced ```json block, then the widest
 * `{...}`/`[...]` slice in the text. Throws `INVALID_MODEL_OUTPUT` with a
 * short excerpt of the offending text if none of those parse.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new DiffQuizError("INVALID_MODEL_OUTPUT", "Model output was empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not raw JSON — keep trying.
  }

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch) {
    const inner = fenceMatch[1];
    if (inner !== undefined) {
      try {
        return JSON.parse(inner.trim());
      } catch {
        // Fenced block wasn't valid JSON either — keep trying.
      }
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let start = -1;
  let closeChar = "";
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    closeChar = "}";
  } else if (firstBracket !== -1) {
    start = firstBracket;
    closeChar = "]";
  }
  if (start !== -1) {
    const end = trimmed.lastIndexOf(closeChar);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Slice wasn't balanced/valid JSON — fall through to the error.
      }
    }
  }

  throw new DiffQuizError(
    "INVALID_MODEL_OUTPUT",
    "Model output did not contain valid JSON.",
    excerpt(trimmed),
  );
}

/**
 * Strips terminal/markdown-hostile sequences from model-supplied strings
 * before they're accepted into a `Quiz`: complete ANSI CSI sequences (e.g.
 * cursor moves, screen clears), complete OSC sequences (e.g. hyperlink/title
 * injection, terminated by BEL or ST), and any remaining C0 control
 * characters except `\n`/`\t`. This runs on every question, option,
 * explanation, and diffRefs file string — the only place LLM output enters
 * `Quiz`, so it's the single choke point that has to catch this.
 */
const CSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// Remaining C0 controls (0x00-0x1F minus \t=0x09, \n=0x0A) plus DEL (0x7F).
// This range includes ESC (0x1B), which mops up any bare/incomplete escape
// sequence left after the CSI/OSC passes above.
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeModelText(text: string): string {
  return text.replace(CSI_SEQUENCE_RE, "").replace(OSC_SEQUENCE_RE, "").replace(CONTROL_CHAR_RE, "");
}

const VALID_KINDS: readonly QuestionKind[] = ["behavior", "data", "failure", "no-change"];

function coerceKind(raw: unknown): QuestionKind {
  if (typeof raw !== "string") return "behavior";
  const normalized = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if ((VALID_KINDS as readonly string[]).includes(normalized)) {
    return normalized as QuestionKind;
  }
  if (normalized === "behaviour") return "behavior";
  if (normalized === "nochange" || normalized === "no-op" || normalized === "noop" || normalized === "move" || normalized === "unchanged") {
    return "no-change";
  }
  if (normalized === "error" || normalized === "edge-case" || normalized === "edgecase" || normalized === "bug" || normalized === "crash") {
    return "failure";
  }
  return "behavior";
}

/**
 * Keeps at most the first two sentences of `text`, trimmed. A sentence
 * boundary is `.`/`!`/`?` immediately preceded by a word/quote/paren
 * character AND followed by whitespace-then-uppercase (or the end of the
 * string) — not just any punctuation run. The lookbehind is what keeps a
 * mid-sentence `??` (e.g. "replaces the ?? 0 fallback") from being
 * mistaken for a boundary: the char right before that run is a space, not a
 * word/quote/paren char, so it fails the lookbehind and sentence 2 survives.
 * File citations like `src/x.ts:12` and decimals like `3.14` still don't
 * false-trigger because they're never followed by whitespace.
 */
function limitToTwoSentences(text: string): string {
  const boundary = /(?<=[A-Za-z0-9)"'])[.!?]+(?=\s+[A-Z0-9"'(]|\s*$)/g;
  const sentences: string[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while (sentences.length < 2 && (match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(lastEnd, end).trim());
    lastEnd = end;
  }
  if (sentences.length < 2) {
    const rest = text.slice(lastEnd).trim();
    if (rest.length > 0) sentences.push(rest);
  }
  return sentences.length > 0 ? sentences.join(" ").trim() : text.trim();
}

/**
 * Requires a non-empty string, sanitizing terminal/markdown-hostile escape
 * sequences (see `sanitizeModelText`) before the emptiness check — a string
 * that's nothing but stripped control sequences must still fail validation
 * rather than sneak through as "".
 */
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new DiffQuizError("INVALID_MODEL_OUTPUT", `Field "${label}" must be a non-empty string.`);
  }
  const cleaned = sanitizeModelText(value).trim();
  if (cleaned.length === 0) {
    throw new DiffQuizError("INVALID_MODEL_OUTPUT", `Field "${label}" must be a non-empty string.`);
  }
  return cleaned;
}

function extractDiffRefs(raw: unknown): DiffRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: DiffRef[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const file = obj["file"];
    const lines = obj["lines"];
    if (typeof file !== "string") continue;
    const cleanedFile = sanitizeModelText(file).trim();
    if (cleanedFile.length === 0) continue;
    if (!Array.isArray(lines)) continue;
    const numericLines = lines.filter(
      (l): l is number => typeof l === "number" && Number.isInteger(l) && l > 0,
    );
    if (numericLines.length === 0) continue;
    refs.push({ file: cleanedFile, lines: numericLines });
  }
  return refs;
}

function extractQuestionsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && "questions" in value) {
    const q = (value as { questions: unknown }).questions;
    if (Array.isArray(q)) return q;
  }
  throw new DiffQuizError(
    "INVALID_MODEL_OUTPUT",
    "Model output must be a JSON array of questions, or an object with a `questions` array.",
    excerpt(JSON.stringify(value) ?? String(value)),
  );
}

function validateQuestion(raw: unknown, index: number): QuizQuestion {
  if (raw === null || typeof raw !== "object") {
    throw new DiffQuizError("INVALID_MODEL_OUTPUT", `Question ${index + 1} is not an object.`);
  }
  const obj = raw as Record<string, unknown>;

  const question = requireNonEmptyString(obj["question"], `questions[${index}].question`);

  const optionsRaw = obj["options"];
  if (!Array.isArray(optionsRaw) || optionsRaw.length !== 4) {
    throw new DiffQuizError(
      "INVALID_MODEL_OUTPUT",
      `Question ${index + 1} must have exactly 4 options, got ${Array.isArray(optionsRaw) ? optionsRaw.length : "a non-array"}.`,
    );
  }
  const optionStrings = optionsRaw.map((opt, i) =>
    requireNonEmptyString(opt, `questions[${index}].options[${i}]`),
  );
  const options: [string, string, string, string] = [
    optionStrings[0]!,
    optionStrings[1]!,
    optionStrings[2]!,
    optionStrings[3]!,
  ];

  const uniqueOptions = new Set(options.map((o) => o.toLowerCase()));
  if (uniqueOptions.size !== options.length) {
    throw new DiffQuizError("INVALID_MODEL_OUTPUT", `Question ${index + 1} has duplicate options.`);
  }

  const correctIndexRaw = obj["correctIndex"];
  if (
    typeof correctIndexRaw !== "number" ||
    !Number.isInteger(correctIndexRaw) ||
    correctIndexRaw < 0 ||
    correctIndexRaw > 3
  ) {
    throw new DiffQuizError(
      "INVALID_MODEL_OUTPUT",
      `Question ${index + 1} has an invalid correctIndex (must be an integer 0-3).`,
    );
  }

  const explanation = limitToTwoSentences(
    requireNonEmptyString(obj["explanation"], `questions[${index}].explanation`),
  );
  const kind = coerceKind(obj["kind"]);
  const diffRefs = extractDiffRefs(obj["diffRefs"]);

  return {
    id: `q${index + 1}`,
    kind,
    question,
    options,
    correctIndex: correctIndexRaw,
    explanation,
    diffRefs,
  };
}

/**
 * Validates and normalizes a parsed model response into a fully-typed
 * `Quiz`. Enforces the exact expected question count, exactly 4 options per
 * question, a valid `correctIndex`, non-empty strings throughout, deduped
 * options, and rewrites ids to `q1..qN` regardless of what the model used.
 * `generatedBy`/`model` are left for the caller (which knows the provider)
 * to fill in.
 */
export function validateQuiz(value: unknown, expected: { count: number }): Quiz {
  const rawQuestions = extractQuestionsArray(value);
  if (rawQuestions.length !== expected.count) {
    throw new DiffQuizError(
      "INVALID_MODEL_OUTPUT",
      `Expected exactly ${expected.count} questions, got ${rawQuestions.length}.`,
    );
  }

  const questions = rawQuestions.map((raw, index) => validateQuestion(raw, index));

  return {
    questions,
    generatedBy: "",
  };
}

/**
 * Validates a divergence-run answer payload against a quiz: every question
 * id must map to an integer 0-3. Missing or malformed answers throw
 * `INVALID_MODEL_OUTPUT` — callers (divergence.ts) are expected to catch
 * that per-run and record it as a failed run rather than aborting the whole
 * batch.
 */
export function validateAnswers(value: unknown, quiz: Quiz): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DiffQuizError(
      "INVALID_MODEL_OUTPUT",
      "Expected a JSON object mapping question ids to answer indexes.",
    );
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const q of quiz.questions) {
    const raw = record[q.id];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 3) {
      throw new DiffQuizError(
        "INVALID_MODEL_OUTPUT",
        `Missing or invalid answer for question "${q.id}" (expected an integer 0-3).`,
      );
    }
    result[q.id] = raw;
  }
  return result;
}
