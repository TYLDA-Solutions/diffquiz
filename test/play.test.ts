import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { Quiz } from "../src/types.ts";
import { DiffQuizError } from "../src/types.ts";
import { playQuiz } from "../src/play.ts";

function makeQuiz(): Quiz {
  return {
    generatedBy: "test",
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

function makeIo() {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = "";
  output.on("data", (chunk) => {
    captured += chunk.toString("utf8");
  });
  return { input, output, getOutput: () => captured };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Feeds answer lines into `input` one at a time with a small pacing delay
 * between writes. readline resolves each `rl.question()` call with a
 * one-time listener registered only once the previous question settles, so
 * writing every line up front (before the interface has asked the next
 * question) races ahead of those listeners and the extra lines are silently
 * dropped. Pacing the writes — a macrotask apart — reliably lands each line
 * after the corresponding listener is registered.
 */
async function sendAnswersPaced(input: PassThrough, lines: string[]): Promise<void> {
  for (const line of lines) {
    await delay(5);
    input.write(`${line}\n`);
  }
  input.end();
}

test("playQuiz: correct, skipped-after-two-invalid, and correct-after-one-invalid", async () => {
  const quiz = makeQuiz();
  const { input, output, getOutput } = makeIo();

  // q1: correct answer "1" -> index 0
  // q2: two invalid inputs -> skipped (chosenIndex null)
  // q3: one invalid input, then valid "c" -> index 2 (correct)
  const resultPromise = playQuiz(quiz, { input, output });
  await sendAnswersPaced(input, ["1", "zzz", "yyy", "q", "c"]);
  const result = await resultPromise;

  assert.equal(result.questionCount, 3);
  assert.equal(result.correctCount, 2);
  assert.equal(result.answers.length, 3);

  assert.deepEqual(result.answers[0], { questionId: "q1", chosenIndex: 0, correct: true });
  assert.deepEqual(result.answers[1], { questionId: "q2", chosenIndex: null, correct: false });
  assert.deepEqual(result.answers[2], { questionId: "q3", chosenIndex: 2, correct: true });

  assert.match(result.playedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.durationMs >= 0);

  const text = getOutput();
  // Each question is asked exactly once — no retry beyond the single reprompt.
  assert.equal((text.match(/Question 1\/3/g) ?? []).length, 1);
  assert.equal((text.match(/Question 2\/3/g) ?? []).length, 1);
  assert.equal((text.match(/Question 3\/3/g) ?? []).length, 1);

  // Reprompt hint appears exactly for the two invalid-first attempts (q2, q3).
  assert.equal((text.match(/Please answer with 1-4/g) ?? []).length, 2);

  // Correctness markers.
  assert.match(text, /Correct/);
  assert.match(text, /Skipped/);
  assert.match(text, /\d+\/3 in \d+s/);
});

test("playQuiz: accepts letters a-d case-insensitively and is trimmed", async () => {
  const quiz: Quiz = {
    generatedBy: "test",
    questions: [
      {
        id: "q1",
        kind: "no-change",
        question: "Which of these is a pure move?",
        options: ["opt a", "opt b", "opt c", "opt d"],
        correctIndex: 3,
        explanation: "It is a pure move. See src/x.ts:1.",
        diffRefs: [{ file: "src/x.ts", lines: [1] }],
      },
    ],
  };
  const { input, output } = makeIo();
  input.write("  D  \n");
  input.end();

  const result = await playQuiz(quiz, { input, output });
  assert.deepEqual(result.answers[0], { questionId: "q1", chosenIndex: 3, correct: true });
});

test("playQuiz: rejects with BAD_USAGE when input is explicitly not a TTY", async () => {
  const quiz = makeQuiz();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = false;
  const output = new PassThrough();

  await assert.rejects(
    () => playQuiz(quiz, { input, output }),
    (err: unknown) => {
      assert.ok(err instanceof DiffQuizError);
      assert.equal(err.code, "BAD_USAGE");
      return true;
    },
  );
});

test("playQuiz: allows injected streams without an isTTY property (test streams)", async () => {
  const quiz: Quiz = {
    generatedBy: "test",
    questions: [
      {
        id: "q1",
        kind: "behavior",
        question: "Sanity check?",
        options: ["a", "b", "c", "d"],
        correctIndex: 0,
        explanation: "a is correct. See src/x.ts:1.",
        diffRefs: [{ file: "src/x.ts", lines: [1] }],
      },
    ],
  };
  const { input, output } = makeIo();
  assert.equal((input as { isTTY?: boolean }).isTTY, undefined);
  input.write("1\n");
  input.end();

  const result = await playQuiz(quiz, { input, output });
  assert.equal(result.correctCount, 1);
});

test("playQuiz: header mentions question count and that nothing blocks", async () => {
  const quiz = makeQuiz();
  const { input, output, getOutput } = makeIo();
  const resultPromise = playQuiz(quiz, { input, output });
  await sendAnswersPaced(input, ["1", "2", "c"]);
  await resultPromise;
  const text = getOutput();
  assert.match(text, /3 questions/);
  assert.match(text, /nothing here blocks you|nothing blocks/i);
});
