/**
 * Divergence mode: run the same quiz through N independent completions
 * (without the answer key) and see whether the model agrees with itself.
 * Runs are sequential — local LLM CLIs often serialize anyway, and it keeps
 * streamed output readable.
 */
import { buildAnswerPrompt } from "./prompts.ts";
import { extractJson, validateAnswers } from "./jsonx.ts";
import type {
  CompleteOptions,
  DiffSummary,
  DivergenceQuestionReport,
  DivergenceReport,
  DivergenceRun,
  Provider,
  Quiz,
} from "./types.ts";

export interface DivergenceOptions {
  runs: number;
  language: string;
  model?: string;
  timeoutMs: number;
}

function completeOptions(opts: DivergenceOptions): CompleteOptions {
  return opts.model === undefined ? { timeoutMs: opts.timeoutMs } : { model: opts.model, timeoutMs: opts.timeoutMs };
}

async function runOnce(prompt: string, provider: Provider, opts: DivergenceOptions, quiz: Quiz, runIndex: number): Promise<DivergenceRun> {
  const answers: Record<string, number | null> = {};
  try {
    const raw = await provider.complete(prompt, completeOptions(opts));
    const parsed = extractJson(raw);
    const validated = validateAnswers(parsed, quiz);
    for (const question of quiz.questions) {
      const value = validated[question.id];
      answers[question.id] = typeof value === "number" ? value : null;
    }
  } catch {
    // A failed/unparseable run records nulls for every question rather than
    // crashing the whole report — one bad run shouldn't sink the others.
    for (const question of quiz.questions) {
      answers[question.id] = null;
    }
  }
  return { run: runIndex, answers };
}

function analyzeQuestion(questionId: string, correctIndex: number, runs: DivergenceRun[]): DivergenceQuestionReport {
  const successfulAnswers: number[] = [];
  for (const run of runs) {
    const value = run.answers[questionId];
    if (typeof value === "number") successfulAnswers.push(value);
  }

  const distinctAnswers = [...new Set(successfulAnswers)].sort((a, b) => a - b);
  const diverged = distinctAnswers.length >= 2;

  const counts = new Map<number, number>();
  for (const value of successfulAnswers) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const maxCount = Math.max(0, ...counts.values());
  const hasMajority = successfulAnswers.length > 0 && maxCount > successfulAnswers.length / 2;
  const scattered = !hasMajority;

  const agreeWithKey = successfulAnswers.filter((value) => value === correctIndex).length;

  return {
    questionId,
    distinctAnswers,
    diverged,
    scattered,
    agreeWithKey,
  };
}

/**
 * Run `opts.runs` independent answer completions against the quiz and
 * compute divergence statistics per question.
 */
export async function runDivergence(diff: DiffSummary, quiz: Quiz, provider: Provider, opts: DivergenceOptions): Promise<DivergenceReport> {
  const prompt = buildAnswerPrompt(diff, quiz, { language: opts.language });

  const runs: DivergenceRun[] = [];
  for (let i = 0; i < opts.runs; i++) {
    // Sequential by design — see module comment.
    // eslint-disable-next-line no-await-in-loop
    const run = await runOnce(prompt, provider, opts, quiz, i);
    runs.push(run);
  }

  const perQuestion = quiz.questions.map((q) => analyzeQuestion(q.id, q.correctIndex, runs));
  const flaggedQuestionIds = perQuestion.filter((q) => q.diverged && !q.scattered).map((q) => q.questionId);

  return { runs, perQuestion, flaggedQuestionIds };
}
