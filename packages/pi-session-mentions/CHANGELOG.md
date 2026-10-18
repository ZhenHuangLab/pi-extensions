# pi-session-mentions

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
