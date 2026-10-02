#!/usr/bin/env bash
# Smoke test of the action on Gitea Actions. Starts Gitea and act_runner as containers,
# pushes the action and the fixture repository, and checks on a real server that:
# - the lock-in example opens one pull request with the tightened baseline, and a second
#   push to main updates it instead of opening another;
# - a pull request whose branch is behind the tightened base passes, because the contract
#   is read at the merge base, and one that loosens the baseline fails;
# - the second run of a pull request updates the comment of the first.
#
# Needs docker, git, curl and node. SMOKE_HOST and SMOKE_PORT say where the docker daemon
# publishes Gitea, for a remote daemon or a busy port.
set -euo pipefail

GITEA_IMAGE="${GITEA_IMAGE:-gitea/gitea:1.26}"
RUNNER_IMAGE="${RUNNER_IMAGE:-gitea/act_runner:0.6.1}"
JOB_IMAGE="${JOB_IMAGE:-node:24-bookworm}"
SMOKE_HOST="${SMOKE_HOST:-localhost}"
SMOKE_PORT="${SMOKE_PORT:-3000}"
# Seconds to wait for one workflow run. The first one also pulls the job image.
RUN_TIMEOUT="${RUN_TIMEOUT:-600}"

GITEA=quality-ratchet-smoke-gitea
RUNNER=quality-ratchet-smoke-runner
NETWORK=quality-ratchet-smoke
OWNER=smoke
REPO="/repos/$OWNER/fixture"
LOCK_IN_BRANCH=quality-ratchet/lock-in
MARKER='<!-- quality-ratchet -->'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
PASSWORD="$(node -p 'require("node:crypto").randomBytes(16).toString("hex")')"
REMOTE="http://$OWNER:$PASSWORD@$SMOKE_HOST:$SMOKE_PORT/$OWNER"

# Git Bash on Windows must not rewrite the container paths.
export MSYS_NO_PATHCONV=1
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.com
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.com

# Removes the containers and keeps the exit code. After a failure, prints the logs of the
# workflow runs first, indented so that their workflow commands are not read as ours.
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    echo "== Logs of the workflow runs"
    docker exec "$GITEA" sh -c 'find /data/gitea/actions_log -type f | sort | xargs -r cat' \
      | sed 's/^/  /' || true
    docker logs --tail 100 "$RUNNER" || true
  fi
  docker rm -f -v "$GITEA" "$RUNNER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

# api METHOD PATH [JSON]: calls the API as the admin user.
api() {
  curl -sS --fail-with-body --max-time 30 -u "$OWNER:$PASSWORD" -X "$1" \
    -H 'Content-Type: application/json' ${3:+-d "$3"} \
    "http://$SMOKE_HOST:$SMOKE_PORT/api/v1$2"
}

# json EXPRESSION: evaluates the expression on the JSON of the standard input (".state").
json() {
  node -pe "JSON.parse(require('node:fs').readFileSync(0, 'utf8'))$1"
}

# wait_until SECONDS COMMAND...: repeats the command until it succeeds.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timed out: $*" >&2
      return 1
    fi
    sleep 2
  done
}

