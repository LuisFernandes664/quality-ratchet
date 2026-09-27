# Quality ratchet

A GitHub Action, and a command line tool, that fails a pull request when a quality metric
regresses against a committed baseline. The baseline can only get stricter: loosening it
takes an explicit authorisation that everyone can see in the pull request.

No runtime dependencies and no bundled `dist/`: the code in `src/` is what runs.

## The problem it solves

Absolute thresholds only work on new projects. Point `mutation score >= 70%` at a
codebase with real history and you get one of two outcomes: a gate nobody can pass,
or a gate somebody turns off. Both end in a green build that means nothing.

A ratchet takes a different bet. Freeze the current numbers, however bad, and from
then on they may only move one way. A repository sitting at 7% line coverage does
not fail because 7% is bad. It fails because the pull request took it to 6.9%.

The gate is useful from day one, and quality can only go up.

## Quick start

**1. Describe the metrics** in `quality-baseline.json` at the repository root. Each metric
says which way it may move and, optionally, which report it is read from:

```json
{
  "$schema": "https://raw.githubusercontent.com/LuisFernandes664/quality-ratchet/v2/schema/baseline.v2.schema.json",
  "version": 2,
  "metrics": {
    "coverage_lines": {
      "value": null,
      "direction": "up",
      "tolerance": 0.1,
      "source": { "format": "lcov", "path": "coverage/lcov.info" }
    },
    "lint_warnings": {
      "value": null,
      "direction": "down",
      "source": { "format": "eslint", "path": "reports/eslint.json", "field": "warnings" }
    }
  }
}
```

**2. Freeze today's numbers.** Generate the reports locally, then let the command line
tool fill in every `null` with the measured value (and set `frozen_at`):

```sh
mkdir -p reports
npx jest --coverage --coverageReporters=lcov
npx eslint . -f json -o reports/eslint.json
npx github:LuisFernandes664/quality-ratchet#v2 update
```

Commit the baseline. It is the contract, and its history is the audit trail of every
time the team decided to accept less.

**3. Run the ratchet on every pull request**, in `.github/workflows/quality-ratchet.yml`:

```yaml
name: Quality ratchet

on:
  pull_request:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      # Keep the default ref, the merge commit: see Governance.
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci

      - name: Collect reports
        run: |
          mkdir -p reports
          npx jest --coverage --coverageReporters=lcov
          # ESLint exits with 1 when it finds problems: the ratchet decides, not ESLint.
          npx eslint . -f json -o reports/eslint.json || [ $? -eq 1 ]

      - uses: LuisFernandes664/quality-ratchet@v2
```

**Why those event types.** `opened`, `synchronize` and `reopened` are the defaults.
`edited` re-runs the gate when the title changes, and the title is what authorises
lowering the baseline. `labeled` and `unlabeled` re-run it when the hotfix label is added
or removed. Without them, fixing the title or adding the label leaves the red check in
place until the next push or a manual re-run. A re-run replays the original event, with
the title and labels the pull request had back then, so the action does not trust the
event: it reads the current title and labels from the API on every run.

Each of those events starts a run, so `concurrency` keeps one run per pull request: a new
event (a push, a new title, a label) cancels the run in progress, whose result would be
out of date anyway, and two runs never race to post the comment.

