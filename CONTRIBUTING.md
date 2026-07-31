# Contributing

Thanks for helping improve `pi-xai-search`.

## Development setup

```bash
git clone https://github.com/ZhenHuangLab/pi-xai-search.git
cd pi-xai-search
npm install
npm run check
```

Node.js 20 or newer is required.

## Pull requests

1. Keep changes focused and add tests for behavior changes.
2. Run `npm run check` before opening the pull request.
3. Update `README.md` and `CHANGELOG.md` when user-facing behavior changes.
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

Open a GitHub issue with:

- Pi, Node.js, and package versions
- authentication mode (`/login xai` or API key; never include the credential)
- selected nested model
- minimal reproduction steps
- sanitized error text

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
