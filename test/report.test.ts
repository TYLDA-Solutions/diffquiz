import { test } from "node:test";
import assert from "node:assert/strict";
import type { DivergenceReport, Quiz, QuizResult } from "../src/types.ts";
import { renderMarkdown, renderPrint, renderTerminal } from "../src/report.ts";
import type { ReportMeta } from "../src/report.ts";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/;

function makeQuiz(): Quiz {
  return {
    generatedBy: "claude",
    model: "claude-sonnet",
    questions: [
      {
        id: "q1",
        kind: "behavior",
        question: "What does the new function return on empty input?",
        options: ["null", "an empty array", "throws", "undefined"],
        correctIndex: 0,
        explanation: "It short-circuits and returns null. See src/foo.ts:10.",
        diffRefs: [{ file: "src/foo.ts", lines: [10] }],
      },
      {
        id: "q2",
        kind: "data",
        question: "Does the migration touch existing rows?",
        options: ["yes, backfills", "no, only new rows", "drops the table", "renames the column"],
        correctIndex: 1,
        explanation: "The migration only affects newly inserted rows. See db/migrate.ts:5.",
        diffRefs: [{ file: "db/migrate.ts", lines: [5] }],
      },
      {
        id: "q3",
        kind: "failure",
        question: "What happens if the network call fails?",
        options: ["crashes", "retries forever", "logs and continues", "silently swallows"],
        correctIndex: 2,
        explanation: "Errors are logged and the caller continues. See src/net.ts:20.",
        diffRefs: [{ file: "src/net.ts", lines: [20] }],
      },
    ],
  };
}

function makeResult(correctCount: number): QuizResult {
  const quiz = makeQuiz();
  const answers = quiz.questions.map((q, i) => {
    if (i < correctCount) return { questionId: q.id, chosenIndex: q.correctIndex, correct: true };
    return { questionId: q.id, chosenIndex: (q.correctIndex + 1) % 4, correct: false };
  });
  return {
    answers,
    correctCount,
    questionCount: quiz.questions.length,
    durationMs: 48_000,
    playedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeMeta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    baseDescription: "main",
    provider: "claude",
    truncated: false,
    version: "0.1.0",
    ...overrides,
  };
}

