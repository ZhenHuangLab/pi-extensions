/**
 * Remove Pi's built-in documentation pointer block from a system prompt.
 *
 * Matches the default buildSystemPrompt() section that starts with
 * "Pi documentation (read only when the user asks about pi itself…)"
 * and continues through its consecutive bullet lines.
 *
 * Also tolerates Claude Code identity rewrites performed by OAuth
 * compatibility extensions (Pi → Claude Code).
 */

const DOCS_BLOCK_RE =
  /\n*Pi documentation \(read only when the user asks about pi itself[^\n]*(?:\n-[^\n]*)*|\n*Claude Code documentation \(read only when the user asks about Claude Code itself[^\n]*(?:\n-[^\n]*)*/g;

export type StripResult = {
  text: string;
  stripped: boolean;
};

/**
 * Strip the Pi documentation pointer block from a system prompt string.
 * Collapses any triple-or-more newlines left behind.
 */
export function stripPiDocumentation(prompt: string): StripResult {
  if (!prompt) {
    return { text: prompt, stripped: false };
  }

  DOCS_BLOCK_RE.lastIndex = 0;
  if (!DOCS_BLOCK_RE.test(prompt)) {
    return { text: prompt, stripped: false };
  }

  DOCS_BLOCK_RE.lastIndex = 0;
  const text = prompt.replace(DOCS_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");

  return { text, stripped: text !== prompt };
}
