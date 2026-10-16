# Agent instructions

Use Sol only for delegated work. Keep assignments bounded. Read the target package's instructions and relevant design or validation documents before editing.

Treat each directory under `packages/` as an independent source module. Preserve npm names, package-specific dependency versions, and licenses. Use Changesets for independent version changes. The root is private and provides tooling and documentation; it is not an aggregate Pi package.

The root tooling and documentation use MIT. `pi-better-math` uses GPL-3.0-or-later and depends on GPL-licensed `libtexprintf`. `@zhenhuang/pi-apply-patch` uses Apache-2.0 and includes algorithms adapted from OpenAI Codex. The other packages use MIT. Keep package license files and notices intact.

Use one root `package-lock.json`. Do not add nested lockfiles, mirrors, or submodules. Keep package source changes within the relevant package.

Do not add tests unless requested. Complete implementation before one consolidated verification phase: run `npm run check` and `PI_CONTEXT_LIVE=0 npm test`. Report skipped checks and unresolved failures. Live provider tests require explicit permission and can incur charges. Never log credentials or sensitive provider state.

Follow `RELEASING.md`. Publish each package through a GitHub Release with its exact `<npm-package-name>@<version>` tag. A brand-new npm package needs one manual bootstrap publish with explicit approval, followed by a new version published through GitHub to validate Trusted Publishing.
