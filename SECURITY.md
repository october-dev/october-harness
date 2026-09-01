# Security Policy

October Harness is a local coding agent. It runs with the operating-system permissions of the user who starts it and does not claim to provide an in-process sandbox.

The local user account, files writable by that account, shell configuration, environment, and trusted October Harness configuration are normally inside the same security boundary as the harness process. Project instructions, extensions, skills, prompts, themes, packages, and model output can influence agent behavior and must be treated as untrusted until the user chooses to trust them.

October permission modes control when tool operations require confirmation. They are not an operating-system security boundary. Use a container, virtual machine, micro-VM, or external policy sandbox when running untrusted or unattended work.

October Bus peers can request work and exchange context. A peer request must not grant the receiving harness new tool permissions, credentials, filesystem access, or process authority.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/october-dev/october-harness/security/advisories/new).

Include:

- a description of the issue and its impact;
- steps to reproduce, a proof of concept, or relevant logs;
- the affected package, version, commit, and configuration;
- the expected security boundary and how it was crossed;
- any known mitigations.

Remove credentials and personal information from the report. Do not open a public issue for security-sensitive findings. Maintainers will review the report and coordinate disclosure when appropriate.

## In scope

Security issues in the distributed October Harness package, CLI, SDK, RPC runtime, APIs, repository code, October authentication, permission enforcement, and October Bus capability handling are in scope.

Examples include:

- bypassing an explicit October permission decision;
- accepting a Bus identity or capability outside its intended execution scope;
- exposing credentials through October-owned code or default behavior;
- crossing an operating-system privilege boundary because of a defect in the harness;
- a remotely reachable vulnerability in an October-operated service directly used by this repository.

## Out of scope

- expected local code execution that the user approved or enabled with `bypass`;
- prompt injection without a demonstrated boundary bypass;
- behavior of an intentionally installed third-party extension, skill, package, model, or tool;
- reports that require prior write access to the user's files, environment, shell configuration, or trusted October configuration unless October Harness grants that access;
- risks inherent in opening an untrusted repository without isolation;
- exposed third-party or user-controlled credentials;
- denial-of-service claims that require trusted local input or configuration;
- public internet exposure of an unsupported local Harness or RPC setup;
- malicious or incorrect model output by itself;
- vulnerabilities that exist only in upstream Pi and are not reachable through October Harness.

## Notes for reporters

The most useful reports demonstrate a current, reproducible security-boundary failure against the latest release or `main`. Include the exact path, package version or commit SHA, configuration, and proof of impact.

A malicious instruction in a repository, model response, extension, or skill is not by itself a Harness vulnerability. It becomes relevant when October Harness violates a documented permission, credential, Bus capability, process, or operating-system boundary because of that input.
