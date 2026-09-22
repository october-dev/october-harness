# October releases

Pi remains the source of truth for inherited packages. October publishes only `@october-dev/october`; never use Pi's root `publish`, `release:patch`, or `release:minor` commands to publish this fork. Those commands intentionally retain Pi's lockstep/all-workspace release model.

The October candidate version is `0.87.0-october.2`. Its upstream dependency versions stay on Pi 0.87.0. Keep the October dependency in `packages/evals/package.json` aligned when changing the October version. Refresh the root lockfile without scripts and regenerate the coding-agent shrinkwrap/install lock using the repository helpers.

## Required gates

1. Confirm the `/cl` changelog audit required by `AGENTS.md`. Review `[Unreleased]` before finalizing the release.
2. Run `npm run hydrate:model-data`, `npm run build:offline`, `npm run check`, and the October regression tests. Run `./test.sh` for the isolated non-e2e suite.
3. Run `node scripts/october-release.mjs pack` from the repository root. It creates a fresh temporary directory, packs only October, and tests isolated npm and Bun installs against the actual published Pi dependencies. It never publishes or overwrites an existing output directory. Both installs expose `october`, not `pi`.
4. Build and smoke-test the Bun binary with `scripts/build-binaries.sh` for the host platform. Use a fresh temporary output directory. Outside the repo, check Node and compiled Bun `--help`, `--version`, `--list-models`, a real prompt, and an interactive model reply. Verify an upgraded profile opens without “What's New”. As required by `AGENTS.md`, missing live-provider smoke is a release blocker unless explicitly accepted.
5. Commit only reviewed changes with the user's authorization; preserve unrelated local work. Obtain explicit approval to use this October-only release path instead of the inherited Pi lockstep release instructions. Do not publish a dirty or uncommitted candidate.

## npm trusted publishing

For local macOS Bun checks, use upstream's pinned Bun 1.3.14. `scripts/build-binaries.sh` ad-hoc signs and verifies macOS executables when run on macOS, before creating archives. Cross-compiling a macOS executable on Linux does not establish a valid signature. Release CI builds both macOS architectures on macOS and verifies the extracted archives before publication. Ad-hoc signatures are not Developer ID signatures or Apple notarization; an npm tarball does not include these compiled executables.

Configure npm's trusted publisher for `@october-dev/october`: organization `october-dev`, repository `october-harness`, workflow `publish-october.yml`, environment `npm-publish`. This is npm account configuration, not a repository secret. The GitHub environment should require release approval.

After the gates above, tag the reviewed commit `october-v<package-version>` and push that tag. The separate prefix avoids triggering Pi's inherited `v*` release and announcement workflow. `.github/workflows/publish-october.yml` checks, builds, tests, installs and publishes only the October tarball using OIDC. It explicitly updates npm's `latest` tag for the October-suffixed version and checks published integrity. No Pi R2 announcement or upstream-package publication is involved.

The build jobs upload checksummed, attested payloads before the separate `publish` job runs. The publisher downloads those exact payloads; it never rebuilds or repacks them. npm integrity verification allows 41 lookups with 30-second waits and logs its progress because successful npm publication can precede registry visibility by several minutes. It never republishes while waiting, and a different integrity or package identity fails immediately.

On failure, inspect the job before retrying. After a publication failure, rerun only failed jobs (`gh run rerun <run-id> --failed`), so the successful build jobs and original artifacts are reused. Do not rerun the full workflow after npm publication. npm versions are immutable. A repeat publication is allowed only if the existing integrity matches the artifact; otherwise create a new version. Never rerun a version bump or silently skip differing contents. If the original artifacts have expired, do not rebuild and assume equivalence: prepare a new reviewed release version.

The September 22, 2026 `0.87.0-october.1` npm publication is valid, but its original single-job workflow failed immediate verification and rebuilt different contents on retry. Its macOS archives also failed signature validation and were not released. Do not overwrite that npm version, move its tag, or distribute those native archives. The corrected workflow applies to a new release tag; it cannot repair the historical run in place.

After publication, verify the registry version, tarball integrity and a clean install. Desktop's managed runtime pin is outside this repository: publishing npm does not update a Desktop-pinned older package. Coordinate that pin update separately.