test("renderMarkdown: contains one details block per question with chosen vs correct", () => {
  const quiz = makeQuiz();
  const result = makeResult(2);
  const md = renderMarkdown(quiz, result, null, makeMeta());

  assert.match(md, /### 🎯 diffquiz — 2\/3 on this diff \(48s\)/);
  assert.match(md, /Non-blocking self-check/);

  const detailsCount = (md.match(/<details>/g) ?? []).length;
  assert.equal(detailsCount, 3);
  const summaryCount = (md.match(/<summary>/g) ?? []).length;
  assert.equal(summaryCount, 3);

  for (const q of quiz.questions) {
    assert.match(md, new RegExp(q.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(md, new RegExp(`Explanation: ${q.explanation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }

  // Refs are file:line only, no patch excerpts.
  assert.match(md, /Refs: src\/foo\.ts:10/);
  assert.match(md, /Refs: db\/migrate\.ts:5/);
  assert.match(md, /Refs: src\/net\.ts:20/);

  // Chosen vs correct for the last (wrong) answer.
  assert.match(md, /Chosen: silently swallows/);
  assert.match(md, /Correct: logs and continues/);
});

test("renderMarkdown: never contains ANSI escape codes", () => {
  const quiz = makeQuiz();
  const result = makeResult(1);
  const divergence: DivergenceReport = {
    runs: [
      { run: 0, answers: { q1: 0, q2: 1, q3: 2 } },
      { run: 1, answers: { q1: 0, q2: 2, q3: 2 } },
      { run: 2, answers: { q1: 0, q2: 1, q3: 2 } },
    ],
    perQuestion: [
      { questionId: "q1", distinctAnswers: [0], diverged: false, scattered: false, agreeWithKey: 3 },
      { questionId: "q2", distinctAnswers: [1, 2], diverged: true, scattered: false, agreeWithKey: 2 },
      { questionId: "q3", distinctAnswers: [2], diverged: false, scattered: false, agreeWithKey: 3 },
    ],
    flaggedQuestionIds: ["q2"],
  };
  const md = renderMarkdown(quiz, result, divergence, makeMeta({ truncated: true, model: "sonnet" }));

  assert.equal(ANSI_PATTERN.test(md), false);
  assert.match(md, /Divergence check/);
  assert.match(md, /q2|Does the migration touch existing rows/);
  assert.match(md, /truncated/i);
  assert.match(md, /claude \(sonnet\)/);
});

test("renderMarkdown: divergence section only appears when divergence is passed", () => {
  const quiz = makeQuiz();
  const result = makeResult(3);
  const withoutDivergence = renderMarkdown(quiz, result, null, makeMeta());
  assert.doesNotMatch(withoutDivergence, /Divergence check/);
});

test("renderMarkdown: handles a null result (not yet played)", () => {
  const quiz = makeQuiz();
  const md = renderMarkdown(quiz, null, null, makeMeta());
  assert.match(md, /### 🎯 diffquiz — 3 questions on this diff/);
  assert.doesNotMatch(md, /Chosen:/);
  assert.match(md, /Correct: no, only new rows/);
});

test("renderMarkdown: deterministic given fixed inputs", () => {
  const quiz = makeQuiz();
  const result = makeResult(2);
  const meta = makeMeta();
  const a = renderMarkdown(quiz, result, null, meta);
  const b = renderMarkdown(quiz, result, null, meta);
  assert.equal(a, b);
});

test("renderTerminal: compact colored summary with counts", () => {
  const quiz = makeQuiz();
  const result = makeResult(2);
  const text = renderTerminal(quiz, result, makeMeta());
  assert.match(text, /2\/3 in 48s/);
  assert.match(text, /q1/);
  assert.match(text, /q2/);
  assert.match(text, /q3/);
});

// ---------------------------------------------------------------------------
// FIX 3 — markdown escaping of model-derived strings
// ---------------------------------------------------------------------------

function makeHostileQuiz(): Quiz {
  return {
    generatedBy: "claude",
    questions: [
      {
        id: "q1",
        kind: "behavior",
        question: "Does this break out</details> of the block?",
        options: [
          "![tracking pixel](http://evil.example/pixel.png)",
          "[click me](http://evil.example/phish)",
          "uses a `backtick` and a | pipe",
          "plain option",
        ],
        // correctIndex/chosenIndex determine which *single* option string
        // ends up in the rendered "- Correct:"/"- Chosen:" lines (the block
        // does not dump the full options array) — point them at the option
        // strings this test needs to see escaped.
        correctIndex: 2,
        explanation: "See ![x](http://evil.example) and [a](b) plus `code` | pipe.",
        diffRefs: [{ file: "src/</details>evil.ts", lines: [1] }],
      },
    ],
  };
}

test("renderMarkdown: escapes </details> in the question so it cannot break the PR comment structure", () => {
  const quiz = makeHostileQuiz();
  const md = renderMarkdown(quiz, null, null, makeMeta());
  assert.doesNotMatch(md, /Does this break out<\/details>/);
  assert.match(md, /Does this break out&lt;\/details&gt;/);
  // Exactly one real <details> open/close pair (from the wrapper), not one
  // extra opened/closed by the injected string.
  assert.equal((md.match(/<details>/g) ?? []).length, 1);
  assert.equal((md.match(/<\/details>/g) ?? []).length, 1);
});

function makeHostileResult(chosenIndex: number, correct: boolean): QuizResult {
  return {
    answers: [{ questionId: "q1", chosenIndex, correct }],
    correctCount: correct ? 1 : 0,
    questionCount: 1,
    durationMs: 1000,
    playedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("renderMarkdown: neutralizes image/link markdown syntax in options and explanation", () => {
  const quiz = makeHostileQuiz();
  // chosenIndex 0 -> "Chosen:" renders the tracking-pixel image option;
  // chosenIndex 1 (click me) is exercised in a second pass below.
  const md = renderMarkdown(quiz, makeHostileResult(1, false), null, makeMeta());
  assert.doesNotMatch(md, /!\[tracking pixel\]\(http:\/\/evil\.example\/pixel\.png\)/);
  assert.doesNotMatch(md, /\[click me\]\(http:\/\/evil\.example\/phish\)/);
  assert.doesNotMatch(md, /\[a\]\(b\)/);
  assert.doesNotMatch(md, /!\[x\]\(http:\/\/evil\.example\)/);
  // Escaped forms are present instead ("Chosen:" = click-me link option).
  assert.match(md, /\\\[click me\\\]\\\(http:\/\/evil\.example\/phish\\\)/);
  assert.match(md, /See !\\\[x\\\]\\\(http:\/\/evil\.example\\\) and \\\[a\\\]\\\(b\\\)/);

  const md2 = renderMarkdown(quiz, makeHostileResult(0, false), null, makeMeta());
  assert.doesNotMatch(md2, /!\[tracking pixel\]\(http:\/\/evil\.example\/pixel\.png\)/);
  assert.match(md2, /!\\\[tracking pixel\\\]\\\(http:\/\/evil\.example\/pixel\.png\\\)/);
});

test("renderMarkdown: escapes backticks and pipes in options/explanation", () => {
  const quiz = makeHostileQuiz();
  const md = renderMarkdown(quiz, null, null, makeMeta());
  assert.doesNotMatch(md, /uses a `backtick` and a \| pipe/);
  assert.match(md, /Correct: uses a \\`backtick\\` and a \\\| pipe/);
  assert.match(md, /plus \\`code\\` \\\| pipe/);
});

test("renderMarkdown: escapes diffRefs file paths too", () => {
  const quiz = makeHostileQuiz();
  const md = renderMarkdown(quiz, null, null, makeMeta());
  assert.doesNotMatch(md, /Refs: src\/<\/details>evil\.ts/);
  assert.match(md, /Refs: src\/&lt;\/details&gt;evil\.ts/);
});

test("renderTerminal and renderPrint: do NOT markdown-escape (plain text for TTY)", () => {
  const quiz = makeHostileQuiz();
  const result: QuizResult = {
    answers: [{ questionId: "q1", chosenIndex: 0, correct: true }],
    correctCount: 1,
    questionCount: 1,
    durationMs: 1000,
    playedAt: "2026-01-01T00:00:00.000Z",
  };
  const terminalText = renderTerminal(quiz, result, makeMeta());
  assert.doesNotMatch(terminalText, /&lt;|&gt;/);

  const printText = renderPrint(quiz);
  assert.match(printText, /Does this break out<\/details> of the block\?/);
  assert.match(printText, /!\[tracking pixel\]\(http:\/\/evil\.example\/pixel\.png\)/);
  assert.doesNotMatch(printText, /&lt;|&gt;/);
});

// ---------------------------------------------------------------------------
// FIX 4 — divergence section when runs failed
// ---------------------------------------------------------------------------

test("renderMarkdown: divergence section warns when every run failed (all answers null)", () => {
  const quiz = makeQuiz();
  const result = makeResult(0);
  const divergence: DivergenceReport = {
    runs: [
      { run: 0, answers: { q1: null, q2: null, q3: null } },
      { run: 1, answers: { q1: null, q2: null, q3: null } },
      { run: 2, answers: { q1: null, q2: null, q3: null } },
    ],
    perQuestion: [
      { questionId: "q1", distinctAnswers: [], diverged: false, scattered: false, agreeWithKey: 0 },
      { questionId: "q2", distinctAnswers: [], diverged: false, scattered: false, agreeWithKey: 0 },
      { questionId: "q3", distinctAnswers: [], diverged: false, scattered: false, agreeWithKey: 0 },
    ],
    flaggedQuestionIds: [],
  };
  const md = renderMarkdown(quiz, result, divergence, makeMeta());
  assert.doesNotMatch(md, /No questions flagged — independent runs agreed\./);
  assert.match(md, /No usable divergence data — all 3 runs failed/);
});

test("renderMarkdown: divergence section notes partial usable runs", () => {
  const quiz = makeQuiz();
  const result = makeResult(1);
  const divergence: DivergenceReport = {
    runs: [
      { run: 0, answers: { q1: 0, q2: 1, q3: 2 } },
      { run: 1, answers: { q1: null, q2: null, q3: null } },
      { run: 2, answers: { q1: null, q2: null, q3: null } },
    ],
    perQuestion: [
      { questionId: "q1", distinctAnswers: [0], diverged: false, scattered: false, agreeWithKey: 1 },
      { questionId: "q2", distinctAnswers: [1], diverged: false, scattered: false, agreeWithKey: 1 },
      { questionId: "q3", distinctAnswers: [2], diverged: false, scattered: false, agreeWithKey: 1 },
    ],
    flaggedQuestionIds: [],
  };
  const md = renderMarkdown(quiz, result, divergence, makeMeta());
  assert.match(md, /No questions flagged — independent runs agreed\./);
  assert.match(md, /\(1 of 3 runs usable\)/);
});

test("renderPrint: marks the correct option for every question", () => {
  const quiz = makeQuiz();
  const text = renderPrint(quiz);
  assert.match(text, /3 questions \(spoiler view\)/);
  // Correct options: "null", "no, only new rows", "logs and continues"
  assert.match(text, /1\) null ✔/);
  assert.match(text, /2\) no, only new rows ✔/);
  assert.match(text, /3\) logs and continues ✔/);
  // All explanations shown.
  for (const q of quiz.questions) {
    assert.ok(text.includes(q.explanation));
  }
});
