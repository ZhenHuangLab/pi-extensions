# Contributing

Thanks for helping improve `pi-xai-search`.

## Development setup

```bash
git clone https://github.com/ZhenHuangLab/pi-extensions.git
cd pi-extensions
npm ci
npm run check --workspace=@zhenhuang/pi-xai-search
npm test --workspace=@zhenhuang/pi-xai-search
```

Node.js 22.19 or newer is required.

Run workspace commands from the repository root. `check` verifies formatting,
lint, and types. `test` runs the Vitest suite. `prepack` runs both before packaging.

## Pull requests

1. Keep changes focused and add tests for behavior changes.
2. Run `npm run check --workspace=@zhenhuang/pi-xai-search` and `npm test --workspace=@zhenhuang/pi-xai-search` before opening the pull request.
3. Update the package `README.md` and add a Changeset when user-facing behavior changes. See [RELEASING.md](https://github.com/ZhenHuangLab/pi-extensions/blob/main/RELEASING.md).
4. Do not include credentials, tokens, private X data, or local Pi configuration.

## Commit style

Use Conventional Commits with a scope:

```text
feat(search): add account filters
fix(auth): preserve provider headers
docs(readme): clarify subscription login
test(client): cover request timeout
```

Common types include `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, and `ci`.

## Reporting bugs

Open a [GitHub issue](https://github.com/ZhenHuangLab/pi-extensions/issues) with:

- Pi, Node.js, and package versions
- authentication mode (`/login xai` or API key; never include the credential)
- selected nested model
- minimal reproduction steps
- sanitized error text

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
