# pi-session-mentions

## 0.2.0

### Minor Changes

- Return all matching sessions in the scrollable completion list instead of limiting results to eight.
- Add `@@all:`, `@@cc:`, `@@cx:`, and `@@pi:` source filters, with a four-option menu at `@@:`.
- Show initial indexing progress until the scan finishes. Clear the status on completion and keep later background refreshes from displaying a stale loading notice.
- Document source selection, indexing costs, and memory use in the English and Chinese READMEs.

## 0.1.2

### Patch Changes

- Write exported session transcripts to `/tmp/pi-sessions-mentions/` instead of the agent cache directory. Document transcript regeneration and temporary file cleanup.

## 0.1.1

### Patch Changes

- Document installation from npm now that the package is published.

## 0.1.0

### Minor Changes

- Add local Pi, Claude Code, and Codex session references. Search with `@@`, keep
  file completion separate, and attach source information with a clean local
  transcript path. Index user messages in a background worker without model calls.
