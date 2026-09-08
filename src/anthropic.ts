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

/** What the triage pass decided about one harvested link. */
export interface Triaged {
  index: number;
  keep: boolean;
  /** Empty when the title it was given stands. */
  title: string;
  reason: string;
}

/**
 * Sorts a captured page's links into articles and the page's own furniture.
 *
 * A saved list is a mix — posts, notes that link out, profile pages, section
 * indexes — and the rules that tell them apart are the site's own, which is
 * exactly what the saved-list input refuses to encode. So the judgement goes to
 * the model, once per capture rather than once per link, over titles and
 * addresses alone: no page has been fetched yet, so none of their text is in
 * the prompt.
 */
export function anthropicTriage(
  apiKey: string,
  pageTitle: string,
  items: { title: string; url: string }[]
): Promise<Triaged[]> {
  return invoke<Triaged[]>("anthropic_triage", { apiKey, pageTitle, items });
}
