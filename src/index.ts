/**
 * Public library API. The CLI is a thin layer over these exports.
 */
export * from "./types.ts";
export { collectDiff, detectBaseRef } from "./git.ts";
export { loadConfig } from "./config.ts";
export { scanForSecrets } from "./secrets.ts";
export { resolveProvider, listProviders } from "./providers/index.ts";
export { generateQuiz } from "./generate.ts";
export { runDivergence } from "./divergence.ts";
export { playQuiz } from "./play.ts";
export { renderMarkdown, renderTerminal, renderPrint } from "./report.ts";
export { buildGeneratePrompt, buildAnswerPrompt } from "./prompts.ts";
