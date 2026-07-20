import { invoke } from "@tauri-apps/api/core";

/** The agent always runs on Claude Haiku 4.5 (fast, cheap, faithful). */
export const AGENT_MODEL_LABEL = "Claude Haiku 4.5";

/** Validates the API key; resolves with a status string or rejects with an error. */
export function anthropicTest(apiKey: string): Promise<string> {
  return invoke<string>("anthropic_test", { apiKey });
}

/** Runs the agent transform on one newsletter body, returning Markdown. */
export function anthropicProcess(
  apiKey: string,
  instructions: string,
  subject: string,
  content: string
): Promise<string> {
  return invoke<string>("anthropic_process", { apiKey, instructions, subject, content });
}
