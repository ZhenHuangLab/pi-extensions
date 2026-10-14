# Changelog

Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-10-14)

The first version, for Pi 1.2.0.

- Old tool results are cleared by Anthropic's server-side context editing on Anthropic, and replaced
  by placeholders with a recall id through Pi context edits on other providers.
- Anthropic models compact natively at the end of a turn. Later requests, also after a restart,
  replay the signed compaction block once the summary, the kept reply, the system prompt and the
  tools are checked.
- OpenAI Codex and OpenAI Responses models compact with the Responses `compaction_trigger` item when
  Pi's threshold is reached or on `/compact`, and keep a readable summary for other models.
- When native compaction is unavailable or fails, a text summary in Pi's format is written by the
  session model or by a fallback model set with the `pi-pleat` settings key or `/context fallback`.
  A compaction result whose next request would not fit the model window is discarded, and the
  history is kept.
- The `recall` tool returns the saved output of an earlier tool call on the current branch, by id or
  by query.
- `/context` shows context usage, clearing, compaction, native replay and fallback status.