**Permissions.** `contents: read` is needed to check out the code and to read the
baseline on the base branch. `pull-requests: write` is needed to post the summary
comment (and covers reading the pull request's current title and labels).

The action never runs your tools. You produce the reports however you like, and the
ratchet reads them: either directly (a `source` per metric) or from a flat JSON file
that you write yourself.

Complete workflows for Node.js, Python and .NET are in [`examples/`](#examples).

## What the pull request shows

One comment per pull request, updated in place on every run (a fresh comment on every
push buries the conversation and teaches everyone to ignore the gate). The same summary
goes to the job summary, and each failure to the log as an annotation:

> ## Quality ratchet
>
> **Ratchet red. 1 failing metric(s).**
>
> | | Metric | Baseline | Now | Delta | Target |
> |---|---|---|---|---|---|
> | ✅ | `coverage_lines` | 78.42 | 79.1 | +0.68 | 90 |
> | 🟡 | `coverage_branches` | 64.2 | 64.15 | -0.05 (±0.1) |  |
> | ❌ | `lint_warnings` | 37 | 41 | +4 |  |
> | ➖ | `duplication_pct` | 2.81 | 2.81 | 0 |  |
> | ➖ | `vulnerabilities_high` | 0 | 0 | 0 |  |
>
> <details><summary>Updated baseline (1 metric(s) tightened)</summary>
>
> Replace the committed baseline with this content to lock in the improvements.
>
> </details>
>
> <sub>Baseline frozen at 2026-09-14.</sub>

| Icon | Status | Fails the run |
|---|---|---|
| ✅ | improved | no |
| ➖ | unchanged | no |
| 🟡 | tolerated: worse, but within the tolerance | no |
| ❌ | regressed beyond the tolerance | yes |
| ❓ | missing: no value, or no report to read it from | yes |
| ⚠️ | invalid: the measured value is not a number | yes |
| ⛔ | outside the absolute `min` / `max` | yes |

Numbers are shown with up to 4 decimal places, or with more when a baseline and a
measured value would otherwise look the same (`0.81234` and `0.81231`). A green run reads
"Ratchet green. No metric regressed beyond its tolerance."

The comment also lists every change the pull request makes to the baseline, explains any
authorisation or forgiven failure, and ends with the baseline updated with the
improvements, ready to copy. When `lower-baseline-pattern` is empty, the note on a
loosened baseline says that loosening is turned off, instead of asking for a title.

Only comments posted by the account that publishes the ratchet are updated (see the
`comment-author` input): a comment by anyone else that starts with the same hidden marker
is ignored, never edited. If simultaneous runs created more than one comment, all of them
are updated. A comment is limited to 65536 characters: a longer summary is shortened for
the comment, with a note saying so (the updated baseline goes first, then the untracked
metrics, the baseline changes that do not loosen it and the rows that need no attention).
The job summary and the `summary` output always have the full report.

On a push (no pull request) the ratchet compares the measurements with the committed
baseline and reports in the job summary and the outputs, without a comment.

With a merge queue, a required check must also run on `merge_group`. That event carries no
pull request either, so in the queue there is no governance, no comment and no hotfix
label: a failure forgiven on the pull request fails again there.

## The baseline

### Format (v2)

```json
{
  "$schema": "https://raw.githubusercontent.com/LuisFernandes664/quality-ratchet/v2/schema/baseline.v2.schema.json",
  "version": 2,
  "frozen_at": "2026-09-27",
  "metrics": {
    "mutation_score": {
      "value": 61.5,
      "direction": "up",
      "tolerance": 0.5,
      "min": 50,
      "target": 80,
      "source": { "format": "stryker", "path": "reports/mutation/mutation.json" },
      "description": "Time-outs make mutation scores slightly noisy, hence the tolerance."
    },
    "files_above_line_limit": {
      "value": 19,
      "direction": "down",
      "max": 25
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `value` | yes | The frozen number. `null` is only accepted by the `update` command, which fills it in. |
| `direction` | yes | `up`: may only increase (coverage, mutation score). `down`: may only decrease (lint, duplication, vulnerabilities). |
| `tolerance` | no (0) | Absolute margin for noise. See [Tolerance and absolute limits](#tolerance-and-absolute-limits). |
| `min` | no | Absolute floor: a value below it fails, whatever the baseline says. |
| `max` | no | Absolute ceiling: a value above it fails, whatever the baseline says. |
| `target` | no | Goal shown in the summary. Informative only. |
| `source` | no | Report the value is read from. See [Sources](#sources-reading-reports-directly). Without it, the value comes from the flat metrics file. |
| `description` | no | Free text for humans. Informative only. |

At the root, `$schema` is optional and only helps editors, `version: 2` names the format,
and `frozen_at` records when the values were last frozen (the tools update it).

The baseline is validated before anything runs, and every problem is reported at once.
`description` and `$schema` must be text, and a metric name needs visible text, with no
line breaks or other control characters. Unknown fields, including keys inside `source`,
are warnings, so a typo such as `tolerence` or `feild` does not pass unnoticed. The tools
that rewrite the file keep unknown fields where they were, so the warning repeats until
the typo is fixed.

The tools that write the baseline (`update`, `init`, `migrate` and the `write-baseline`
input) write JSON indented with 2 spaces, with the fields in the order of the table above.
A file already in that form only changes where a value or `frozen_at` changes.

The JSON Schema lives in [`schema/baseline.v2.schema.json`](schema/baseline.v2.schema.json).
With `$schema` pointing to it, editors validate the file and complete field names.

### The flat metrics file

For numbers that no supported report carries (a shell script, a custom tool), write a
flat JSON object and pass it as `metrics` (default `metrics-current.json`):

```json
{
  "files_above_line_limit": 19,
  "coverage_line_pct": "7.0"
}
```

Numbers and numeric strings are accepted. Each metric comes either from its `source` or
from this file: defining it in both is an error. The file may be absent when every metric
has a source. Values in the file that the baseline does not track are listed as warnings.

### A missing metric is a failure

If the baseline names a metric and this run has no value for it, the run fails. The same
goes for a report that is missing, unreadable or empty (an LCOV file with no lines, a
Cobertura file without branch data). A collector that quietly drops a metric produces
exactly the green lie the ratchet exists to prevent, so silence is treated as regression
rather than as permission. The summary gives the reason for each one.

### Version 1 baselines

The original format still works, and files are rewritten in the format they were read in:

```json
{
  "frozen_at": "2026-05-04",
  "metrics": { "lint_violations_total": 483, "coverage_line_pct": 7.0 },
  "rules": {
    "monotonic_down": ["lint_violations_total"],
    "monotonic_up": ["coverage_line_pct"]
  }
}
```

Version 1 has no tolerance, limits or sources, and its values always come from the flat
metrics file. A version 1 file rewritten by the tools keeps `version: 1` when it declared
it, the original order of the values, and the values without a rule, numbers or not.
Convert it with `npx github:LuisFernandes664/quality-ratchet#v2 migrate`. Values without
a rule (never checked), numbers or not, cannot be migrated: they are all dropped, and the
warning names each one.

## Sources: reading reports directly

A `source` points a metric at a report file. `path` is relative to the folder that holds
the baseline file, not to the working directory, and names one file: globs and folders
are not expanded. `field` picks the number; when omitted, the default (listed first) is
used. Percentages are between 0 and 100 and are not rounded.

| `format` | Fields (default first) | What is read | Produced by, for example |
|---|---|---|---|
| `lcov` | `lines`, `branches`, `functions` | LH/LF, BRH/BRF and FNH/FNF per source file, summed over files, as a percentage. Several records of the same file (one per test name from `lcov -a`, or repeated by concatenating reports) are merged as the union of their DA/BRDA/FNDA lines, as `lcov --summary` and genhtml report; records with the same `SF:` but different lines (relative paths from two packages) count as different files | `node --test --experimental-test-coverage --test-reporter=lcov`, Jest, Vitest, c8, nyc, lcov/geninfo (gcc, clang), gcovr |
| `istanbul` | `lines`, `statements`, `functions`, `branches` | `total.<field>.covered` / `total.<field>.total` of `coverage-summary.json`, as a percentage (`pct`, which istanbul truncates to 2 decimals, only when the counts are missing) | the `json-summary` reporter of nyc, c8, Jest, Vitest |
| `cobertura` | `lines`, `branches` | `lines-covered` / `lines-valid` and `branches-covered` / `branches-valid` of the root `<coverage>`, as a percentage; `line-rate` / `branch-rate` (rounded by the tools) only when the counts are missing | `coverage xml` (coverage.py), coverlet, ReportGenerator |
| `stryker` | `score`, `score_covered`, `killed`, `survived`, `no_coverage`, `timeout` | mutants by status (mutation-testing-report-schema). `score` = detected / (detected + survived + no coverage); `score_covered` leaves out mutants without coverage. Detected = killed + timeout | StrykerJS (`json` reporter), Stryker.NET |
| `sarif` | `count` | results of all runs, except suppressed ones and those the tool's own baseline marks `absent`. Optional `levels` (`error`, `warning`, `note`, `none`); a result without a `level` takes its rule's default level, or `warning`. SARIF 2.1.0 only: other versions are rejected (`dotnet build` writes 1.0.0 by default: use `-p:ErrorLog=build.sarif%2Cversion=2.1`). A run whose `invocations` report `executionSuccessful: false` (an ESLint parsing error, missing classes in SpotBugs) is rejected instead of giving a partial count | ruff, Semgrep, CodeQL, ESLint SARIF formatter |
| `eslint` | `total`, `errors`, `warnings` | `errorCount` / `warningCount` summed over all files | `eslint -f json` |
| `jscpd` | `percentage`, `clones`, `duplicated_lines` | `statistics.total` | `jscpd --reporters json` |
| `npm-audit` | `total`, `critical`, `high`, `moderate`, `low`, `info`, `high+`, `moderate+`, `low+` | `metadata.vulnerabilities`. `high+` is high plus critical, and so on | `npm audit --json` (npm 6 and later) |
| `pip-audit` | `count` | distinct vulnerabilities per dependency (entries that share an `id` or an alias count once), summed over all dependencies; a project with no dependencies counts 0 | `pip-audit -f json` |
| `junit` | `tests`, `failures`, `errors`, `skipped` | `tests` / `skipped`: number of `<testcase>` / `<skipped>` elements; `failures` / `errors`: number of `<testcase>` with at least one `<failure>` / `<error>` (several in one test, as Vitest and jest-junit write them, count once) | pytest `--junitxml`, jest-junit, Vitest; Maven Surefire and Gradle once merged ([below](#one-report-per-class-or-project)) |
| `json` | `value` | the value at `pointer` (JSON Pointer, RFC 6901, required): a number, a numeric string, or an array (its length) | any tool with JSON output |

Two formats take options:

```json
{
  "errors_only": {
    "value": 3,
    "direction": "down",
    "source": { "format": "sarif", "path": "reports/codeql.sarif", "levels": ["error"] }
  },
  "bundle_bytes": {
    "value": 48213,
    "direction": "down",
    "tolerance": 512,
    "source": { "format": "json", "path": "reports/size.json", "pointer": "/0/size" }
  }
}
```

A report that cannot be read or has nothing to measure makes its metric fail, with the
reason in the summary; the other metrics are still compared, so one run shows every
problem.

### One report per class or project

Some tools split their report. Maven Surefire writes `target/surefire-reports/TEST-*.xml`
and Gradle writes `build/test-results/test/TEST-*.xml`, one file per test class, and
`dotnet test --logger junit` writes one file per test project. A `path` that names one of
them measures only that class or project, so merge them into one file first. For JUnit,
wrapping the files in a single `<testsuites>` element is enough:

```sh
# Maven: target/surefire-reports. Gradle: build/test-results/test.
mkdir -p reports
{
  echo '<testsuites>'
  for f in target/surefire-reports/TEST-*.xml; do sed '/^<?xml/d' "$f"; done
  echo '</testsuites>'
} > reports/junit.xml
```

Then point the metric at `reports/junit.xml`. Coverage split per project works the same
way: the [.NET example](examples/workflows/dotnet.yml) merges coverlet's files with
ReportGenerator.

## Governance: who may loosen the baseline

Editing the baseline in the same pull request that regresses a metric would defeat the
ratchet. So the contract is the baseline **on the base branch**, read through the API at
the pull request's base commit:

- **Tightening is free.** A better value, a smaller tolerance, a higher `min`, a lower
  `max`, a new limit or a new metric: no permission needed.
- **Loosening needs authorisation.** A worse value, a larger tolerance, a lower or
  removed `min`, a higher or removed `max`, a changed direction, a removed metric, or a
  `source` changed, added or removed (`format`, `path`, `field`, `pointer`, `levels`;
  writing out the default `field` also counts) is only accepted when the pull request
  title matches `lower-baseline-pattern` (default `^chore(\([^)]*\))?: lower baseline`,
  case-insensitive). For example `chore: lower baseline after dropping the legacy
  importer`. Moving a report to another path, or moving a metric from the metrics file to
  a source, needs that title too.
- **Without authorisation** the run fails, and the metrics are still checked against the
  stricter version of each field. Removed metrics keep being checked, and both they and
  the metrics whose source changed are measured as the base branch says: with its source,
  or from the metrics file when it had none. A pull request cannot hide a regression by
  editing the baseline next to it.
- **The title authorises, it does not forgive.** With an authorised title, the pull
  request's baseline becomes the contract, and anything that regresses against it still
  fails.
- **The hotfix label forgives.** A pull request with the `bypass-label` (default
  `hotfix-bypass-ratchet`, compared case-insensitively) passes whatever failed. The
  output `passed` stays `false` and `bypassed` becomes `true`.

Only `target` and `description` never loosen the baseline: they are informative, and a
change to them is listed as `changed`.

The baseline the pull request proposes is the file in the workspace, so keep the default
checkout of the `pull_request` event: the merge commit `refs/pull/<n>/merge`, which
already contains the base branch. If the workflow checks out
`github.event.pull_request.head.sha` (or `github.head_ref`), a branch that is behind shows
an old baseline. A value that the base branch tightened since (with a lock-in pull
request, for example) then looks loosened, and the run fails although the pull request
never touched the file; the summary reminds you to check the checkout whenever it finds
loosening without authorisation. If you need that checkout, update the branch (merge or
rebase) before the ratchet runs.

The file read on the base branch is the baseline's path relative to the root of the
checkout: the nearest folder with a `.git`, going up from the baseline's folder to the
workspace, or the workspace itself when there is none. So a repository checked out into a
subfolder with `actions/checkout` and `path:` is governed too:

```yaml
      - uses: actions/checkout@v7
        with:
          path: app
      # ... collect the reports inside app/
      - uses: LuisFernandes664/quality-ratchet@v2
        with:
          baseline: app/quality-baseline.json
```

Nothing is silent. The comment states when a failure was forgiven and why, when the
baseline was loosened with authorisation, and lists every change the pull request makes
to the baseline (loosened, tightened, changed, added, removed, with the fields involved).

Governance needs a pull request, so it does not apply on other events (a push, a
schedule). On a pull request it is off, with a note in the summary and a warning in the
log, when:

- the base branch has no baseline at that path yet (the pull request that adds it);
- the baseline on the base branch is invalid: the pull request cannot fix a file on
  another branch, so failing would block every pull request, including the fix;
- there is no token.

API errors while reading the base baseline fail the run: governance is a safety check and
is never switched off in silence. Transient errors (network, 500, 502, 503 and 504, 429
or an exhausted rate limit) are tried up to 3 times in all, honouring `retry-after` (or
the rate limit reset) when it asks for 30 s or less; after that the run fails. Posting a
new comment is never repeated, so that it cannot be duplicated.

Protect the file with CODEOWNERS, and require code owner reviews in branch protection, so
that every baseline change, `target` and `description` included, is reviewed by the
people who own quality. Protect the workflows too: a pull request that points `baseline`
at a new file, or removes the step, is not governed by the baseline at all.

```
# .github/CODEOWNERS
/quality-baseline.json @your-org/quality-owners
/.github/workflows/ @your-org/quality-owners
```

## Locking in improvements

A ratchet only clicks when gains are frozen. If coverage goes from 7 to 12 and the
baseline stays at 7, the next pull request can drop back to 7.1 and still pass.

Every run computes the baseline with the improvements locked in: the metrics that got
better by more than their tolerance take the measured value, and `frozen_at` becomes the
date of the run. It is kept in the format of the committed file (v1 stays v1). On a
governed pull request that loosens the baseline without authorisation, it starts from the
effective contract (the stricter version of each field, as the check used) rather than
from the pull request's file, so copying it never carries the loosening along. Three ways
to use it:

- **Copy it.** It is in the comment (collapsed) and in the `new-baseline` output.
- **`write-baseline: <path>`** writes it to a file in the workspace when something
  improved, so that a later step can commit it. [`lock-in-on-main.yml`](examples/workflows/lock-in-on-main.yml)
  runs on every push to `main` and opens (or updates) a pull request that tightens the
  baseline.
- **`strict: true`** fails the pull request when an improvement beyond the tolerance is
  not in the committed baseline. The author runs
  `npx github:LuisFernandes664/quality-ratchet#v2 update` and commits the result. The
  baseline then tightens on every pull request, at the cost of one extra step.

## Tolerance and absolute limits

**Tolerance** absorbs noise. Coverage can wobble by a hundredth on unrelated changes, and
mutation scores move with time-outs. A metric that gets worse by no more than its
`tolerance` is shown as tolerated and passes; beyond it, the run fails. The tolerance is
absolute, in the unit of the metric (`0.1` on a percentage is a tenth of a point).
Improvements within the tolerance are not locked in, so the baseline does not creep on
noise either.

**Limits** are absolute: `min` and `max` fail the run whatever the baseline says. They
state intent that the ratchet alone cannot, such as "never a known high severity
vulnerability" (`"max": 0`) or "mutation score never below 50" (`"min": 50`). A lower
`min`, a higher `max` or a removed limit is a loosening like any other. A baseline value
already outside its limits is reported as a warning.

## Several ratchets and monorepos

Give each ratchet a `name`. Each name gets its own comment and its own title in the
summary ("Quality ratchet - api"), so the ratchets never overwrite each other:

```yaml
    strategy:
      fail-fast: false
      matrix:
        package: [api, web]
    steps:
      # ... collect the reports of packages/${{ matrix.package }}
      - uses: LuisFernandes664/quality-ratchet@v2
        with:
          name: ${{ matrix.package }}
          baseline: packages/${{ matrix.package }}/quality-baseline.json
```

Source paths are relative to the baseline's folder, so `packages/api/quality-baseline.json`
can simply say `coverage/lcov.info`. The flat metrics file is relative to the workspace:
give each ratchet its own `metrics` file, or use sources everywhere. See
[`monorepo.yml`](examples/workflows/monorepo.yml).

## Pull requests from forks

On `pull_request` events from forks, GitHub hands the workflow a read-only token, so the
comment cannot be posted. The action logs a warning and carries on: the result is in the
job summary, in the outputs and in the check status, and the gate decides exactly as it
would with a comment. Do not switch to `pull_request_target` to get a write token: the
collect step runs the fork's code (its tests), and it would run with write access.

## Self-hosted runners, GHES and proxies

On GitHub Enterprise Server the runner sets `GITHUB_API_URL` to the server's API, and the
action calls that URL: there is nothing to configure.

Behind a proxy, the `fetch` of Node.js ignores `HTTPS_PROXY` and `HTTP_PROXY` unless it is
told otherwise. When the Node.js that runs the action has `http.setGlobalProxyFromEnv`
(recent Node.js 24 releases), the action applies `HTTPS_PROXY`, `HTTP_PROXY` and
`NO_PROXY` by itself. On other versions it logs a warning and the API requests go direct;
if they fail, set `NODE_USE_ENV_PROXY` on the step so that Node.js routes them through the
proxy (recent Node.js 22 and 24 releases; Node.js 20 cannot):

```yaml
      - uses: LuisFernandes664/quality-ratchet@v2
        env:
          NODE_USE_ENV_PROXY: "1"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `baseline` | `quality-baseline.json` | Path to the committed baseline, relative to the workspace. |
| `metrics` | `metrics-current.json` | Flat JSON file with this run's measurements, relative to the workspace. Optional when every metric has a source. |
| `token` | `${{ github.token }}` | Reads the base branch baseline, refreshes the title and labels, and posts the comment. An empty token skips every API call: no governance and no comment. |
| `comment` | `true` | Post or update the summary comment on the pull request. |
| `comment-author` | (empty) | Login of the account that posts the comment (for example `my-app[bot]`). Only its comments are updated. Empty uses the token's login, or any bot account when the token has none (`GITHUB_TOKEN`, GitHub Apps). |
| `name` | (empty) | Name of this ratchet when a repository runs several. |
| `bypass-label` | `hotfix-bypass-ratchet` | Label that forgives a failure, for production hotfixes. |
| `lower-baseline-pattern` | `^chore(\([^)]*\))?: lower baseline` | Case-insensitive regular expression that the title must match to loosen the baseline. |
| `strict` | `false` | Fail when an improvement beyond the tolerance is not in the committed baseline. |
| `language` | `en` | Language of the summary, comment and logs: `en` or `pt` (European Portuguese). |
| `write-baseline` | (empty) | Path, relative to the workspace, where the tightened baseline is written when something improved. Missing folders are created. |

Boolean inputs accept only `true` or `false` (in any letter case); anything else fails the
run with a clear message, as do an invalid baseline and an unsupported language. Setting
`bypass-label` or `lower-baseline-pattern` to an empty string turns that escape hatch off,
and an empty `token` skips every API call (no governance, no comment); the other inputs
fall back to their default when empty.

## Outputs

| Output | Description |
|---|---|
| `passed` | `true` when no metric failed, the baseline was not loosened without authorisation and, with `strict`, every improvement is locked in. Stays `false` when a failure is forgiven. |
| `bypassed` | `true` when the hotfix label forgave a failure. |
| `summary` | The full Markdown summary (the comment may be shortened to fit GitHub's size limit). |
| `regressions` | JSON array of the failing metrics: `{name, status, before, after, delta}`, with status `regressed`, `missing`, `invalid` or `limit`. |
| `improvements` | JSON array of the improved metrics, same shape. |
| `loosened` | JSON array with the names of the metrics this pull request loosened. |
| `tightened` | JSON array with the names of the metrics the new baseline tightens. |
| `new-baseline` | The baseline with the improvements locked in, as JSON indented with 2 spaces. |

The step fails (exit code 1) when the ratchet fails and nothing forgives it, and on any
configuration error: an invalid input, baseline or metrics file.

## Reusable workflow

For repositories that only need "set up, collect, ratchet", a reusable workflow does it
in one job. It takes `baseline`, `metrics`, `collect` (a bash script that produces the
reports), `node-version`, `python-version`, `dotnet-version` (each toolchain is set up
only when its version is given), `name`, `strict` and `language`, and exposes the
`passed` and `new-baseline` outputs, with the same meaning as the action's:

```yaml
jobs:
  ratchet:
    uses: LuisFernandes664/quality-ratchet/.github/workflows/quality-ratchet.yml@v2
    permissions:
      contents: read
      pull-requests: write
    with:
      python-version: "3.13"
      collect: |
        pip install -r requirements.txt pytest coverage
        coverage run --branch -m pytest
        coverage xml -o coverage.xml
```

The caller must grant `contents: read` and `pull-requests: write`: a called workflow
cannot have more permissions than its caller.

**Secrets.** The `collect` script sees no secret by itself: `secrets: inherit` does not
reach it, and the caller cannot write `${{ secrets.X }}` into `collect`, because `with:`
has no access to secrets. Two optional secrets fill that gap:

- `collect-env`: `NAME=VALUE` lines exported to the `collect` script only, such as a
  private package index or a registry token read by your `.npmrc`. Each value is masked in
  the log, and a line that is not `NAME=VALUE` fails the step without being printed.
- `github-token`: the token the ratchet step uses instead of `github.token`, for example
  a GitHub App token.

```yaml
    secrets:
      collect-env: |
        PIP_INDEX_URL=https://ci:${{ secrets.PYPI_TOKEN }}@pypi.example.com/simple
        NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}
```

On pull requests from forks, GitHub passes no secrets, so both arrive empty.

**Pinning.** The workflow runs the action as `LuisFernandes664/quality-ratchet@v2`, and
`actions/checkout` and the `actions/setup-*` actions by their major tag. Pinning the
reusable workflow to a commit SHA pins only the workflow file, not the gate code: any 2.x
commit of the workflow runs the latest 2.x action. For a gate pinned end to end, call the
action directly from your own job and pin it, and the setup actions, by commit SHA, as
described in [Versions](#versions).

## Command line

The same engine runs outside GitHub Actions, with Node.js 20 or later:

```sh
npx github:LuisFernandes664/quality-ratchet#v2 check
```

`#v2` runs the same release as `uses: ...@v2`. Without a ref, npm installs the tip of the
default branch, whatever has been merged since the last release. In CI, pin the full
commit SHA instead, as described in [Versions](#versions).

Once the package is published to npm, `npx quality-ratchet@2 check` does the same. Every
command accepts `--language en|pt`, `-h`/`--help` and `-v`/`--version`. Paths are
relative to the current directory, and the defaults are the action's. The path options
(`--baseline`, `--metrics`, `--output`, `--write-baseline`) and `--base-ref` do not accept
an empty value, or one with only spaces: the command exits with code 2 and
`"--<option>" is required`, instead of reading the working directory or ignoring the
option.

### `check` (default command)

Compares the measurements with the baseline. Prints the summary on stdout (Markdown, or
JSON with `--format json`) and the log lines on stderr, prefixed with `error: `,
`warning: ` or `notice: `.

```sh
# governed by the baseline where this branch left origin/main
npx github:LuisFernandes664/quality-ratchet#v2 check \
  --base-ref "$(git merge-base origin/main HEAD)" \
  --title="$PR_TITLE" \
  --labels="$PR_LABELS"
```

The contract is the baseline at `--base-ref`, and the baseline the branch proposes is the
file in the working directory. Use the merge base, not the tip of the target branch: a
branch that is behind would otherwise be blamed for every tightening made on the target
since, reported as loosening and as regressions. The tip is right only when the working
directory already contains it (a merge with the target, or a rebased branch). When `check`
finds loosening without authorisation, the summary and the error remind you to check that
`--base-ref` is the merge base.

As in the action, governance is off, with a warning and a note in the summary, when the
baseline does not exist at `--base-ref` (the branch that adds it) or is invalid there. A
baseline path outside the repository is treated like a missing baseline, as in the
action. Git errors while reading the baseline at `--base-ref`, other than the file not
existing at that ref (for example a missing object in a partial clone whose remote is
unreachable), fail with exit code 2; governance is not switched off.

| Option | Description |
|---|---|
| `--baseline <path>` | Baseline file (default `quality-baseline.json`). |
| `--metrics <path>` | Flat metrics file (default `metrics-current.json`). |
| `--base-ref <ref>` | Git ref whose baseline is the contract. Enables governance. Use the merge base (`git merge-base <target> HEAD`) unless the working directory contains the target. |
| `--title <text>` | Pull request title, matched against the lower-baseline pattern. |
| `--labels <a,b>` | Pull request labels, comma separated. |
| `--bypass-label <label>` | Label that forgives a failure (default `hotfix-bypass-ratchet`). `--bypass-label=` turns the bypass off. |
| `--lower-baseline-pattern <regex>` | Title pattern that authorises loosening. |
| `--strict` | Fail when improvements are not locked into the baseline. |
| `--name <name>` | Name of this ratchet, shown in the summary title. |
| `--format markdown\|json` | Output format (default `markdown`). |
| `--write-baseline <path>` | Write the tightened baseline to this file when something improved. |

The JSON output has `passed`, `ok` (passed or forgiven), `bypassed`, `results`, `failures`,
`loosened`, `tightened` and `newBaseline`. The reason of a failing result is a message
code with its parameters (`detail: {code, params}`), not text; the reason a report could
not be read, in `detail.params.reason`, is also `{code, params}`, except the text of a
JSON syntax error. Use the `--title=<text>` form for titles that come from a variable:
with `--title <text>`, a title that starts with `-` is rejected as an ambiguous option and
the command exits with code 2.

### `update`

Tightens the baseline file with the measured improvements, and fills in `null` values:

```sh
npx github:LuisFernandes664/quality-ratchet#v2 update
```

Without `--allow-lower`, a regression never lowers the baseline: the command lists the
values it did not lower in a warning on stderr, and `check` keeps failing until they
recover. `--allow-lower` re-freezes every value, regressions included, for a pull request
that is authorised to lower the baseline; when the values already match, it says that the
baseline already matches the measurements. `--output <path>` writes elsewhere (default:
the baseline itself). When nothing changes, the file is left untouched.

### `init`

Creates a v2 baseline from a flat metrics file you already produce:

```sh
npx github:LuisFernandes664/quality-ratchet#v2 init \
  --metrics metrics-current.json \
  --up coverage_line_pct,mutation_score \
  --down lint_violations_total,duplication_pct
```

`--metrics` is required here. `--up` and `--down` name the metrics that may only go up or
down, separated by commas (each option can also be repeated). Only the listed metrics
enter the baseline (the others are named in a warning). It writes
`quality-baseline.json`, or `--output <path>`, and refuses to overwrite an existing file
unless `--force` is given. Add `source`, `tolerance` and limits by hand afterwards.

### `migrate`

Converts a v1 baseline to v2, in place or to `--output <path>`:

```sh
npx github:LuisFernandes664/quality-ratchet#v2 migrate --baseline quality-baseline.json
```

**Exit codes:** 0 passed (or nothing to do), 1 the ratchet failed, 2 usage or
configuration error.

## Other platforms

### GitLab CI

Run the command line tool in a merge request pipeline. `--base-ref` reads the baseline
of another commit with git, and that baseline is the contract:

```yaml
quality-ratchet:
  image: node:24
  variables:
    GIT_DEPTH: "0"
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npm ci
    - npx jest --coverage --coverageReporters=lcov
    - TARGET="$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - git fetch origin "+refs/heads/$TARGET:refs/remotes/origin/$TARGET"
    - BASE="$(git merge-base "origin/$TARGET" HEAD)"
    - >-
      npx --yes github:LuisFernandes664/quality-ratchet#v2 check
      --base-ref "$BASE"
      --title="$CI_MERGE_REQUEST_TITLE"
      --labels="$CI_MERGE_REQUEST_LABELS"
```

The contract is the baseline where the merge request left the target branch: the merge
base, which needs the history (hence `GIT_DEPTH: "0"`). It is not the tip of the target
branch, because a merge request pipeline checks out the source branch rather than a merge
as GitHub does: a branch that is behind would be blamed for every tightening made on the
target since, reported as loosening and as regressions.

The trade-off is that such a pipeline measures the source branch alone: a merge request
can pass against the older baseline, and the target branch then fails after the merge. For
the same gate as a GitHub pull request, enable merged results pipelines (`HEAD` is then
the merge, and its merge base with the target is the target commit it contains), or
require fast-forward merges so that every merge request is rebased onto the target first.

GitLab does not start a new pipeline when only the title or the labels change: run the
pipeline again after renaming the merge request or adding the hotfix label. The full
example, which also keeps the summary as an artifact, is
[`gitlab-ci.yml`](examples/workflows/gitlab-ci.yml).

### Gitea and Forgejo Actions

The action is written to work there too: it calls the API at `GITHUB_API_URL`, which
those runners point to their own server, authenticates with `token <token>`, and accepts
the base64 responses of their contents API.

The runner must accept `runs.using: node24`, but it does not pick the Node.js version
from it: the action runs with the `node` of the job's container image, so that image
needs Node.js 20 or later. Older runner configurations map their default labels to
`node:16-bullseye`, where the action fails with a message that asks for Node.js 20 or
later. Map the label in `runs-on` to an image with Node.js 20 or later (for example
`node:24-bookworm`).

If the comment is not updated in place (a new one appears on every run), set
`comment-author` to the login of the Actions user that posts it (for example
`gitea-actions`). Without it, the action only updates comments by the token's login or,
when it cannot learn that login from the token, by `[bot]` accounts.

Depending on the instance, `uses:` may need the full URL
(`https://github.com/LuisFernandes664/quality-ratchet@v2`). This setup is not tested in
this repository's CI; reports of what works and what does not are welcome.

## Versions

`@v2` always points to the latest `2.x.y` release: the release workflow moves the major
tag when a stable release is published or a pre-release is promoted to a release, and
only when that release is the highest `2.x.y`. A pre-release never moves it, and neither
does a patch for an older minor (such as 2.0.1 published after 2.1.0). Breaking changes
only ship in a new major. See the [changelog](CHANGELOG.md).

For supply chain safety, pin the full commit SHA instead of the tag, and let Dependabot or
Renovate propose updates:

```yaml
- uses: LuisFernandes664/quality-ratchet@<full commit sha> # v2.0.0
```

The command line tool is pinned the same way, with `#` in place of `@`:

```sh
npx --yes github:LuisFernandes664/quality-ratchet#<full commit sha> check
```

With no dependencies and no build step, the code you review at that commit is exactly
the code that runs. That holds for the action and the command line tool, not for the
reusable workflow, which runs the action by its major tag (see
[Reusable workflow](#reusable-workflow)).

### Upgrading from v1

`@v1` stays on 1.0.0, the first version: a `node20` action with messages in Portuguese
that only reads version 1 baselines, so it fails on a version 2 baseline. To upgrade,
change `@v1` to `@v2`. Version 1 baselines keep working, and `migrate` converts them when
you want tolerance, limits or sources. Read the breaking changes in the
[changelog](CHANGELOG.md) first: the default language, the default lower-baseline pattern
and the role of the title changed, and the baseline on the base branch is now the
contract.

## Design

**No runtime dependencies.** Node.js ships `fetch`, `util.parseArgs` and `fs/promises`,
so the GitHub REST API, the command line and the files are handled directly. Nothing to
bundle, nothing to audit beyond `src/`. `typescript` and `@types/node` are development
dependencies, used only for the typecheck.

**A pure core.** Every decision about passing or failing lives in `src/core`, which does
no I/O, and every report parser in `src/extractors` takes text and returns a number.
`src/action` and `src/cli` are thin shells that receive the environment, `fetch`, the
file system and the clock as parameters, so the whole flow is tested with fakes.

**Typechecked JavaScript.** Every source and test file carries `// @ts-check` and JSDoc
types, and `npm run typecheck` runs `tsc` in strict mode over plain JavaScript. There is
no build step.

**Tested on itself.** CI runs the tests on Node.js 20, 22 and 24, the typecheck, the
action against itself with metrics that must pass and metrics that must fail, and a
ratchet on this repository's own coverage.

## Examples

| File | What it shows |
|---|---|
| [`examples/baselines/node.json`](examples/baselines/node.json) | LCOV coverage, ESLint, jscpd, npm audit, StrykerJS |
| [`examples/baselines/python.json`](examples/baselines/python.json) | coverage.py (Cobertura), ruff (SARIF), pip-audit, JUnit from pytest |
| [`examples/baselines/dotnet.json`](examples/baselines/dotnet.json) | coverlet merged by ReportGenerator (Cobertura), Stryker.NET, Semgrep (SARIF) |
| [`examples/workflows/node.yml`](examples/workflows/node.yml) | the workflow for `node.json` |
| [`examples/workflows/python.yml`](examples/workflows/python.yml) | the workflow for `python.json` |
| [`examples/workflows/dotnet.yml`](examples/workflows/dotnet.yml) | the workflow for `dotnet.json` |
| [`examples/workflows/monorepo.yml`](examples/workflows/monorepo.yml) | two named ratchets, one per package |
| [`examples/workflows/lock-in-on-main.yml`](examples/workflows/lock-in-on-main.yml) | a pull request that tightens the baseline after each push to `main` |
| [`examples/workflows/gitlab-ci.yml`](examples/workflows/gitlab-ci.yml) | the command line tool on GitLab merge requests |

Each example baseline is meant to be committed as `quality-baseline.json` at the root of
your repository, and is written exactly as the tools write it, so the first lock-in only
changes values and `frozen_at`. They leave out `$schema`: add the URL from the
[quick start](#quick-start) for editor support.

## License

MIT
