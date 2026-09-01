import assert from "node:assert/strict";
import { test } from "node:test";
import { runDivergence } from "../src/divergence.ts";
import type { CompleteOptions, DiffSummary, Provider, Quiz } from "../src/types.ts";

function makeDiff(): DiffSummary {
  return {
    baseDescription: "merge-base(HEAD, origin/main)",
    files: [
      {
        path: "src/auth.ts",
        status: "modified",
        linesAdded: 2,
        linesRemoved: 1,
        patch: "@@ -1,3 +1,4 @@\n-old\n+new\n+more",
      },
    ],
    totalLinesAdded: 2,
    totalLinesRemoved: 1,
    truncated: false,
    truncationNotes: [],
  };
}

function makeQuiz(): Quiz {
  return {
    generatedBy: "fake",
    questions: [
      {
        id: "q1",
        kind: "behavior",
        question: "What happens now?",
        options: ["A thing", "Another thing", "A third thing", "A fourth thing"],
        correctIndex: 0,
        explanation: "Because src/auth.ts:2 says so.",
        diffRefs: [{ file: "src/auth.ts", lines: [2] }],
      },
      {
        id: "q2",
        kind: "failure",
        question: "What breaks?",
        options: ["Nothing breaks", "It throws", "It hangs", "It silently drops data"],
        correctIndex: 1,
        explanation: "Because src/auth.ts:3 throws.",
        diffRefs: [{ file: "src/auth.ts", lines: [3] }],
      },
    ],
  };
}

/** A Provider whose complete() returns one response per call, in order, cycling if exhausted. */
function sequenceProvider(name: string, responses: string[]): Provider & { callCount: number } {
  let callCount = 0;
  return {
    name,
    get callCount() {
      return callCount;
    },
    async available() {
      return true;
    },
    async complete(_prompt: string, _opts: CompleteOptions) {
      const response = responses[callCount % responses.length];
      callCount++;
      if (response === undefined) throw new Error("no canned response");
      return response;
    },
  };
}

function answerJson(q1: number, q2: number): string {
  return JSON.stringify({ q1, q2 });
}

test("runDivergence: full agreement across runs yields no divergence and full key agreement", async () => {
  const provider = sequenceProvider("fake", [answerJson(0, 1), answerJson(0, 1), answerJson(0, 1)]);
  const report = await runDivergence(makeDiff(), makeQuiz(), provider, {
    runs: 3,
    language: "en",
    timeoutMs: 5000,
  });

  assert.equal(report.runs.length, 3);
  assert.equal(provider.callCount, 3);

  const q1Report = report.perQuestion.find((p) => p.questionId === "q1")!;
  assert.deepEqual(q1Report.distinctAnswers, [0]);
  assert.equal(q1Report.diverged, false);
  assert.equal(q1Report.scattered, false);
  assert.equal(q1Report.agreeWithKey, 3);

  assert.deepEqual(report.flaggedQuestionIds, []);
});

test("runDivergence: a clear majority disagreement is diverged but not scattered, and gets flagged", async () => {
  // q1: two runs say 0, one says 2 -> diverged (2 distinct), majority exists (2/3) -> not scattered -> flagged
  const provider = sequenceProvider("fake", [answerJson(0, 1), answerJson(0, 1), answerJson(2, 1)]);
  const report = await runDivergence(makeDiff(), makeQuiz(), provider, {
    runs: 3,
    language: "en",
    timeoutMs: 5000,
  });

  const q1Report = report.perQuestion.find((p) => p.questionId === "q1")!;
  assert.deepEqual(q1Report.distinctAnswers, [0, 2]);
  assert.equal(q1Report.diverged, true);
  assert.equal(q1Report.scattered, false);
  assert.equal(q1Report.agreeWithKey, 2);
  assert.ok(report.flaggedQuestionIds.includes("q1"));

  const q2Report = report.perQuestion.find((p) => p.questionId === "q2")!;
  assert.equal(q2Report.diverged, false);
  assert.ok(!report.flaggedQuestionIds.includes("q2"));
});

test("runDivergence: scattered answers (no strict majority) are diverged but not flagged", async () => {
  // 4 runs, q1 answers: 0, 1, 2, 3 -- four distinct values, no majority.
  const provider = sequenceProvider("fake", [
    answerJson(0, 1),
    answerJson(1, 1),
    answerJson(2, 1),
    answerJson(3, 1),
  ]);
  const report = await runDivergence(makeDiff(), makeQuiz(), provider, {
    runs: 4,
    language: "en",
    timeoutMs: 5000,
  });

  const q1Report = report.perQuestion.find((p) => p.questionId === "q1")!;
  assert.equal(q1Report.diverged, true);
  assert.equal(q1Report.scattered, true);
  assert.ok(!report.flaggedQuestionIds.includes("q1"), "scattered questions must not be flagged");
});

test("runDivergence: a failed/unparseable run records nulls for every question and does not crash the report", async () => {
  const provider = sequenceProvider("fake", [answerJson(0, 1), "this is not json", answerJson(0, 1)]);
  const report = await runDivergence(makeDiff(), makeQuiz(), provider, {
    runs: 3,
    language: "en",
    timeoutMs: 5000,
  });

  assert.equal(report.runs.length, 3);
  const failedRun = report.runs[1]!;
  assert.equal(failedRun.answers.q1, null);
  assert.equal(failedRun.answers.q2, null);

  // Successful runs still agree fully -> not diverged, and the failed run
  // must not count toward distinctAnswers or agreeWithKey.
  const q1Report = report.perQuestion.find((p) => p.questionId === "q1")!;
  assert.deepEqual(q1Report.distinctAnswers, [0]);
  assert.equal(q1Report.diverged, false);
  assert.equal(q1Report.agreeWithKey, 2);
});

test("runDivergence: partially-invalid answer payload (missing a question id) also counts as a fully failed run", async () => {
  const provider = sequenceProvider("fake", [answerJson(0, 1), JSON.stringify({ q1: 0 }), answerJson(0, 1)]);
  const report = await runDivergence(makeDiff(), makeQuiz(), provider, {
    runs: 3,
    language: "en",
    timeoutMs: 5000,
  });
  const partialRun = report.runs[1]!;
  assert.equal(partialRun.answers.q1, null, "validateAnswers rejects the whole payload, so q1 must be null too");
  assert.equal(partialRun.answers.q2, null);
});

test("runDivergence executes runs sequentially in order", async () => {
  const order: number[] = [];
  let n = 0;
  const provider: Provider = {
    name: "fake",
    async available() {
      return true;
    },
    async complete() {
      const mine = n++;
      // Later calls resolve faster, which would reorder results if the
      // implementation ran runs concurrently instead of sequentially.
      await new Promise((r) => setTimeout(r, (3 - mine) * 5));
      order.push(mine);
      return answerJson(0, 1);
    },
  };
  await runDivergence(makeDiff(), makeQuiz(), provider, { runs: 3, language: "en", timeoutMs: 5000 });
  assert.deepEqual(order, [0, 1, 2]);
});
