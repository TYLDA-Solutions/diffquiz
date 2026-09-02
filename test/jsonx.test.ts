import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractJson, sanitizeModelText, validateAnswers, validateQuiz } from "../src/jsonx.ts";
import { DiffQuizError, type Quiz } from "../src/types.ts";

function validQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "whatever",
    kind: "behavior",
    question: "What happens when the input array is empty?",
    options: ["It throws", "It returns null", "It returns an empty array", "It hangs"],
    correctIndex: 2,
    explanation: "The guard at src/x.ts:12 returns [] early. Nothing else runs.",
    diffRefs: [{ file: "src/x.ts", lines: [12, 13] }],
    ...overrides,
  };
}

function validQuizPayload(count = 3): { questions: Record<string, unknown>[] } {
  return {
    questions: Array.from({ length: count }, (_, i) =>
      validQuestion({ question: `Question number ${i + 1}?` }),
    ),
  };
}

describe("extractJson", () => {
  test("parses direct JSON", () => {
    const result = extractJson('{"a": 1, "b": [1,2,3]}');
    assert.deepEqual(result, { a: 1, b: [1, 2, 3] });
  });

  test("parses JSON inside a fenced ```json block", () => {
    const text = 'Here is your answer:\n```json\n{"a": 1}\n```\nHope that helps!';
    const result = extractJson(text);
    assert.deepEqual(result, { a: 1 });
  });

  test("parses JSON inside a fenced block without the json tag", () => {
    const text = "```\n{\"a\": 2}\n```";
    const result = extractJson(text);
    assert.deepEqual(result, { a: 2 });
  });

  test("parses JSON embedded in prose", () => {
    const text = 'Sure, here you go: {"a": 3, "nested": {"b": 4}} — let me know if you need more.';
    const result = extractJson(text);
    assert.deepEqual(result, { a: 3, nested: { b: 4 } });
  });

  test("parses a JSON array embedded in prose", () => {
    const text = "The questions are: [1, 2, 3] as requested.";
    const result = extractJson(text);
    assert.deepEqual(result, [1, 2, 3]);
  });

  test("throws INVALID_MODEL_OUTPUT with an excerpt on garbage input", () => {
    const text = "I cannot help with that request, sorry, no JSON here at all.";
    assert.throws(
      () => extractJson(text),
      (err: unknown) => {
        assert.ok(err instanceof DiffQuizError);
        assert.equal(err.code, "INVALID_MODEL_OUTPUT");
        assert.ok(err.hint !== undefined && err.hint.length > 0);
        assert.ok(err.hint.length <= 201); // 200 chars + ellipsis
        return true;
      },
    );
  });

  test("throws INVALID_MODEL_OUTPUT on empty input", () => {
    assert.throws(
      () => extractJson("   "),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  });

  test("excerpt is capped and does not include the entire huge input", () => {
    const huge = "x".repeat(5000);
    assert.throws(
      () => extractJson(huge),
      (err: unknown) => {
        assert.ok(err instanceof DiffQuizError);
        assert.ok(err.hint !== undefined && err.hint.length < 5000);
        return true;
      },
    );
  });
});

describe("validateQuiz — happy path", () => {
  test("returns a fully-typed Quiz, rewriting ids to q1..qN", () => {
    const quiz = validateQuiz(validQuizPayload(3), { count: 3 });
    assert.equal(quiz.questions.length, 3);
    assert.deepEqual(
      quiz.questions.map((q) => q.id),
      ["q1", "q2", "q3"],
    );
    for (const q of quiz.questions) {
      assert.equal(q.options.length, 4);
      assert.ok(q.correctIndex >= 0 && q.correctIndex <= 3);
      assert.equal(q.kind, "behavior");
    }
  });

  test("accepts a bare array (no { questions } wrapper)", () => {
    const payload = validQuizPayload(2).questions;
    const quiz = validateQuiz(payload, { count: 2 });
    assert.equal(quiz.questions.length, 2);
  });

  test("coerces unknown kind values to the closest QuestionKind", () => {
    const payload = {
      questions: [
        validQuestion({ kind: "behaviour" }),
        validQuestion({ kind: "no_change" }),
        validQuestion({ kind: "edge-case" }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 3 });
    assert.equal(quiz.questions[0]!.kind, "behavior");
    assert.equal(quiz.questions[1]!.kind, "no-change");
    assert.equal(quiz.questions[2]!.kind, "failure");
  });

  test("defaults unknown/missing kind to behavior", () => {
    const payload = { questions: [validQuestion({ kind: "something-weird" })] };
    const quiz = validateQuiz(payload, { count: 1 });
    assert.equal(quiz.questions[0]!.kind, "behavior");
  });

  test("trims explanation to at most two sentences", () => {
    const payload = {
      questions: [
        validQuestion({
          explanation:
            "First sentence about src/x.ts:1. Second sentence about src/x.ts:2. Third sentence should be dropped.",
        }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 1 });
    const explanation = quiz.questions[0]!.explanation;
    assert.ok(!explanation.includes("Third sentence"));
    assert.ok(explanation.includes("First sentence"));
    assert.ok(explanation.includes("Second sentence"));
  });

  test("drops malformed diffRefs entries instead of failing the whole quiz", () => {
    const payload = {
      questions: [
        validQuestion({
          diffRefs: [
            { file: "src/x.ts", lines: [1, 2] },
            { file: "", lines: [3] }, // invalid: empty file
            { file: "src/y.ts", lines: "not-an-array" }, // invalid: lines not array
            { file: "src/z.ts", lines: [4, -1, 5.5] }, // filters non-positive-integers
          ],
        }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 1 });
    const refs = quiz.questions[0]!.diffRefs;
    assert.equal(refs.length, 2);
    assert.deepEqual(refs[0], { file: "src/x.ts", lines: [1, 2] });
    assert.deepEqual(refs[1], { file: "src/z.ts", lines: [4] });
  });
});

describe("validateQuiz — violations", () => {
  function expectInvalid(value: unknown, expected: { count: number } = { count: 3 }): void {
    assert.throws(
      () => validateQuiz(value, expected),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  }

  test("wrong question count", () => {
    expectInvalid(validQuizPayload(2), { count: 3 });
  });

  test("not an array or {questions} object", () => {
    expectInvalid({ foo: "bar" });
  });

  test("question is not an object", () => {
    expectInvalid({ questions: ["not an object", validQuestion(), validQuestion()] });
  });

  test("empty question text", () => {
    expectInvalid({
      questions: [validQuestion({ question: "   " }), validQuestion(), validQuestion()],
    });
  });

  test("fewer than 4 options", () => {
    expectInvalid({
      questions: [validQuestion({ options: ["a", "b", "c"] }), validQuestion(), validQuestion()],
    });
  });

  test("more than 4 options", () => {
    expectInvalid({
      questions: [
        validQuestion({ options: ["a", "b", "c", "d", "e"] }),
        validQuestion(),
        validQuestion(),
      ],
    });
  });

  test("duplicate options are a validation failure", () => {
    expectInvalid({
      questions: [
        validQuestion({ options: ["Same", "same", "Different", "Other"] }),
        validQuestion(),
        validQuestion(),
      ],
    });
  });

  test("correctIndex out of range", () => {
    expectInvalid({
      questions: [validQuestion({ correctIndex: 4 }), validQuestion(), validQuestion()],
    });
    expectInvalid({
      questions: [validQuestion({ correctIndex: -1 }), validQuestion(), validQuestion()],
    });
  });

  test("correctIndex not an integer", () => {
    expectInvalid({
      questions: [validQuestion({ correctIndex: 1.5 }), validQuestion(), validQuestion()],
    });
    expectInvalid({
      questions: [validQuestion({ correctIndex: "2" }), validQuestion(), validQuestion()],
    });
  });

  test("empty explanation", () => {
    expectInvalid({
      questions: [validQuestion({ explanation: "" }), validQuestion(), validQuestion()],
    });
  });
});

describe("sanitizeModelText — ANSI/OSC/control-char stripping", () => {
  test("strips a complete CSI sequence (e.g. cursor move / color codes)", () => {
    assert.equal(sanitizeModelText("hello\x1b[31mworld\x1b[0m"), "helloworld");
  });

  test("strips a complete CSI sequence that clears the screen", () => {
    assert.equal(sanitizeModelText("before\x1b[2Jafter"), "beforeafter");
  });

  test("strips a complete OSC sequence terminated by BEL", () => {
    assert.equal(sanitizeModelText("click \x1b]8;;https://evil.example\x07here\x1b]8;;\x07 now"), "click here now");
  });

  test("strips a complete OSC sequence terminated by ST (ESC \\\\)", () => {
    assert.equal(sanitizeModelText("title\x1b]0;pwned\x1b\\done"), "titledone");
  });

  test("strips a bare/incomplete escape char", () => {
    assert.equal(sanitizeModelText("weird\x1bnottrailing"), "weirdnottrailing");
  });

  test("strips other C0 control chars (bell, backspace, vertical tab)", () => {
    assert.equal(sanitizeModelText("a\x07b\x08c\x0Bd"), "abcd");
  });

  test("keeps newlines and tabs", () => {
    assert.equal(sanitizeModelText("line one\nline\ttwo"), "line one\nline\ttwo");
  });

  test("leaves ordinary text untouched", () => {
    assert.equal(sanitizeModelText("nothing weird here, just text."), "nothing weird here, just text.");
  });
});

describe("validateQuiz — sanitizes hostile escape sequences in accepted strings", () => {
  test("strips ANSI/OSC injection from question, options, and explanation", () => {
    const payload = {
      questions: [
        validQuestion({
          question: "What does \x1b[31mthis\x1b[0m change?",
          options: [
            "Option \x1b]8;;https://evil.example\x07A\x1b]8;;\x07",
            "Option B",
            "Option C",
            "Option D",
          ],
          explanation: "It changes \x1b[2Jbehavior at src/x.ts:1. Nothing else happens.",
        }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 1 });
    const q = quiz.questions[0]!;
    assert.equal(q.question, "What does this change?");
    assert.equal(q.options[0], "Option A");
    assert.ok(!/\x1b/.test(q.explanation));
    assert.ok(q.explanation.includes("It changes behavior at src/x.ts:1."));
  });

  test("strips hostile sequences from diffRefs file strings", () => {
    const payload = {
      questions: [
        validQuestion({
          diffRefs: [{ file: "src/\x1b[31mx\x1b[0m.ts", lines: [1] }],
        }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 1 });
    assert.deepEqual(quiz.questions[0]!.diffRefs, [{ file: "src/x.ts", lines: [1] }]);
  });

  test("a string that is nothing but stripped escape sequences still fails as empty", () => {
    const payload = {
      questions: [validQuestion({ question: "\x1b[31m\x1b[0m\x07" })],
    };
    assert.throws(
      () => validateQuiz(payload, { count: 1 }),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  });

  test("a diffRefs entry that is nothing but stripped escape sequences is dropped, not kept empty", () => {
    const payload = {
      questions: [
        validQuestion({
          diffRefs: [
            { file: "\x1b[31m\x1b[0m", lines: [1] }, // becomes "" after sanitizing — must be dropped
            { file: "src/y.ts", lines: [2] },
          ],
        }),
      ],
    };
    const quiz = validateQuiz(payload, { count: 1 });
    assert.deepEqual(quiz.questions[0]!.diffRefs, [{ file: "src/y.ts", lines: [2] }]);
  });
});

describe("limitToTwoSentences boundary regex (via validateQuiz explanation trimming)", () => {
  function trimExplanation(explanation: string): string {
    const quiz = validateQuiz(
      { questions: [validQuestion({ explanation })] },
      { count: 1 },
    );
    return quiz.questions[0]!.explanation;
  }

  test('does not mis-split on "??" mid-sentence (the verified bug)', () => {
    const result = trimExplanation(
      "This replaces the ?? 0 fallback with X. Callers will now crash. A third sentence should be dropped.",
    );
    assert.equal(result, "This replaces the ?? 0 fallback with X. Callers will now crash.");
  });

  test('does not mis-split on "e.g." inside a sentence', () => {
    const result = trimExplanation("For example, e.g. this works fine. It does not break existing callers.");
    assert.equal(result, "For example, e.g. this works fine. It does not break existing callers.");
  });

  test("does not mis-split on a decimal number", () => {
    const result = trimExplanation("The threshold is 3.14 by default at src/x.ts:1. It was 2.0 before that.");
    assert.equal(result, "The threshold is 3.14 by default at src/x.ts:1. It was 2.0 before that.");
  });

  test("does not mis-split on a filename like cart.js", () => {
    const result = trimExplanation("This touches cart.js directly at src/x.ts:1. It does not touch checkout.js.");
    assert.equal(result, "This touches cart.js directly at src/x.ts:1. It does not touch checkout.js.");
  });

  test('"Really??" is recognized as a genuine sentence ending', () => {
    const result = trimExplanation("Did the migration break prod? Really?? This third sentence should be dropped.");
    assert.equal(result, "Did the migration break prod? Really??");
  });

  test("a genuine three-sentence explanation is trimmed to the first two", () => {
    const result = trimExplanation(
      "First point stands here at src/x.ts:1. Second point continues the thought. Third point must be dropped entirely.",
    );
    assert.equal(result, "First point stands here at src/x.ts:1. Second point continues the thought.");
    assert.ok(!result.includes("Third point"));
  });
});

describe("validateAnswers", () => {
  function makeQuiz(): Quiz {
    return validateQuiz(validQuizPayload(3), { count: 3 });
  }

  test("happy path: exact {q1: n, q2: n, q3: n} shape", () => {
    const quiz = makeQuiz();
    const answers = validateAnswers({ q1: 0, q2: 1, q3: 3 }, quiz);
    assert.deepEqual(answers, { q1: 0, q2: 1, q3: 3 });
  });

  test("throws when value is not an object", () => {
    const quiz = makeQuiz();
    assert.throws(
      () => validateAnswers("not an object", quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
    assert.throws(
      () => validateAnswers([1, 2, 3], quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
    assert.throws(
      () => validateAnswers(null, quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  });

  test("throws when a question id is missing", () => {
    const quiz = makeQuiz();
    assert.throws(
      () => validateAnswers({ q1: 0, q2: 1 }, quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  });

  test("throws when an answer is out of range or non-integer", () => {
    const quiz = makeQuiz();
    assert.throws(
      () => validateAnswers({ q1: 4, q2: 1, q3: 2 }, quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
    assert.throws(
      () => validateAnswers({ q1: 0.5, q2: 1, q3: 2 }, quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
    assert.throws(
      () => validateAnswers({ q1: "1", q2: 1, q3: 2 }, quiz),
      (err: unknown) => err instanceof DiffQuizError && err.code === "INVALID_MODEL_OUTPUT",
    );
  });
});
