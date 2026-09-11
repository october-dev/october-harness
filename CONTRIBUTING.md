# Contributing to October Harness

October Harness is October's open, multiplayer-first coding harness. It is useful as a standalone agent and becomes a collaborative runtime when connected to [October Bus](https://github.com/october-dev/october-bus).

This guide explains what the project is trying to become, where changes belong, and what maintainers need in order to review a contribution.

## Project direction

Contributions should strengthen at least one of these goals:

- keep the standalone coding agent fast, dependable, and understandable;
- make multiplayer behavior a first-class runtime capability;
- preserve local authority over tools, files, credentials, and execution;
- keep providers, extensions, skills, prompts, themes, RPC, and SDK usage open and extensible;
- maintain a clear, reviewable relationship with the upstream Pi foundation.

October Harness is a downstream product, not a cosmetic rename. Its CLI and package identity, October inference and authentication, permission modes, October Bus integration, Desktop runtime contract, and product documentation are owned here.

The agent core, provider layer, TUI, session model, and several workspace packages originated in [Pi](https://github.com/earendil-works/pi). Changes to inherited code are welcome when they improve October Harness or are needed by its public contracts. Generally useful, October-neutral fixes should also be proposed upstream when practical. Preserve upstream copyright, license notices, package attribution, and provenance.

## The one rule

**You must understand your contribution.** You should be able to explain what changed, why it belongs in October Harness, how it interacts with the rest of the system, and how you verified it.

Using an AI coding tool is fine. The contributor remains responsible for reviewing every submitted change and for the accuracy of issue and pull-request descriptions.

If you use an agent, run it from the October Harness repository root so it loads `AGENTS.md`. The agent must follow the rules in that file.

## Opening issues and pull requests

Anyone can open issues and pull requests. There is no approval step and nothing is closed automatically. Maintainers review new submissions and reply when they need more information. Submissions that do not meet the quality bar below may be closed with a short explanation.

Start with a contribution proposal if the change is substantial or changes public behavior, so the ownership and approach can be agreed on before implementation.

## Opening an issue

Use the issue form that best matches the report. Keep the submission concise, concrete, and written in your own voice.

A useful bug report includes:

- the October Harness version or commit;
- a minimal reproduction;
- expected and actual behavior;
- relevant logs with credentials and personal information removed;
- whether the problem still occurs with project extensions and configuration disabled.

A useful contribution proposal includes:

- the problem being solved;
- why the change belongs in October Harness;
- the public behavior or contract that would change;
- a brief implementation approach, if known.

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Before submitting a pull request

Keep each pull request focused on one coherent change. Explain the problem, the solution, and why the repository should own the behavior.

Before submitting:

```bash
npm run check
./test.sh
```

Both commands must pass. Run focused tests while developing and add regression coverage for behavior changes.

Also verify that:

- user-facing behavior is documented;
- new dependencies are necessary, pinned, and reviewed;
- October Bus and permission changes preserve local authority boundaries;
- inherited code retains required Pi attribution and license notices;
- the change does not expose October credentials, private services, or internal product logic.

Do not edit released changelog sections. Maintainers coordinate release notes and upstream synchronization.

## Review criteria

Maintainers evaluate contributions for correctness, test coverage, clarity, security boundaries, maintenance cost, and alignment with October Harness. A technically valid change may still need a different abstraction or may fit better as an extension.

Review is also an ownership decision:

- October-specific runtime and integration behavior belongs here;
- portable improvements may belong here and upstream;
- proprietary October cloud and orchestration behavior does not belong in this repository;
- behavior owned entirely by an external project should be reported to that project.

## Conduct

Be direct, respectful, and focused on the work. Harassment, spam, deceptive reports, and repeated unreviewed automated submissions are not accepted. Contributors who repeatedly ignore this guide may be blocked.

## Questions and plans

Ask short usage and development questions in the [October Discord](https://discord.gg/E6PwPyXRt).

The public direction is documented in the [README roadmap](README.md#roadmap) and in repository issues. For substantial work, open a contribution proposal before implementation so the ownership and approach can be agreed on first.
