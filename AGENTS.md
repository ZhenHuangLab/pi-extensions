# pi-pleat

The current phase is framework design and contract validation. Keep production
plugin implementation out of design-only changes.

Read `docs/architecture.md` and `docs/validation.md` before changing the design.
Separate verified SDK behavior, provider observations, and proposed behavior.
Do not treat a missing capability or a skipped live check as a pass.

Use GPT-6.1-sol for delegated reviews. The project owner asked to stop using Grok
after a review stalled. Keep review scope and turn budgets bounded.

Run `npm run check` and `npm test` after validation-code changes. Live checks
require `PI_CONTEXT_LIVE=1`, use configured credentials, and can incur charges.
Run them only when the task requires provider verification. Do not log keys,
authorization headers, thinking text, signatures, or encrypted state.

Keep the design and validation records in this repository. Push completed
milestones to `origin` as requested by the owner. Preserve remote history and
record unresolved provider limitations before publishing results.
