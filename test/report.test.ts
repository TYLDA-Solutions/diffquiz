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
