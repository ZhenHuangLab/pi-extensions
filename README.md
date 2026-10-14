# pi-pleat

Context management and compaction for [Pi](https://github.com/earendil-works/pi).

**Status: framework design and validation.** This repository contains the design
and reproducible contract checks. An installable extension is not available yet.

pi-pleat will manage the active conversation through tool-output limits,
provider-native context editing and compaction, and retrieval of cleared tool
results. It will preserve valid thinking where supported and use a configurable
summary model when native compaction is unavailable.

## Design

- [Architecture and decisions](docs/architecture.md)
- [Validation results and remaining gates](docs/validation.md)
- [Development sequence](docs/roadmap.md)
- [Provider and Pi references](docs/references.md)

Retrieval supports context cleanup within the current branch. The initial scope
does not include a cross-session memory service, database, or semantic index.

## Run the local checks

Requires Node.js 22.19.0 or later.

```sh
npm ci
npm run check
npm test
```

Dependencies are pinned to the Pi 1.2.0 contracts under evaluation. The local
checks use synthetic model responses and temporary sessions. CI runs these
checks without provider credentials.

## Run the provider checks

These checks make real requests and can incur charges. They use the existing
Pi `anthropic` and `openai-codex` credentials with read-only credential storage.
Requests that require OAuth refresh fail rather than update stored credentials.

```sh
PI_CONTEXT_LIVE=1 npm run test:live

# Run only the Anthropic contract check.
PI_CONTEXT_LIVE=1 node --test --test-name-pattern="live Anthropic" test/native.test.mjs
```

The default models are `claude-sonnet-5-5` and `gpt-6-astra`. Override them with
`PI_CONTEXT_ANTHROPIC_MODEL` and `PI_CONTEXT_OPENAI_MODEL`.

The tested Codex subscription endpoint returned HTTP 404 for standalone
compaction. Its live check remains failing; see the validation record for the
exact endpoint and evidence. The OpenAI API-key endpoint remains untested.

The checks use only synthetic conversation content. Identifier recovery measures
the replayed window, not the quality of the summary alone. A passed small fixture
does not establish cost savings, long-task quality, or full-window reliability.
