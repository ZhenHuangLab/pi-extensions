# pi-better-explore

[![npm version](https://img.shields.io/npm/v/pi-better-explore?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-better-explore)
[![npm monthly downloads](https://img.shields.io/npm/dm/pi-better-explore)](https://www.npmjs.com/package/pi-better-explore)
[![GitHub tag](https://img.shields.io/github/v/tag/ZhenHuangLab/pi-better-explore)](https://github.com/ZhenHuangLab/pi-better-explore/tags)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Keeps codebase exploration small and fast by turning exploration conventions
from prompt text into tool-boundary enforcement.

Prompt rules decay: they appear once at the top of the context and get weaker as
the session grows. This extension moves the mechanically decidable ones into a
`tool_call` hook, so a violation is caught at the moment it happens and the
model gets a concrete replacement to copy.

Every rule follows one test: block a call only when it would put more into the
context than the replacement tool. A blocked call costs a full turn, so a call
whose output is already small is let through even when a tool exists for the
same job.

## Rules

| Blocks | Allowed |
|---|---|
| `grep` / `egrep` / `fgrep` / `rg` at a pipeline head, anywhere in the command | `cmd \| grep foo` (downstream filtering), `git grep`, `rg` when the active search tool sanctions it |
| `find` / `fd` used to locate files | `find ... -exec/-delete/-print0`, `fd -x/-X`, `find ... \| xargs`, output redirected to a file, `fd` when the active finder sanctions it |
| `cat` of a file over 20 KB or 600 lines | small files, `head` / `tail`, pipelines, output redirected to a file, files the same command writes first |
| `ls -R` / `ls -laR` / `ls --recursive` over more than 200 entries | small trees, every non-recursive `ls`, `ls -R \| head`, output redirected to a file |
| `rtk grep` / `rtk rg` / `rtk find` / `rtk read` / `rtk ls`, under the rule of the command they replace | `rtk read --max-lines/--tail-lines`, `rtk tree`, `rtk git`, `rtk test`, … |
| `read` without `offset`/`limit` on a file over 20 KB or 600 lines | anything smaller, images/archives, an explicit `limit` |

The tool named in a block message is the first one active in the session.
Content search prefers `sift-light`, then the built-in `grep`, then
`signal_grep`. File search prefers `sift-light` with `mode=files`, then
`fffind`, then the built-in `find`. `rg` and `fd` are offered as bash fallbacks
only next to `grep` and `find`; sift-light covers those cases itself. If no
suitable tool is active, the call is not blocked.

Calls made by another tool, such as a `codemode` script, return their output to
that tool and not to the context. The size rules (`cat`, `ls -R`, `read`) skip
them, and only the search rules apply.

## Message shape

Messages are single-line, positive directives:

```text
Search content with the sift-light tool.
Find files with the sift-light tool (mode=files).
This recursive listing has over 200 entries. Find files with the sift-light tool (mode=files).
`src/big.ts` is 9,558 lines. Locate with the sift-light tool, then read it with the built-in read tool and offset+limit. Whole file: read with limit=2000.
This file is 9,558 lines. Locate with the sift-light tool, then read with offset+limit. Whole file: repeat with limit=2000.
```

Two constraints drive that shape. Every block is paid for in tokens on each
occurrence, so the message states the action and stops. And prohibitions prime
the behaviour they forbid — telling a model "never use grep" keeps `grep` in
play — so messages name only what to do.

## Design notes

**Cache safety.** Everything happens in `tool_call`. A blocked call only appends
a tool result; the system prompt and tool schemas are never touched, so the
prompt-cache prefix survives intact. Modifying `event.input` would also be
cache-safe — the hook receives a validated copy, not the assistant message's
arguments — but no rule here rewrites arguments, because a silent rewrite would
leave the model believing it got something it did not.

**False positives are the expensive failure.** Each wrongful block costs a full
turn, and blocking one segment of a compound command throws away the whole
batch. Listings and dumps are therefore measured on disk before they are
blocked, and anything the hook cannot resolve — a variable, a glob, a `cd` to an
unknown directory — is allowed through. Bash commands are parsed with a quote-,
heredoc-, redirection- and substitution-aware scanner rather than a regex, so a
literal `grep` inside a string or a heredoc never triggers a rule, `2>&1` does
not split a command, and `cd dir && cat file` resolves `file` inside `dir`.

**Wrapper-aware classification.** pi-rtk-optimizer rewrites bash commands into
`rtk <subcommand>` form from inside the same `tool_call` event, so whether a
rule sees `cat f` or `rtk read f` is a load-order accident. `rtk grep`, `rtk
rg`, `rtk find`, `rtk read` and `rtk ls` are therefore folded back onto the
binary they replace before the rules run, and the verdict is the same for
either spelling. Subcommands with no blocked counterpart pass through untouched.

**No deadlocks.** A given path is blocked at most twice by the size rules for
`read` and `cat` together; after that it is allowed through, so a model that
will not add `offset`/`limit` cannot loop.

## What this deliberately does not do

Rules requiring intent cannot be enforced here and stay in the prompt:

- merging several searches into one multi-pattern call — whether patterns can be
  safely OR-ed is a semantic question
- reading a known path directly instead of searching for it — "known" is model
  state, invisible to a hook

## Install

```bash
pi install npm:pi-better-explore
```

No configuration. Disable with `pi config`.

## Maintainer releases

For one-time setup, open the npm package's **Settings → Trusted Publisher → GitHub Actions**.
Set owner to `ZhenHuangLab`, repository to `pi-better-explore`, and workflow
filename to `publish.yml`. Leave environment blank. You must enable
**Allow npm publish**; the default may allow only staging. Publishing uses OIDC
without a stored npm token.

Update the version in `package.json` and any tracked lockfile, then push the
commit and matching `v<version>` tag. Publish a GitHub Release for that tag to
run the workflow; pushing the tag alone does not trigger it. Prereleases publish
to `next`; stable releases publish to `latest`. Do not move old tags.
