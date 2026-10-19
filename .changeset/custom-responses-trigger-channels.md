---
"pi-pleat": minor
---

Allow custom provider/API pairs to use Codex Responses-trigger compaction through `pi-pleat.responsesTriggerChannels`. Use the configured channels for compaction and native replay, preserve their leading Responses instructions, and show the selected compaction method in `/context`. Document the stable-endpoint requirement for native compaction and replay on Pi 1.2.

Disable local clearing by default on non-Anthropic channels. Users can opt in with `pi-pleat.clearing.localEnabled`, including per-model overrides.

Extend `recall` to retrieve original user and assistant text covered by native compaction or text summaries, including compaction that retains no earlier messages, while preserving branch isolation and the existing tool-output recall behavior.
