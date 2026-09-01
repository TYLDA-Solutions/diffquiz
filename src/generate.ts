/**
 * Quiz generation: prompt -> provider -> parse -> validate, with one
 * corrective retry when the model's output doesn't parse or validate.
 */
import { buildGeneratePrompt } from "./prompts.ts";
import { extractJson, validateQuiz } from "./jsonx.ts";
import type { CompleteOptions, DiffSummary, Provider, Quiz } from "./types.ts";

export interface GenerateOptions {
  count: number;
  language: string;
  model?: string;
  timeoutMs: number;
}

function completeOptions(opts: GenerateOptions): CompleteOptions {
  return opts.model === undefined ? { timeoutMs: opts.timeoutMs } : { model: opts.model, timeoutMs: opts.timeoutMs };
}

async function requestQuiz(prompt: string, provider: Provider, opts: GenerateOptions): Promise<Quiz> {
  const raw = await provider.complete(prompt, completeOptions(opts));
  const parsed = extractJson(raw);
  return validateQuiz(parsed, { count: opts.count });
}

function correctivePrompt(originalPrompt: string, errorMessage: string): string {
  return `${originalPrompt}

CORRECTION: your previous response was rejected: "${errorMessage}". Fix exactly that problem and respond again with STRICT JSON ONLY (no prose, no code fences) matching the schema above.`;
}

/**
 * Generate a quiz for the given diff. Retries once with a corrective prompt
 * if the model's first response fails to parse or validate; the second
 * failure propagates to the caller.
 */
export async function generateQuiz(diff: DiffSummary, provider: Provider, opts: GenerateOptions): Promise<Quiz> {
  const prompt = buildGeneratePrompt(diff, { count: opts.count, language: opts.language });

  let quiz: Quiz;
  try {
    quiz = await requestQuiz(prompt, provider, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryPrompt = correctivePrompt(prompt, message);
    quiz = await requestQuiz(retryPrompt, provider, opts);
  }

  return {
    ...quiz,
    generatedBy: provider.name,
    ...(opts.model === undefined ? {} : { model: opts.model }),
  };
}
