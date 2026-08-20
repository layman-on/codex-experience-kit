# Releasing Codex Experience Kit

Every npm release must be traceable to one immutable Git commit, one matching Git tag, and one GitHub Release. Publishing runs only from GitHub Actions through npm Trusted Publishing; maintainers do not store or use a long-lived npm write token.

## One-time Trusted Publisher setup

After `.github/workflows/publish.yml` exists on the default branch, configure the `codex-experience-kit` package on npm with:

- Provider: GitHub Actions
- Organization or user: `layman-on`
- Repository: `codex-experience-kit`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner, Node.js 24.14.1, npm 11.5.1 or newer, and `id-token: write`. No `NPM_TOKEN` secret is required. Once the first OIDC publication succeeds, disallow token-based publishing in npm package settings and revoke obsolete automation tokens.

See npm's [Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for the OIDC trust model and automatic provenance requirements. The repository pins every third-party Action to a full commit SHA following [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Dependabot keeps the pinned Action SHAs and both npm lockfiles current. CI blocks high-severity production dependency advisories before a release tag can publish.

## Version channels

Use `beta` as the normal prerelease channel. Reserve `next` for an integrated preview line when maintaining a second prerelease stream is genuinely useful.

| Version | npm dist-tag | GitHub Release |
| --- | --- | --- |
| `0.7.0-beta.1` | `beta` | Prerelease |
| `0.7.0-next.1` | `next` | Prerelease |
| `0.7.0` | `latest` | Latest stable release |

Consumers opt in with `npm install codex-experience-kit@beta` or `@next`. A prerelease is never published to `latest`.

See the official [npm dist-tag documentation](https://docs.npmjs.com/cli/dist-tag/) for installation and channel semantics.

## Release procedure

1. Update `package.json` and `package-lock.json` to the same version.
2. Add a dated `## <version> - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Merge the release commit into `main` and wait for CI to pass.
4. Validate locally with `npm run release:check -- v<version>`.
5. Create an annotated tag from the exact release commit and push it:

   ```bash
   git tag -a v0.7.0-beta.1 -m "v0.7.0-beta.1"
   git push origin v0.7.0-beta.1
   ```

The tag-triggered workflow validates the tag, version, and changelog; runs the complete test, simulation, build, example, and package inventory checks; creates a draft GitHub Release; publishes npm through OIDC; then publishes the GitHub Release. Trusted Publishing automatically adds npm provenance for this public repository and package.

## Recovery and history policy

The release workflow is safe to rerun after a partial failure. It accepts only these states:

- neither npm version nor GitHub Release exists;
- a draft GitHub Release exists and npm still needs publishing;
- npm is published and the matching draft GitHub Release needs finalizing;
- both npm and the public GitHub Release already exist.

It rejects an npm version that has no matching GitHub Release and a public GitHub Release that has no npm version. Never move or reuse a version tag after publication.

Versions published before this workflow was introduced do not have reliable source tags because the former Git history was intentionally removed. Do not invent retrospective tags for `0.1.0` through `0.6.12`; the traceable chain begins with the next release.
