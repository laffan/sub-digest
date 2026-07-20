import { invoke } from "@tauri-apps/api/core";

/** Available models for the per-newsletter agent. */
export const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — balanced" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest" },
];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/** Validates the API key; resolves with a status string or rejects with an error. */
export function anthropicTest(apiKey: string, model: string): Promise<string> {
  return invoke<string>("anthropic_test", { apiKey, model });
}

/** Runs the agent transform on one newsletter body, returning Markdown. */
export function anthropicProcess(
  apiKey: string,
  model: string,
  instructions: string,
  subject: string,
  content: string
): Promise<string> {
  return invoke<string>("anthropic_process", {
    apiKey,
    model,
    instructions,
    subject,
    content,
  });
}
