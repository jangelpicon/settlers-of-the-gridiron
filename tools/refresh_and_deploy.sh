#!/bin/bash
# Atomic refresh + deploy for the fantasy dashboard.
#
# Why this exists: the weekly agent crons used to own "regenerate -> test -> git commit/push -> verify"
# as prose steps. When the test gate went red the agent (correctly) held the push but still posted its
# report, so the only symptom was GitHub Pages quietly serving last week's data. Here the whole chain is
# one script with one exit code: either the fresh data is live, or this exits nonzero and says where it died.
#
# Usage:
#   tools/refresh_and_deploy.sh            regenerate -> test gate -> scoped commit -> push -> verify live
#   tools/refresh_and_deploy.sh --dry-run  regenerate -> test gate only (no commit, no push, no network to origin)
#
# Exit codes: 0 ok | 2 bad usage/preflight | 10 sync_league | 11 refresh_season | 12 refresh_projections
#             20 test gate | 30 git commit/push | 40 live site still stale after the poll window | 75 another run holds the lock
#
# Log:    logs/refresh_and_deploy.log   (one timestamped line per step; full child output in logs/refresh_and_deploy.out)
# Status: logs/last_run.json            (machine-readable result of the latest run — the agent crons read this)
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="America/Chicago"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

LIVE_BASE="${LIVE_BASE:-https://jangelpicon.github.io/settlers-of-the-gridiron}"
POLL_TRIES="${POLL_TRIES:-6}"
POLL_SLEEP="${POLL_SLEEP:-20}"
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

mkdir -p logs
LOG="logs/refresh_and_deploy.log"
OUT="logs/refresh_and_deploy.out"
STATUS="logs/last_run.json"
LOCK="logs/.refresh_and_deploy.lock"
STARTED="$(date '+%Y-%m-%dT%H:%M:%S%z')"
STAGE="preflight"; RESULT="failed"; SHA=""; STAMP=""; LIVE=""; NOTE=""
MODE=$([ "$DRY" = 1 ] && echo dry-run || echo deploy)

log(){ echo "$(date '+%Y-%m-%d %H:%M:%S %Z') [$MODE] $*" | tee -a "$LOG"; }
stamp_of(){ python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("generated",""))' "$1"; }

