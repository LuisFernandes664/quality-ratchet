# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-09-29

### Added

- `base-ref` input: the ref where the contract is read, overriding the merge base or the
  base commit of the pull request (#3).
- The Release workflow can be run by hand on `main` to publish the release of the version
  in `package.json`, with its changelog entry as notes, and move the major tag.

### Fixed

- On Gitea Actions the summary comment is updated in place instead of a new one on every
  run: without `comment-author` and without a login from the token, the comments of
  `gitea-actions` are updated (#4).
- The test suite passes on Windows: `.gitattributes` keeps LF line endings with
  `core.autocrlf=true`, the path fakes of the git tests are platform neutral, and CI runs
  the tests on `windows-latest` (#11).
- On Gitea and Forgejo the contract is read at the pull request's `merge_base` instead of
  `base.sha`, which is the current tip of the base branch there: a branch that is behind
  is no longer reported as loosening what the base branch tightened later (#3).

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
  limit, changed direction, changed, added or removed source, removed metric) fails unless
  the title authorises it.
- The default `language` is `en`. The Portuguese messages of the first version are
  available with `language: pt`.
- The action runs on `node24` (was `node20`), from `src/index.js` (was `src/index.mjs`).
- The `comment` input accepts only `true` or `false` (in any letter case), like the new
  `strict` input; any other value fails the run instead of being read as `false`.
- An empty `bypass-label` or `lower-baseline-pattern` now turns that escape hatch off: no
  label forgives a failure, and no title can loosen the baseline (the summary says that
  loosening is turned off). It used to fall back to the default, so a `with:` value taken
  from an unset variable kept the default. The other inputs, except `token`, still fall
  back to their default when empty.
- The `regressions` output lists every failing metric (regressed, missing, invalid or
  outside a limit), each as `{name, status, before, after, delta}`. It used to list only
  regressed metrics, with a `direction` field; missing metrics were left out.

### Security

- Changing a metric's `source` (`format`, `path`, `field`, `pointer`, `levels`, or adding
  or removing it) loosens the baseline and needs the authorising title: pointing a metric
  at another report, or moving it from the metrics file to a report, cannot hide a
  regression. Until the change is authorised, the metric is measured with the source of
  the base branch, and so are the metrics the pull request removed.
- The summary escapes metric names, pull request titles and labels, so they cannot inject
  Markdown or HTML into the comment. Metric names with line breaks or other control
  characters are rejected.
- The comment only updates comments posted by its own author (new `comment-author` input,
  or the token's login, or any bot account when the token has none): a comment by anyone
  else that starts with the marker never receives or hides the report.
- Pagination only follows `Link` URLs on the API's own host: a `Link` header with a path
  such as `//host` or `/\host` cannot send the token to another host.
- The cause that npm writes when `npm audit` fails is shown with the credentials of any
  URL masked, because it is published in the comment.

### Added

- Baseline format v2: one object per metric with `value`, `direction`, `tolerance`,
  `min`, `max`, `target`, `source` and `description`. Version 1 files are still read,
  and are written back in version 1, keeping `version: 1` when it was declared, the order
  of the values and the values without a rule, numbers or not.
- JSON Schema for the v2 format in `schema/baseline.v2.schema.json`, including the rule
  for metric names (visible text, no control characters).
- Sources: metrics read directly from reports in the `lcov`, `istanbul`, `cobertura`,
  `stryker`, `sarif`, `eslint`, `jscpd`, `npm-audit`, `pip-audit`, `junit` and `json`
  formats, with paths relative to the baseline's folder. The flat metrics file becomes
  optional when every metric has a source. Each format gives the number its tools report:
  - `lcov` merges the records of the same file (one per test name from `lcov -a`, or
    repeated in concatenated reports) as the union of their lines, as `lcov --summary`
    does;
  - `cobertura` and `istanbul` divide the exact counts (`lines-covered` / `lines-valid`,
    `covered` / `total`) instead of reading the rates that the tools round or truncate;
  - `junit` counts failed tests in `failures` and `errors`, not `<failure>` and `<error>`
    elements (Vitest writes one per error, jest-junit one per failure message);
  - `sarif` accepts only SARIF 2.1.0 (the 1.0.0 that the C# compiler writes by default
    marks suppressions differently), and rejects a run whose `invocations` report
    `executionSuccessful: false`, such as an ESLint parsing error, instead of giving a
    partial count;
  - `pip-audit` counts distinct vulnerabilities (the entries that pip-audit 2.10 repeats
    with the same id or alias count once), and a project with no dependencies counts 0.
  The reason a report cannot be read is translated with `language: pt`.
- Tolerance (absolute noise margin) and absolute limits (`min`, `max`) per metric, and an
  informative `target` shown in the summary.
- Baseline governance: the pull request's baseline is compared with the base branch's,
  and the summary lists every change (loosened, tightened, changed, added, removed).
  `target` and `description` are informative: a change to them is listed as `changed`.
  The file read on the base branch is the baseline's path relative to the root of the
  checkout, so `actions/checkout` with `path:` is governed too. When a pull request
  loosens the baseline without authorisation, the summary also suggests checking that the
  workflow checks out the merge commit (with `check --base-ref`, that `--base-ref` is the
  merge base).
- The pull request title and labels are read from the API on every run, so a re-run sees
  a hotfix label added after the original event.
- Transient API errors (network, 500, 502, 503, 504, 429 and exhausted rate limits) are
  tried up to 3 times, honouring `retry-after` up to 30 s. A new comment is never posted
  twice.
- Proxies on self-hosted runners: when Node.js has `http.setGlobalProxyFromEnv` (recent
  Node.js 24), the action applies `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; otherwise
  it logs a warning that suggests `NODE_USE_ENV_PROXY: "1"`.
- Locking in improvements: the `new-baseline` output, the `write-baseline` input and the
  `strict` input. On a pull request that loosens the baseline without authorisation, the
  suggested baseline starts from the effective contract, not from the pull request's file.
- Inputs `name`, `strict`, `language`, `write-baseline` and `comment-author`; outputs
  `bypassed`, `improvements`, `loosened`, `tightened` and `new-baseline`.
- Several ratchets per repository: each `name` gets its own comment and summary title.
- A summary above the 65536 characters of a comment is shortened for the comment, with a
  note; the job summary and the `summary` output keep the full report. When simultaneous
  runs created more than one comment, all of them are updated.
- Support for Gitea and Forgejo Actions: the API URL comes from `GITHUB_API_URL`, and the
  base64 responses of their contents API are decoded. On a job image whose Node.js has no
  `fetch`, the action fails with a message that asks for Node.js 20 or later. Not covered
  by CI.
- Command line tool `quality-ratchet` with the `check`, `update`, `init` and `migrate`
  commands; `check --base-ref` governs through git, with the baseline of the given commit
  as the contract. Outside a merge with the target branch, that commit must be the merge
  base: the README and the GitLab example use `git merge-base`. Governance is only off
  when git proves that the baseline does not exist at that commit (or the path is outside
  the repository); any other git error, such as a missing object in a partial clone,
  fails with exit code 2. `update` lists the regressions it did not lower. Empty path
  options are rejected. Usage errors are shown in the language given by `--language`, and
  output piped to a reader that closes early (`head`, `grep -q`) neither crashes the tool
  nor changes its exit code. In the `--format json` report, the reason of a failing result
  is `{code, params}`.
- Reusable workflow `.github/workflows/quality-ratchet.yml`, with the optional secrets
  `collect-env` (`NAME=VALUE` lines, masked and exported only to the collect script) and
  `github-token` (the ratchet's token instead of `github.token`).
- Examples for Node.js, Python, .NET, a monorepo, locking in improvements on `main`, and
  GitLab CI. The pull request workflows keep one run per pull request with `concurrency`.
- Release workflow that moves the major tag (`v2`) when a stable release is published or a
  pre-release is promoted to a release (event `released`), and only when that release is
  the highest `v2.x.y`: a patch for an older minor does not move the tag back.
- README notes on pinning (the reusable workflow runs the action by its major tag, so
  pinning the workflow by SHA does not pin the gate; the command line tool is pinned with
  `#<ref>`), on the checkout governance needs (the merge commit, not `head.sha`), on
  merging JUnit reports written one file per class (Maven Surefire, Gradle), on the
  Node.js of the job image on Gitea and Forgejo runners, and on GHES and proxies.
- Programmatic API: the package exports `runRatchet` and the baseline helpers (`.`) and
  the extractors (`./extractors`). A `Report` lists each baseline change with its kind
  (`loosened`, `tightened`, `changed`, `added`, `removed`) and its `loosenedFields`,
  `tightenedFields` and `changedFields`, and says in `loosenable` whether a title can
  authorise loosening; `RatchetInput.baseMeasurements` takes the measurements made with
  the base branch's sources.
- Typecheck of the JavaScript sources and tests with JSDoc and `tsc` in strict mode, and
  package metadata (`bin`, `exports`, `files`) for use with `npx`.

### Changed

- The decision logic moved from `src/ratchet.js` to pure modules in `src/core`, and the
  I/O to `src/run.js`, `src/github`, `src/action` and `src/cli`, all with injected
  dependencies.
- The baseline is validated before anything runs and every problem is reported at once.
  Unknown fields (including keys inside `source`), and values without a rule in a v1
  baseline, are reported as warnings instead of being ignored in silence, and the tools
  that rewrite the file keep them. `description` and `$schema` must be text. A baseline
  value already outside its `min` or `max` is a warning that says runs fail while the
  measured value stays outside. A file without `version` whose metrics are all objects is
  read as version 2, even with a leftover `rules` key (which gives a warning).
- Measured values given as numeric strings (such as `"7.0"`) are accepted. A value that is
  not a number, or that overflows (such as `1e400`), is reported as invalid instead of
  missing; both still fail.
- The bypass label is compared case-insensitively, as GitHub compares labels.
- The summary shows a target column when targets exist, tolerated regressions, the reason
  for each failing metric, the baseline changes, warnings, and the updated baseline.
  Numbers have up to 4 decimal places, or more when needed to tell the baseline from the
  measured value, and a green run says that no metric regressed beyond its tolerance.
- The summary comment is found by a marker at the start of its body, and every page of
  comments is read. The marker of an unnamed ratchet is unchanged, so existing comments
  keep being updated.
- API requests authenticate with `token <token>`, accepted by GitHub, Gitea and Forgejo.
- When the comment cannot be posted, the warning only mentions the read-only token of
  pull requests from forks when the API answered 403 or 404.

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

[Unreleased]: https://github.com/LuisFernandes664/quality-ratchet/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/LuisFernandes664/quality-ratchet/releases/tag/v2.1.0
[2.0.0]: https://github.com/LuisFernandes664/quality-ratchet/releases/tag/v2.0.0
[1.0.0]: https://github.com/LuisFernandes664/quality-ratchet/tree/v1.0.0
