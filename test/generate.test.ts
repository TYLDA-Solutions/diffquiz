import assert from "node:assert/strict";
import { test } from "node:test";
import { generateQuiz } from "../src/generate.ts";
import type { CompleteOptions, DiffSummary, Provider } from "../src/types.ts";

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

function validQuizJson(count: number): string {
  const questions = Array.from({ length: count }, (_, i) => ({
    id: `whatever-${i}`,
    kind: i % 2 === 0 ? "behavior" : "failure",
    question: `Question number ${i + 1}?`,
    options: ["Option A text here", "Option B text here", "Option C text here", "Option D text here"],
    correctIndex: i % 4,
    explanation: `This is the explanation. See src/auth.ts:${i + 1}.`,
    diffRefs: [{ file: "src/auth.ts", lines: [i + 1] }],
  }));
  return JSON.stringify({ questions });
}

/** A Provider whose complete() returns responses from a fixed queue, one per call. */
function queueProvider(name: string, responses: string[]): Provider & { calls: Array<{ prompt: string; opts: CompleteOptions }> } {
  const calls: Array<{ prompt: string; opts: CompleteOptions }> = [];
  return {
    name,
    calls,
    async available() {
      return true;
    },
    async complete(prompt: string, opts: CompleteOptions) {
      calls.push({ prompt, opts });
      const next = responses[calls.length - 1];
      if (next === undefined) {
        throw new Error("queueProvider ran out of canned responses");
      }
      return next;
    },
  };
}

test("generateQuiz happy path returns a validated quiz with generatedBy/model set", async () => {
  const provider = queueProvider("fake-claude", [validQuizJson(3)]);
  const quiz = await generateQuiz(makeDiff(), provider, {
    count: 3,
    language: "en",
    model: "sonnet-test",
    timeoutMs: 5000,
  });

  assert.equal(quiz.questions.length, 3);
  assert.deepEqual(
    quiz.questions.map((q) => q.id),
    ["q1", "q2", "q3"],
  );
  assert.equal(quiz.generatedBy, "fake-claude");
  assert.equal(quiz.model, "sonnet-test");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.opts.model, "sonnet-test");
});

test("generateQuiz omits model when none was requested", async () => {
  const provider = queueProvider("fake-claude", [validQuizJson(3)]);
  const quiz = await generateQuiz(makeDiff(), provider, {
    count: 3,
    language: "en",
    timeoutMs: 5000,
  });
  assert.equal(quiz.model, undefined);
  assert.ok(!("model" in provider.calls[0]!.opts));
});

test("generateQuiz retries once on invalid output and succeeds on the second attempt", async () => {
  const provider = queueProvider("fake-claude", ["not json at all, sorry!", validQuizJson(3)]);
  const quiz = await generateQuiz(makeDiff(), provider, {
    count: 3,
    language: "en",
    timeoutMs: 5000,
  });

  assert.equal(quiz.questions.length, 3);
  assert.equal(provider.calls.length, 2);
  // The corrective retry must quote the validation failure back to the model.
  assert.ok(provider.calls[1]?.prompt.includes("CORRECTION"));
  assert.ok(provider.calls[1]?.prompt.length ?? 0 > (provider.calls[0]?.prompt.length ?? 0));
});

test("generateQuiz retries once on a validation failure (wrong question count), not just parse failure", async () => {
  const provider = queueProvider("fake-claude", [validQuizJson(2), validQuizJson(3)]);
  const quiz = await generateQuiz(makeDiff(), provider, {
    count: 3,
    language: "en",
    timeoutMs: 5000,
  });
  assert.equal(quiz.questions.length, 3);
  assert.equal(provider.calls.length, 2);
});

test("generateQuiz throws after a second consecutive failure", async () => {
  const provider = queueProvider("fake-claude", ["still not json", "also not json"]);
  await assert.rejects(
    () =>
      generateQuiz(makeDiff(), provider, {
        count: 3,
        language: "en",
        timeoutMs: 5000,
      }),
    /INVALID_MODEL_OUTPUT|JSON/i,
  );
  assert.equal(provider.calls.length, 2);
});
