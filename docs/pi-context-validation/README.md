# Pi context-management preliminary validation

This directory contains verification programs for the context-management plan.
It does not install an extension or change a running Pi session.

The programs target the installed Pi 1.2.0 SDK. Set `PI_PACKAGE_DIR` to another
installation directory if needed.

## Local lifecycle checks

```sh
node --test lifecycle.test.mjs
```

These checks use real Pi session machinery with a synthetic provider. They use
temporary session directories and do not make model requests.

## Live provider checks

```sh
PI_CONTEXT_LIVE=1 node --test native.test.mjs
```

These checks make billable requests using the existing `anthropic` and
`openai-codex` credentials. They send only synthetic test data. Credential access
is read-only: a request that requires OAuth refresh fails instead of changing
credentials. No existing session or settings file is modified.

The default models are `claude-sonnet-5-5` and `gpt-6-astra`. Override them with
`PI_CONTEXT_ANTHROPIC_MODEL` and `PI_CONTEXT_OPENAI_MODEL`. The Anthropic model must
support preserved thinking and on-demand compaction.

Each provider check attempts one baseline response and two compact/replay cycles.
Retries are disabled. Each model request has a 60-second timeout; each provider
check has a 240-second timeout.

The live checks verify signed/encrypted compaction output, replay, and retention
of a synthetic identifier. Anthropic replay uses strict prefix binding and
requires actual signed thinking in the baseline. OpenAI replay uses the entire
returned compacted window.

The Anthropic check records the Pi adapter's handling of the `compaction` stop
reason separately from the raw provider result. Capturing a block does not prove
that the adapter completed normally.

## Limits

These are preliminary contract checks. They do not establish task quality, cost
savings, latency improvement, or stability at a full context window. The small
Anthropic fixture tests acceptance of the clearing configuration, not an actual
tool-clearing event. They do not yet test model switching, images, arbitrary
gateways, large parallel tool batches, restart/branch restoration, nested output
archiving, fallback models, or a complete recall implementation.

See [RESULTS.md](RESULTS.md) for observed results and remaining blockers. The
current Codex standalone compact endpoint returns 404; its test remains failing
so that this limitation stays visible.