# expect WHAT ACTUAL EXPECTED
expect() {
  if [ "$2" != "$3" ]; then
    echo "FAILED $1: expected '$3', got '$2'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# commit MESSAGE: commits the whole folder.
commit() {
  git add -A
  git commit -q -m "$1"
}

# publish NAME: creates the repository and pushes the current folder as its main branch.
publish() {
  api POST /user/repos "{\"name\":\"$1\",\"default_branch\":\"main\"}" >/dev/null
  git init -q -b main .
  git config commit.gpgsign false
  git remote add origin "$REMOTE/$1.git"
  commit "$1"
  git push -q origin main
}

# wait_for_run COMMIT: waits for the workflow run of a commit, which must succeed.
wait_for_run() {
  local state='' deadline=$((SECONDS + RUN_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(api GET "$REPO/commits/$1/status" | json .state || true)"
    case "$state" in
      success) return 0 ;;
      failure | error) break ;;
    esac
    sleep 3
  done
  echo "FAILED: the run of $1 ended as '$state'" >&2
  return 1
}

# push_report VALUE: main measures a new coverage; waits for the lock-in workflow.
push_report() {
  printf '{ "coverage_pct": %s }\n' "$1" > report.json
  commit "coverage $1"
  git push -q origin main
  wait_for_run "$(git rev-parse HEAD)"
}

# Numbers of the open lock-in pull requests, separated by commas.
lock_in_pulls() {
  local mine="pull.head.ref === '$LOCK_IN_BRANCH'"
  api GET "$REPO/pulls?state=open" \
    | json ".filter((pull) => $mine).map((pull) => pull.number).join()"
}

# baseline_coverage REF: coverage in the baseline of a branch.
baseline_coverage() {
  api GET "$REPO/raw/quality-baseline.json?ref=$1" | json .metrics.coverage_pct.value
}

# summary_comments NUMBER FIELD: a field of each summary comment of a pull request.
summary_comments() {
  local mine="comment.body.startsWith('$MARKER')"
  api GET "$REPO/issues/$1/comments" \
    | json ".filter((comment) => $mine).map((comment) => comment.$2).join()"
}

echo "== $GITEA_IMAGE with $RUNNER_IMAGE"
docker network create "$NETWORK" >/dev/null
docker run -d --name "$GITEA" --network "$NETWORK" --network-alias gitea \
  -p "$SMOKE_PORT:3000" \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__server__ROOT_URL=http://gitea:3000/ \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  -e GITEA__actions__LOG_COMPRESSION=none \
  "$GITEA_IMAGE" >/dev/null
wait_until 120 curl -fsS --max-time 5 "http://$SMOKE_HOST:$SMOKE_PORT/api/healthz"
docker exec -u git "$GITEA" gitea admin user create --admin --username "$OWNER" \
  --password "$PASSWORD" --email smoke@example.com --must-change-password=false >/dev/null

# The jobs join the network of the server, where the workflows reach it as "gitea".
cd "$WORK"
printf 'container:\n  network: %s\n' "$NETWORK" > runner.yaml
registration="$(docker exec -u git "$GITEA" gitea actions generate-runner-token)"
docker create --name "$RUNNER" --network "$NETWORK" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e CONFIG_FILE=/runner.yaml \
  -e GITEA_INSTANCE_URL=http://gitea:3000 \
  -e GITEA_RUNNER_REGISTRATION_TOKEN="$registration" \
  -e GITEA_RUNNER_LABELS="ubuntu-latest:docker://$JOB_IMAGE" \
  "$RUNNER_IMAGE" >/dev/null
docker cp runner.yaml "$RUNNER:/runner.yaml"
docker start "$RUNNER" >/dev/null

mkdir action fixture
cd "$WORK/action"
cp -r "$ROOT/action.yml" "$ROOT/package.json" "$ROOT/src" .
publish quality-ratchet
cd "$WORK/fixture"
cp -r "$ROOT/test/smoke/fixture/." .
publish fixture

echo "== Lock-in on main"
wait_for_run "$(git rev-parse HEAD)"
pull="$(lock_in_pulls)"
expect 'a push with nothing to lock in opens no pull request' "$pull" ''
# Cut before main tightens: this branch stays behind the lock-in.
git branch feature
push_report 85
pull="$(lock_in_pulls)"
expect 'an improvement opens the lock-in pull request' "$pull" 1
expect 'its baseline has the measured value' "$(baseline_coverage "$LOCK_IN_BRANCH")" 85
push_report 90
expect 'a second improvement reuses the pull request' "$(lock_in_pulls)" "$pull"
expect 'and updates its baseline' "$(baseline_coverage "$LOCK_IN_BRANCH")" 90
wait_until 60 api POST "$REPO/pulls/$pull/merge" '{"Do":"merge"}'
expect 'merging it tightens main' "$(baseline_coverage main)" 90

echo "== Governance and comment on a pull request"
git checkout -q feature
echo 'passed=true loosened=[]' > expected-outputs.txt
commit 'behind the tightened base'
first="$(git rev-parse HEAD)"
git push -q origin feature
number="$(api POST "$REPO/pulls" '{"base":"main","head":"feature","title":"feat: behind"}' \
  | json .number)"
wait_for_run "$first"
echo 'ok: a branch behind the tightened base passes (contract read at the merge base)'
comment="$(summary_comments "$number" id)"
body="$(summary_comments "$number" body)"
case "$comment" in
  '' | *[!0-9]*)
    echo "FAILED: expected one summary comment, got '$comment'" >&2
    exit 1
    ;;
esac
echo 'ok: the first run posts one comment'

sed 's/"value": 80/"value": 70/' quality-baseline.json > loosened.json
mv loosened.json quality-baseline.json
echo 'passed=false loosened=["coverage_pct"]' > expected-outputs.txt
commit 'loosen the baseline'
second="$(git rev-parse HEAD)"
git push -q origin feature
wait_for_run "$second"
echo 'ok: loosening the baseline without an authorising title fails'
expect 'the second run updates the same comment' "$(summary_comments "$number" id)" "$comment"
if [ "$(summary_comments "$number" body)" = "$body" ]; then
  echo 'FAILED: the comment still has the text of the first run' >&2
  exit 1
fi
echo "Smoke test passed."
