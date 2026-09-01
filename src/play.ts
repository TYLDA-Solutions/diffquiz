/**
 * Interactive quiz runner. One pass, no retries: each question is asked
 * exactly once, and the moment an answer comes in we reveal correctness,
 * the right option, the explanation, and the file:line refs. Wrong answers
 * never block anything — this is feedback, not a gate.
 */
import { createInterface } from "node:readline/promises";
import type { AnswerRecord, DiffRef, Quiz, QuizQuestion, QuizResult } from "./types.ts";
import { DiffQuizError } from "./types.ts";
import { bold, cyan, dim, green, red, yellow } from "./ansi.ts";

export interface PlayIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const KIND_LABEL: Record<QuizQuestion["kind"], string> = {
  behavior: "behavior",
  data: "data",
  failure: "failure",
  "no-change": "no-change",
};

function formatRefs(refs: DiffRef[]): string {
  if (refs.length === 0) return "";
  return refs.map((r) => `${r.file}:${r.lines.join(",")}`).join(", ");
}

/** Parses a raw answer line into a 0-based option index, or null if unrecognized. */
function parseAnswer(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  const digitMap: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3 };
  const letterMap: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };
  if (s in digitMap) return digitMap[s]!;
  if (s in letterMap) return letterMap[s]!;
  return null;
}

function writeLine(output: NodeJS.WritableStream, line = ""): void {
  output.write(`${line}\n`);
}

async function askQuestion(
  rl: ReturnType<typeof createInterface>,
  output: NodeJS.WritableStream,
  question: QuizQuestion,
  index: number,
  total: number,
): Promise<AnswerRecord> {
  writeLine(output);
  writeLine(output, `${dim(`[${KIND_LABEL[question.kind]}]`)} ${dim(`Question ${index + 1}/${total}`)}`);
  writeLine(output, bold(question.question));
  const letters = ["1", "2", "3", "4"];
  question.options.forEach((opt, i) => {
    writeLine(output, `  ${letters[i]}) ${opt}`);
  });

  let chosenIndex: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await rl.question(`${cyan("> ")}`);
    const parsed = parseAnswer(raw);
    if (parsed !== null) {
      chosenIndex = parsed;
      break;
    }
    if (attempt === 0) {
      writeLine(output, dim("Please answer with 1-4 (or a-d)."));
    }
  }

  const correct = chosenIndex !== null && chosenIndex === question.correctIndex;
  const correctText = question.options[question.correctIndex];

  if (chosenIndex === null) {
    writeLine(output, `${yellow("○ Skipped")} — correct answer: ${correctText}`);
  } else if (correct) {
    writeLine(output, `${green("✓ Correct")}`);
  } else {
    writeLine(output, `${red("✗ Not quite")} — correct answer: ${correctText}`);
  }
  writeLine(output, dim(question.explanation));
  const refs = formatRefs(question.diffRefs);
  if (refs.length > 0) {
    writeLine(output, dim(`See: ${refs}`));
  }

  return { questionId: question.id, chosenIndex, correct };
}

export async function playQuiz(quiz: Quiz, io: PlayIo): Promise<QuizResult> {
  const maybeTty = io.input as { isTTY?: boolean };
  if (maybeTty.isTTY === false) {
    throw new DiffQuizError(
      "BAD_USAGE",
      "diffquiz needs an interactive terminal to play the quiz.",
      "Use --print to see the quiz with answers, or --json for a machine-readable result.",
    );
  }

  const total = quiz.questions.length;
  writeLine(io.output, bold(`diffquiz — ${total} question${total === 1 ? "" : "s"}`));
  writeLine(io.output, dim("Wrong answers just get explained — nothing here blocks you."));

  const rl = createInterface({ input: io.input, output: io.output });
  const startedAt = Date.now();
  const answers: AnswerRecord[] = [];
  try {
    for (let i = 0; i < quiz.questions.length; i++) {
      const question = quiz.questions[i]!;
      const answer = await askQuestion(rl, io.output, question, i, total);
      answers.push(answer);
    }
  } finally {
    rl.close();
  }
  const durationMs = Date.now() - startedAt;

  const correctCount = answers.filter((a) => a.correct).length;
  const seconds = Math.round(durationMs / 1000);
  writeLine(io.output);
  writeLine(io.output, bold(`${correctCount}/${total} in ${seconds}s`));

  return {
    answers,
    correctCount,
    questionCount: total,
    durationMs,
    playedAt: new Date().toISOString(),
  };
}
