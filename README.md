# Quality ratchet

A GitHub Action that fails a pull request when any quality metric regresses
against a committed baseline. No dependencies, no bundled `dist/`.

## The problem it solves

Absolute thresholds only work on new projects. Point `mutation score >= 70%` at a
codebase with real history and you get one of two outcomes: a gate nobody can pass,
or a gate somebody turns off. Both end in a green build that means nothing.

A ratchet takes a different bet. Freeze the current numbers, however bad, and from
then on they may only move one way. A repository sitting at 7% line coverage does
not fail because 7% is bad. It fails because the pull request took it to 6.9%.

The gate is useful from day one, and quality can only go up.

## Usage

```yaml
- name: Quality ratchet
  uses: LuisFernandes664/quality-ratchet@v1
  with:
    baseline: quality-baseline.json
    metrics: reports/metrics-current.json
```

The job needs `pull-requests: write` for the summary comment.

The action is deliberately language agnostic. It never runs your tools. You collect
the numbers however you like, whether that is `dotnet stryker`, `vitest --coverage`,
`ruff`, `jscpd` or a shell script, write them to a flat JSON object, and hand that
file over.

## The baseline

```json
{
  "frozen_at": "2026-05-04",
  "metrics": {
    "lint_violations_total": 483,
    "duplication_pct": 2.2,
    "coverage_line_pct": 7.0,
    "mutation_score_covered_pct": 81.6
  },
  "rules": {
    "monotonic_down": ["lint_violations_total", "duplication_pct"],
    "monotonic_up": ["coverage_line_pct", "mutation_score_covered_pct"]
  }
}
```

Commit it. It is the contract, and its diff is the audit trail of every time the
team decided to accept less.

## A missing metric is a failure

If the baseline names a metric and the current file does not carry it, the run
fails. A collector that quietly drops a metric produces exactly the green lie the
ratchet exists to prevent, so silence is treated as regression rather than as
permission.

## Escape hatches

Two, both deliberate and both visible in the pull request.

| Situation | How |
|---|---|
| Production hotfix that cannot wait | Add the `hotfix-bypass-ratchet` label |
| Deliberately lowering the baseline | Title the pull request `chore: lower baseline ...` or `refactor: ...` |

Both are configurable. Neither is silent: the summary comment states that the
failure was forgiven and why.

## Inputs

| Input | Default | Description |
|---|---|---|
| `baseline` | `quality-baseline.json` | Path to the committed baseline |
| `metrics` | `metrics-current.json` | Path to this run's measurements |
| `token` | `${{ github.token }}` | Token used to post the comment |
| `comment` | `true` | Post or update the summary comment |
| `bypass-label` | `hotfix-bypass-ratchet` | Label that forgives a failure |
| `lower-baseline-pattern` | `^(chore: lower baseline\|refactor:)` | Titles allowed to lower the baseline |

## Outputs

| Output | Description |
|---|---|
| `passed` | `true` when no metric regressed |
| `summary` | Markdown summary of every metric compared |
| `regressions` | JSON array of the metrics that regressed |

## Design

**No dependencies.** Node 20 ships `fetch`, so the GitHub REST API is called
directly. Nothing to bundle, nothing to audit, no supply chain.

**A pure core.** Every decision about passing or failing lives in `src/ratchet.js`,
which performs no I/O and is fully unit tested. `src/index.mjs` is the shell that
reads files, calls the API and sets the exit code. Coverage of the core is 100% of
lines and 87% of branches; the shell is covered by the `self-check` job in CI, which
runs the action against itself on every pull request.

**One comment per pull request.** The summary is updated in place. A fresh comment
on every push buries the conversation and teaches everyone to ignore the gate.

## License

MIT
