<h1 align="center">prompt-per-model</h1>

<p align="center">
  Per-model system prompts for <a href="https://github.com/earendil-works/pi">Pi</a>: a Markdown file
  for each model, added to the system prompt while that model is in use.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/prompt-per-model"><img src="https://img.shields.io/npm/v/prompt-per-model" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/prompt-per-model"><img src="https://img.shields.io/npm/dm/prompt-per-model" alt="npm downloads per month"></a>
  <a href="https://github.com/ZhenHuangLab/prompt-per-model/tags"><img src="https://img.shields.io/github/v/tag/ZhenHuangLab/prompt-per-model" alt="GitHub tag"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Pi-1.2.0-2DF9C0" alt="Tested with Pi 1.2.0">
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

Models respond differently to the same instructions. prompt-per-model keeps instructions for each
model in its own file and adds the files that match the current model to the system prompt, in a
`<model_prompt>` section after `<cwd>`. When the matching files change, for example after a model
switch, Pi records the new section at the end of the transcript and leaves the earlier messages as
they were.

## Install

```sh
pi install npm:prompt-per-model
```

At its first start, the extension creates `~/.pi/agent/prompt-per-model/`.

## Prompt files

Put a Markdown file for each model in `~/.pi/agent/prompt-per-model/`. The file name without `.md`
is the model id:

```text
~/.pi/agent/prompt-per-model/
├── claude-opus-5.md
└── gpt-6.1-sol.md
```

To use one file for several models, list them in the `match` frontmatter:

```markdown
---
match: gpt-6-astra, gpt-6.1-sol
---
Keep responses brief.
```

A pattern matches the model id (`gpt-6.1-sol`), the provider and id (`openai-codex/gpt-6.1-sol`),
or the model's display name. `*` matches any characters and `?` one character, and case is ignored:
`match: anthropic/*` applies to every Anthropic model. YAML needs quotes around a pattern that
starts with `*`, as in `match: "*"`. When several files match, their text is joined in file name
order. A virtual model matches by its own id, not by the models it routes to.

In a trusted project, the extension also reads `.pi/prompt-per-model/`. A project file replaces the global
file of the same name.

The files are read again before each message, so an edit applies from the next message.

## Command

`/prompt-per-model` lists the files, marks the ones that match the current model, and names the
files that cannot be used, such as a file with invalid frontmatter or no text. The footer shows the
matching files.

## License

MIT; see [LICENSE](LICENSE).
