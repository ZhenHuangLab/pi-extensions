# Releasing packages

Each workspace has its own npm name, version, changelog, and license. Changesets manages independent version changes; there are no fixed or linked release groups. The repository root is private. Publishing runs only when a GitHub Release is published, and each release selects exactly one workspace.

## Prepare versions

Add a changeset for the affected packages and choose the appropriate version bumps:

```sh
npm run changeset
```

After all implementation and metadata changes are complete, apply pending changesets and verify the resulting versions:

```sh
npm run version-packages
npm run check
PI_CONTEXT_LIVE=0 npm test
```

`version-packages` runs `changeset version`, updates each affected version and changelog, consumes its changesets, and refreshes the single root `package-lock.json` with lifecycle scripts disabled. Review and commit the package changes, changelogs, consumed changesets, and root lockfile, then push the commit to `main`. The initial migration changeset requests a patch bump for all seven packages and records the source and metadata move; source behavior is unchanged.

## Configure npm Trusted Publishing

Configure a Trusted Publisher for **every package** before its first release from this repository. With npm 11.15.0 or later, run this command for each package, replacing `pi-pleat` with its npm name:

```sh
npm trust github pi-pleat --repo ZhenHuangLab/pi-extensions --file publish.yml --allow-publish --yes
npm trust list pi-pleat --json
```

These commands require interactive two-factor authentication. The npm authentication page may offer to skip repeat verification for five minutes. For batch configuration, leave two seconds between packages to avoid rate limiting. `npm trust` does not accept `--workspaces`; pass each package name explicitly.

You can also configure this through the package's **Settings → Trusted Publisher** page on npm. For example, the settings page for `pi-pleat` is <https://www.npmjs.com/package/pi-pleat/access>. Use these exact GitHub settings:

| Setting | Value |
| --- | --- |
| Owner | `ZhenHuangLab` |
| Repository | `pi-extensions` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Publish permission | Enable **Allow npm publish**, not stage-only access |

npm currently requires the first successful publish within **two days** after a new trust setup. Configure each package immediately before its first monorepo release. Confirm authorization with a successful first publish.

The workflow uses GitHub OIDC. No stored long-lived npm token is required, and the workflow does not use npm tokens or secrets.

## Create a package release

The tag must be exactly `<npm-package-name>@<package.json-version>`, including any npm scope. Examples after the initial migration bump are `pi-pleat@0.1.4` and `@zhenhuang/pi-xai-search@0.2.2`. Plain `v` tags do not select a workspace.

The tag must point to a commit that contains `.github/workflows/publish.yml`. Merge the migration workflow to `main` before creating the first release tag. Both workflow jobs check out the immutable release event's `github.sha`.

Historical tags retain their original tag objects under namespaced refs and still point to the original single-package layout. Never republish them or create new Releases from them. New monorepo releases start at patch-bumped versions and require new version tags containing the root publish workflow.

Create an annotated tag, push it, then create a GitHub Release using `--verify-tag`. Substitute the selected package's actual name and version:

```sh
NPM_PACKAGE=pi-pleat
VERSION=0.1.4
TAG="${NPM_PACKAGE}@${VERSION}"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
gh release create "$TAG" --verify-tag --title "$TAG" --generate-notes
```

For a prerelease, add `--prerelease` to `gh release create`. The npm dist-tag is `next` if the GitHub Release is marked as a prerelease or the package version before any `+` build metadata contains `-`; otherwise it is `latest`.

The validation job discovers workspace names and versions using npm, requires exactly one tag match, installs dependencies, and runs that workspace's check and existing tests with `PI_CONTEXT_LIVE=0`. It also checks package contents with `npm pack --dry-run --ignore-scripts`. This job has read access and no OIDC permission.

The dependent publish job has OIDC permission and publishes the selected workspace with `--ignore-scripts --access public` and the chosen dist-tag. Packages ship raw TypeScript or JavaScript, so this job needs no dependency installation or build. Lifecycle scripts stay disabled in this job. Stable releases use `latest`; prereleases use `next`.

A versioning commit can update several packages. Create a separate tag and GitHub Release for each package you intend to publish. After a failure, inspect the workflow result and npm version before taking further action; publishing has no fallback for an existing version.
