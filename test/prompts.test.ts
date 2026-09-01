import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnswerPrompt, buildGeneratePrompt } from "../src/prompts.ts";
import type { DiffSummary, Quiz } from "../src/types.ts";

const DIFF_OPEN = "<<<DIFF";
const DIFF_CLOSE = "DIFF>>>";

function makeDiff(overrides: Partial<DiffSummary> = {}): DiffSummary {
  return {
    baseDescription: "merge-base(HEAD, origin/main)",
    files: [
      {
        path: "src/auth.ts",
        status: "modified",
        linesAdded: 3,
        linesRemoved: 1,
        patch: [
          "@@ -10,4 +10,6 @@",
          " function login(user) {",
          "-  if (user) return true;",
          "+  if (user && user.isActive) return true;",
          "+  logAttempt(user);",
          " }",
        ].join("\n"),
      },
    ],
    totalLinesAdded: 3,
    totalLinesRemoved: 1,
    truncated: false,
    truncationNotes: [],
    ...overrides,
  };
}

function movedCodeDiff(): DiffSummary {
  return makeDiff({
    files: [
      {
        path: "src/setup.ts",
        status: "modified",
        linesAdded: 3,
        linesRemoved: 3,
        patch: [
          "@@ -1,6 +1,6 @@",
          "-  const config = loadConfigFromDiskAndValidateItThoroughly();",
          "-  const other = 1;",
          "-  const another = 2;",
          "+  const other = 1;",
          "+  const another = 2;",
          "+  const config = loadConfigFromDiskAndValidateItThoroughly();",
        ].join("\n"),
      },
    ],
    totalLinesAdded: 3,
    totalLinesRemoved: 3,
  });
}

function makeQuiz(): Quiz {
  return {
    questions: [
      {
        id: "q1",
        kind: "behavior",
        question: "What happens when login() is called with an inactive user?",
        options: [
          "It now returns false instead of true",
          "It throws a TypeError",
          "It still returns true",
          "It logs the user in twice",
        ],
        correctIndex: 0,
        explanation: "login() now checks user.isActive, so inactive users are rejected. See src/auth.ts:12.",
        diffRefs: [{ file: "src/auth.ts", lines: [12] }],
      },
      {
        id: "q2",
        kind: "failure",
        question: "What happens if user is undefined?",
        options: [
          "logAttempt is skipped and the function returns false",
          "The function throws before reaching logAttempt",
          "logAttempt is still called with undefined",
          "The function returns true regardless",
        ],
        correctIndex: 0,
        explanation: "The guard short-circuits on falsy user. See src/auth.ts:11.",
        diffRefs: [{ file: "src/auth.ts", lines: [11] }],
      },
    ],
    generatedBy: "fake",
  };
}

test("buildGeneratePrompt includes clear delimiters around the diff, in order", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  assert.ok(prompt.includes(DIFF_OPEN), "missing open delimiter");
  assert.ok(prompt.includes(DIFF_CLOSE), "missing close delimiter");
  assert.ok(prompt.indexOf(DIFF_OPEN) < prompt.indexOf(DIFF_CLOSE), "delimiters out of order");
});

test("buildGeneratePrompt places all patch content inside the delimiters", () => {
  const diff = makeDiff();
  const prompt = buildGeneratePrompt(diff, { count: 3, language: "en" });
  const openIdx = prompt.indexOf(DIFF_OPEN);
  const closeIdx = prompt.indexOf(DIFF_CLOSE);
  assert.ok(openIdx >= 0 && closeIdx > openIdx);

  const patchLine = "if (user && user.isActive) return true;";
  const occurrences: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = prompt.indexOf(patchLine, searchFrom);
    if (idx === -1) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  assert.ok(occurrences.length > 0, "patch line not found in prompt at all");
  for (const idx of occurrences) {
    assert.ok(idx > openIdx && idx < closeIdx, `patch content at ${idx} found outside delimiters (${openIdx}-${closeIdx})`);
  }
});

