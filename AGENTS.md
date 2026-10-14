# pi-pleat

The current phase is framework design and contract validation. Keep production
plugin implementation out of design-only changes.

Read `docs/architecture.md` and `docs/validation.md` before changing the design.
Separate verified SDK behavior, provider observations, and proposed behavior.
Do not treat a missing capability or a skipped live check as a pass.

Use GPT-6.1-sol max subagents for code implementation (you should describe the implementation plan as detailed as possible) and GPT-6-Astra max subagents for delegated reviews. Keep coding and reviewing scope and turn budgets bounded when using subagents.

Run `npm run check` and `npm test` after validation-code changes. Live checks
require `PI_CONTEXT_LIVE=1`, use configured credentials, and can incur charges.
Run them only when the task requires provider verification. Do not log keys,
authorization headers, thinking text, signatures, or encrypted state.

Keep the design and validation records in this repository. Push completed
milestones to `origin` as requested by the owner. Preserve remote history and
record unresolved provider limitations before publishing results.

After the extension is fully implemented, you should keep the repo as clean as `https://github.com/ZhenHuangLab/ah`.