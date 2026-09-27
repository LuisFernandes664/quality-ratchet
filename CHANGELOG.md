# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-09-27

Compared with 1.0.0 (tag `v1.0.0`, commit fb8087b), the action was rewritten around a
pure core, gained a second baseline format, report parsers, baseline governance and a
command line tool, and a few defaults changed. `@v1` stays on 1.0.0, which cannot read a
version 2 baseline: see "Upgrading from v1" in the README.

### Breaking changes

- The default `lower-baseline-pattern` is now `^chore(\([^)]*\))?: lower baseline`.
  `refactor:` was removed from it: any pull request titled `refactor: ...` passed with
  regressions.
- The pull request title no longer forgives failures. It only authorises loosening the
  baseline, and metrics that regress against the loosened baseline still fail. Only the
  `bypass-label` forgives a failure.
- The baseline on the base branch is the contract. A pull request that edits the baseline
  may tighten it freely; loosening it (worse value, larger tolerance, weaker or removed
  limit, changed direction, removed metric) fails unless the title authorises it.
- The default `language` is `en`. The Portuguese messages of the first version are
  available with `language: pt`.
- The action runs on `node24` (was `node20`), from `src/index.js` (was `src/index.mjs`).
- The `comment` input accepts only `true` or `false` (in any letter case), like the new
  `strict` input; any other value fails the run instead of being read as `false`.
- An empty `bypass-label` or `lower-baseline-pattern` now turns that escape hatch off: no
  label forgives a failure, and no title can loosen the baseline. It used to fall back to
  the default, so a `with:` value taken from an unset variable kept the default. The other
  inputs, except `token`, still fall back to their default when empty.
- The `regressions` output lists every failing metric (regressed, missing, invalid or
  outside a limit), each as `{name, status, before, after, delta}`. It used to list only
  regressed metrics, with a `direction` field; missing metrics were left out.

### Added

- Baseline format v2: one object per metric with `value`, `direction`, `tolerance`,
  `min`, `max`, `target`, `source` and `description`. Version 1 files are still read,
  and are written back in version 1.
- JSON Schema for the v2 format in `schema/baseline.v2.schema.json`.
- Sources: metrics read directly from reports in the `lcov`, `istanbul`, `cobertura`,
  `stryker`, `sarif`, `eslint`, `jscpd`, `npm-audit`, `pip-audit`, `junit` and `json`
  formats, with paths relative to the baseline's folder. The flat metrics file becomes
  optional when every metric has a source.
- Tolerance (absolute noise margin) and absolute limits (`min`, `max`) per metric, and an
  informative `target` shown in the summary.
- Baseline governance: the pull request's baseline is compared with the base branch's,
  and the summary lists every change (loosened, tightened, added, removed).
- The pull request title and labels are read from the API on every run, so a re-run sees
  a hotfix label added after the original event.
- Locking in improvements: the `new-baseline` output, the `write-baseline` input and the
  `strict` input.
- Inputs `name`, `strict`, `language` and `write-baseline`; outputs `bypassed`,
  `improvements`, `loosened`, `tightened` and `new-baseline`.
- Several ratchets per repository: each `name` gets its own comment and summary title.
- Support for Gitea and Forgejo Actions: the API URL comes from `GITHUB_API_URL`, and the
  base64 responses of their contents API are decoded. Not covered by CI.
- Command line tool `quality-ratchet` with the `check`, `update`, `init` and `migrate`
  commands; `check --base-ref` governs through git, with the baseline of the given commit
  as the contract. Outside a merge with the target branch, that commit must be the merge
  base: the README and the GitLab example use `git merge-base`.
- Reusable workflow `.github/workflows/quality-ratchet.yml`, with the optional secrets
  `collect-env` (`NAME=VALUE` lines, masked and exported only to the collect script) and
  `github-token` (the ratchet's token instead of `github.token`).
- Examples for Node.js, Python, .NET, a monorepo, locking in improvements on `main`, and
  GitLab CI.
- Release workflow that moves the major tag (`v2`) when a stable release is published or a
  pre-release is promoted to a release (event `released`), and only when that release is
  the highest `v2.x.y`: a patch for an older minor does not move the tag back.
- README notes on pinning (the reusable workflow runs the action by its major tag, so
  pinning the workflow by SHA does not pin the gate; the command line tool is pinned with
  `#<ref>`), on the checkout governance needs (the merge commit, not `head.sha`), on
  merging JUnit reports written one file per class (Maven Surefire, Gradle), and on the
  Node.js of the job image on Gitea and Forgejo runners.
- Typecheck of the JavaScript sources and tests with JSDoc and `tsc` in strict mode, and
  package metadata (`bin`, `exports`, `files`) for use with `npx`.

### Changed

- The decision logic moved from `src/ratchet.js` to pure modules in `src/core`, and the
  I/O to `src/run.js`, `src/github`, `src/action` and `src/cli`, all with injected
  dependencies.
- The baseline is validated before anything runs and every problem is reported at once.
  Unknown fields, and values without a rule in a v1 baseline, are reported as warnings
  instead of being ignored in silence.
- Measured values given as numeric strings (such as `"7.0"`) are accepted. A value that is
  not a number is reported as invalid instead of missing; both still fail.
- The bypass label is compared case-insensitively, as GitHub compares labels.
- The summary shows a target column when targets exist, tolerated regressions, the reason
  for each failing metric, the baseline changes, warnings, and the updated baseline.
- The summary comment is found by a marker at the start of its body, and every page of
  comments is read. The marker of an unnamed ratchet is unchanged, so existing comments
  keep being updated.
- API requests authenticate with `token <token>`, accepted by GitHub, Gitea and Forgejo.

### Fixed

- When the summary comment was not among the first 100 comments of a pull request, it was
  not found and a new one was posted on every run.
- An event payload that could not be read was ignored in silence; it is now a warning.

### Removed

- `src/ratchet.js` and `src/index.mjs`, replaced by `src/core`, `src/action` and
  `src/index.js`.

## [1.0.0] - 2026-08-30

First release, published as the `v1.0.0` and `v1` tags.

### Added

- The action (`node20`, `src/index.mjs`): compares a flat metrics file with a committed
  baseline (`metrics` plus `rules.monotonic_down` and `rules.monotonic_up`) and fails the
  pull request when a metric regresses or is missing.
- A summary in the job summary and in one pull request comment updated on every run, and
  the `passed`, `summary` and `regressions` outputs. Messages in Portuguese.
- The `bypass-label` (default `hotfix-bypass-ratchet`) and a title matching
  `lower-baseline-pattern` (default `^(chore: lower baseline|refactor:)`) forgive a failure.

[Unreleased]: https://github.com/LuisFernandes664/quality-ratchet/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/LuisFernandes664/quality-ratchet/releases/tag/v2.0.0
[1.0.0]: https://github.com/LuisFernandes664/quality-ratchet/tree/v1.0.0
