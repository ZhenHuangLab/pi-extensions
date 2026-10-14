# pi-pleat

Context management and compaction for [Pi](https://github.com/earendil-works/pi).

**Status: framework design and validation.** This repository contains the design
and reproducible contract checks. An installable extension is not available yet.

pi-pleat will manage the active conversation through provider-native context
editing and compaction, Pi context edits where no native clearing exists, and
retrieval of cleared tool results. It will preserve valid thinking where
supported and use a configurable summary model when native compaction is
unavailable.

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

The default models are `claude-haiku-5-5` and `gpt-6-luna`. Override them with
`PI_CONTEXT_ANTHROPIC_MODEL` and `PI_CONTEXT_OPENAI_MODEL`.

The Codex check follows the official client's `compaction_trigger` protocol on
the normal Responses endpoint. Two compact/replay cycles passed on the tested
subscription route. The earlier standalone `/responses/compact` request returned
404; that evidence remains in the validation record. The OpenAI API-key
standalone endpoint remains untested.

The checks use only synthetic conversation content. The Codex check also removes
an assistant-only fact from plaintext replay input and verifies its recovery from
the compacted state. These small fixtures do not establish general summary
quality, cost savings, long-task quality, or full-window reliability.
