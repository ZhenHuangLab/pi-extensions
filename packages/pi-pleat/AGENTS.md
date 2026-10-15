# pi-pleat

Version 0.1.0 of the extension is implemented. Every change must keep the
validation discipline below and in `packages/pi-pleat/docs/roadmap.md`.

Read `packages/pi-pleat/docs/architecture.md` and
`packages/pi-pleat/docs/validation.md` before changing the design.
Separate verified SDK behavior, provider observations, and proposed behavior.
Do not treat a missing capability or a skipped live check as a pass.

Use only Sol for delegated implementation and review.

From the repository root, run `npm ci`, then
`npm run check --workspace=pi-pleat` and `npm test --workspace=pi-pleat`
after validation-code changes. Live checks
require `PI_CONTEXT_LIVE=1`, use configured credentials, and can incur charges.
Run them only when the task requires provider verification. Do not log keys,
authorization headers, thinking text, signatures, or encrypted state.

Keep the design and validation records in `packages/pi-pleat/docs/`. Push completed
milestones to `origin` as requested by the owner. Preserve remote history and
record unresolved provider limitations before publishing results.

After the extension is fully implemented, you should keep the repo as clean as `https://github.com/ZhenHuangLab/ah`.