finish(){
  local rc=$?
  [ "$rc" = 0 ] && RESULT="ok"
  python3 - "$STATUS" "$STARTED" "$MODE" "$RESULT" "$rc" "$STAGE" "$STAMP" "$SHA" "$LIVE" "$NOTE" <<'PY' || true
import json, sys, datetime
k = ["started","mode","result","exit","stage","stamp","commit","live","note"]
d = dict(zip(k, sys.argv[2:]))
d["exit"] = int(d["exit"]); d["finished"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
  log "END result=$RESULT exit=$rc stage=$STAGE stamp='$STAMP' commit=${SHA:-none} live=${LIVE:-n/a}${NOTE:+ note=$NOTE}"
  [ -d "$LOCK" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
  exit "$rc"
}

# ---- single-run lock (launchd + an agent fallback run must never interleave) ----
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    log "another run (pid $OLD) holds the lock — exiting 75"; exit 75
  fi
  log "clearing stale lock (pid ${OLD:-?} is gone)"; rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap finish EXIT
log "START repo=$REPO head=$(git rev-parse --short HEAD)"

# ---- preflight: right branch, not behind origin, secrets never tracked ----
BR="$(git rev-parse --abbrev-ref HEAD)"
if [ "$DRY" = 0 ] && [ "$BR" != "main" ]; then NOTE="on branch $BR, Pages serves main"; log "ABORT: $NOTE"; exit 2; fi
if git ls-files --error-unmatch .espn_auth.json >/dev/null 2>&1; then NOTE=".espn_auth.json is TRACKED"; log "ABORT: $NOTE"; exit 2; fi
git check-ignore -q .espn_auth.json || { NOTE=".espn_auth.json is not gitignored"; log "ABORT: $NOTE"; exit 2; }
if [ "$DRY" = 0 ]; then
  git fetch -q origin main
  git merge-base --is-ancestor origin/main HEAD || { NOTE="local main is behind/diverged from origin/main — pull first"; log "ABORT: $NOTE"; exit 2; }
fi

run(){  # run <stage> <exit-code> <cmd...> : full output to $OUT, one summary line to $LOG
  local st="$1" code="$2"; shift 2; STAGE="$st"
  echo "===== $(date '+%F %T %Z') $st: $*" >> "$OUT"
  if "$@" >> "$OUT" 2>&1; then log "$st ok"; return 0; fi
  log "$st FAILED (see $OUT)"; return "$code"
}

# ---- 1. regenerate ----
STAGE="sync_league"
echo "===== $(date '+%F %T %Z') sync_league" >> "$OUT"
set +e; SYNC_OUT="$(python3 tools/sync_league.py 2>&1)"; SYNC_RC=$?; set -e
echo "$SYNC_OUT" >> "$OUT"
if [ "$SYNC_RC" = 0 ]; then
  log "sync_league ok — $(echo "$SYNC_OUT" | grep -m1 -E 'roster changes|changes vs' || echo 'synced')"
elif echo "$SYNC_OUT" | grep -q "ESPN refused (40[13])"; then
  log "sync_league: league is private (401/403) — continuing with repo rosters (existing behavior)"
else
  log "sync_league FAILED rc=$SYNC_RC: $(echo "$SYNC_OUT" | tail -1)"; exit 10
fi
run refresh_season 11 python3 tools/refresh_season.py || exit $?
run refresh_projections 12 python3 tools/refresh_projections.py || exit $?
STAMP="$(stamp_of data/season.json)"
PSTAMP="$(stamp_of data/projections.json)"
log "machine stamps: season='$STAMP' projections='$PSTAMP'"

# ---- 2. test gate: must exit 0 ----
run test_gate 20 node test_season.js || { tail -3 "$OUT" | sed 's/^/    /' | tee -a "$LOG"; exit 20; }

if [ "$DRY" = 1 ]; then
  STAGE="done"; NOTE="dry run: regenerated + test gate green; no commit/push"
  log "dry run complete — data/ regenerated in the working tree, nothing committed or pushed"
  exit 0
fi

# ---- 3. scoped commit: data/ only, never -A ----
STAGE="commit"
git add -- data/
if git diff --cached --name-only | grep -q "espn_auth"; then NOTE="auth file staged"; log "ABORT: $NOTE"; exit 30; fi
if git diff --cached --quiet -- data/; then
  log "no data changes to commit (already deployed at $(git rev-parse --short HEAD))"
else
  CHANGED="$(git diff --cached --name-only -- data/ | tr '\n' ' ')"
  # pathspec form commits ONLY data/ even if something else happens to be staged in the tree
  git commit -q -m "Auto refresh+deploy $(date '+%Y-%m-%dT%H:%M:%S%z')" -m "Data stamp: $STAMP (projections $PSTAMP). Files: $CHANGED" -- data/ >> "$OUT" 2>&1 \
    || { log "git commit FAILED"; exit 30; }
  log "committed $(git rev-parse --short HEAD): $CHANGED"
fi
SHA="$(git rev-parse HEAD)"
STAGE="push"
if [ "$(git rev-parse origin/main)" != "$SHA" ]; then
  git push -q origin HEAD:main >> "$OUT" 2>&1 || { log "git push FAILED (see $OUT)"; exit 30; }
  log "pushed $SHA to origin/main"
else
  log "origin/main already at $SHA — nothing to push"
fi

# ---- 4. verify live: both stamps served by Pages ----
STAGE="verify_live"
for i in $(seq 1 "$POLL_TRIES"); do
  sleep "$POLL_SLEEP"
  LS="$(curl -fsS "$LIVE_BASE/data/season.json?v=$RANDOM$RANDOM" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("generated",""))' 2>/dev/null || true)"
  LP="$(curl -fsS "$LIVE_BASE/data/projections.json?v=$RANDOM$RANDOM" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("generated",""))' 2>/dev/null || true)"
  log "poll $i/$POLL_TRIES: live season='$LS' projections='$LP'"
  if [ "$LS" = "$STAMP" ] && [ "$LP" = "$PSTAMP" ]; then LIVE="yes"; STAGE="done"; log "LIVE: Pages serves the new stamps"; exit 0; fi
done
LIVE="stale"; NOTE="Pages still serving season='$LS' after $((POLL_TRIES*POLL_SLEEP))s"
log "STALE: $NOTE"
exit 40