test("buildGeneratePrompt instructs the model to treat the diff as untrusted data", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  const lower = prompt.toLowerCase();
  assert.ok(lower.includes("untrusted"), "no untrusted-data framing");
  assert.ok(lower.includes("do not follow"), "no explicit ignore-embedded-instructions guidance");
});

test("buildGeneratePrompt inlines a JSON schema mirroring the Quiz shape and demands strict JSON", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  for (const key of ['"id"', '"kind"', '"question"', '"options"', '"correctIndex"', '"explanation"', '"diffRefs"']) {
    assert.ok(prompt.includes(key), `schema missing ${key}`);
  }
  assert.ok(/strict json/i.test(prompt), "no strict-JSON-only demand");
  assert.ok(/no (markdown )?code fences/i.test(prompt) || /no prose/i.test(prompt), "no explicit no-fences/no-prose instruction");
});

test("buildGeneratePrompt honors the requested language", () => {
  const promptDe = buildGeneratePrompt(makeDiff(), { count: 3, language: "de" });
  assert.ok(promptDe.includes('"de"'), "language code not referenced");
  const promptEn = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  assert.ok(promptEn.includes('"en"'));
});

test("buildGeneratePrompt honors the requested question count", () => {
  const prompt5 = buildGeneratePrompt(makeDiff(), { count: 5, language: "en" });
  assert.ok(prompt5.includes("5"), "count not mentioned");
  assert.ok(prompt5.includes("q5"), "highest id not mentioned");

  const prompt3 = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  assert.ok(!prompt3.includes("q4"), "unrelated higher id leaked into a 3-question prompt");
});

test("buildGeneratePrompt forbids absurd/generic distractors and all/none-of-the-above", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  const lower = prompt.toLowerCase();
  assert.ok(lower.includes("all of the above"));
  assert.ok(lower.includes("none of the above"));
  assert.ok(lower.includes("plausible misreading"));
});

test("buildGeneratePrompt demands varied correct-answer position", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  const lower = prompt.toLowerCase();
  assert.ok(lower.includes("correctindex") && lower.includes("vary"));
});

test("buildGeneratePrompt requires a no-change question when the diff looks like a pure move", () => {
  const prompt = buildGeneratePrompt(movedCodeDiff(), { count: 3, language: "en" });
  assert.ok(prompt.includes('"kind": "no-change"'), "moved-code diff should request a no-change question");
});

test("buildGeneratePrompt does not require no-change on an ordinary behavior diff", () => {
  const prompt = buildGeneratePrompt(makeDiff(), { count: 3, language: "en" });
  assert.ok(prompt.includes('Do not use "no-change"'), "ordinary diff should not demand a no-change question");
});

test("buildAnswerPrompt strips the answer key from questions", () => {
  const quiz = makeQuiz();
  const prompt = buildAnswerPrompt(makeDiff(), quiz, { language: "en" });
  assert.ok(!prompt.includes("correctIndex"), "correctIndex leaked into answer prompt");
  for (const q of quiz.questions) {
    assert.ok(!prompt.includes(q.explanation), "explanation leaked into answer prompt");
  }
  assert.ok(!prompt.includes('"kind"'), "kind field leaked into answer prompt");
});

test("buildAnswerPrompt includes every question id, its text, and options, and demands strict JSON keyed by id", () => {
  const quiz = makeQuiz();
  const prompt = buildAnswerPrompt(makeDiff(), quiz, { language: "en" });
  for (const q of quiz.questions) {
    assert.ok(prompt.includes(q.id));
    assert.ok(prompt.includes(q.question));
    for (const opt of q.options) {
      assert.ok(prompt.includes(opt));
    }
  }
  assert.ok(/strict json/i.test(prompt));
  assert.ok(prompt.includes(DIFF_OPEN) && prompt.includes(DIFF_CLOSE));
});

test("buildAnswerPrompt also frames the diff as untrusted data", () => {
  const prompt = buildAnswerPrompt(makeDiff(), makeQuiz(), { language: "en" });
  assert.ok(prompt.toLowerCase().includes("untrusted"));
});
