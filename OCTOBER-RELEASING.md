# October releases

Pi remains the source of truth for inherited packages. October publishes only `@october-dev/october`; never use Pi's root `publish`, `release:patch`, or `release:minor` commands to publish this fork. Those commands intentionally retain Pi's lockstep/all-workspace release model.

The October candidate version is `0.85.1-october.1`. Its upstream dependency versions stay on Pi 0.85.1. Keep the October dependency in `packages/evals/package.json` aligned when changing the October version. Refresh the root lockfile without scripts and regenerate the coding-agent shrinkwrap/install lock using the repository helpers.

## Required gates

1. Confirm the `/cl` changelog audit required by `AGENTS.md`. Review `[Unreleased]` before finalizing the release.
2. Run `npm run hydrate:model-data`, `npm run build:offline`, `npm run check`, and the October regression tests. Run `./test.sh` for the isolated non-e2e suite.
3. Run `node scripts/october-release.mjs pack` from the repository root. It creates a fresh temporary directory, packs only October, and tests isolated npm and Bun installs against the actual published Pi dependencies. It never publishes or overwrites an existing output directory. Both installs expose `october`, not `pi`.
4. Build and smoke-test the Bun binary with `scripts/build-binaries.sh` for the host platform. Use a fresh temporary output directory. Outside the repo, check Node and compiled Bun `--help`, `--version`, `--list-models`, a real prompt, and an interactive model reply. Verify an upgraded profile opens without “What's New”. As required by `AGENTS.md`, missing live-provider smoke is a release blocker unless explicitly accepted.
5. Commit only reviewed changes with the user's authorization; preserve unrelated local work. Obtain explicit approval to use this October-only release path instead of the inherited Pi lockstep release instructions. Do not publish a dirty or uncommitted candidate.

## npm trusted publishing

For local macOS Bun checks, use upstream's pinned Bun 1.3.14. The candidate built here needed an ad-hoc signature on the temporary executable (`codesign --force --sign - <temporary-october-binary>`) before smoke testing. Validate signatures separately before distributing native archives; an npm tarball does not include that compiled executable.

Configure npm's trusted publisher for `@october-dev/october`: organization `october-dev`, repository `october-harness`, workflow `publish-october.yml`, environment `npm-publish`. This is npm account configuration, not a repository secret. The GitHub environment should require release approval.

After the gates above, tag the reviewed commit `october-v<package-version>` and push that tag. The separate prefix avoids triggering Pi's inherited `v*` release and announcement workflow. `.github/workflows/publish-october.yml` checks, builds, tests, installs and publishes only the October tarball using OIDC. It explicitly updates npm's `latest` tag for the October-suffixed version and checks published integrity. No Pi R2 announcement or upstream-package publication is involved.

On failure, inspect the job before retrying. npm versions are immutable. A repeat publication is allowed only if the existing integrity matches the artifact; otherwise create a new version. Never rerun a version bump or silently skip differing contents.

After publication, verify the registry version, tarball integrity and a clean install. Desktop's managed runtime pin is outside this repository: publishing npm does not update a Desktop-pinned older package. Coordinate that pin update separately.
