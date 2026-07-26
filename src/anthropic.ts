import { invoke } from "@tauri-apps/api/core";

/** The agent always runs on Claude Haiku 4.5 (fast, cheap, faithful). */
export const AGENT_MODEL_LABEL = "Claude Haiku 4.5";

/** Validates the API key; resolves with a status string or rejects with an error. */
export function anthropicTest(apiKey: string): Promise<string> {
  return invoke<string>("anthropic_test", { apiKey });
}

/**
 * One article an agent-processed newsletter linked to: the newsletter's own
 * title and byline for it, the address it was fetched from, and the page as
 * Markdown.
 */
export interface AgentEntry {
  title: string;
  /** Empty when the newsletter didn't name a writer. */
  author: string;
  url: string;
  markdown: string;
}

/** Runs the agent on one newsletter body, returning one entry per article. */
export function anthropicProcess(
  apiKey: string,
  instructions: string,
  subject: string,
  content: string
): Promise<AgentEntry[]> {
  return invoke<AgentEntry[]>("anthropic_process", { apiKey, instructions, subject, content });
}
