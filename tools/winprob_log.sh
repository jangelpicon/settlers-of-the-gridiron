#!/bin/bash
# Game-day win-probability logger (launchd com.jose.fantasy-winprob-log, every 15 min).
# refresh live scores -> sync rosters -> node tools/winprob_log.js -> commit ONLY data/winprob_log.json -> push.
# Exits quietly when no game is live. Never touches the 2 AM deploy's files beyond the log (pathspec commit).
# Log: logs/winprob_log.log · exit 0 ok / 3 nothing live / other = failed step
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="America/Chicago"
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
mkdir -p logs; LOG="logs/winprob_log.log"; LOCK="logs/.winprob_log.lock"
log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
if ! mkdir "$LOCK" 2>/dev/null; then log "skip: lock held"; exit 75; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
# quick gate on the LAST snapshot first (cheap): if nothing was live or about to kick, still refresh at most hourly
python3 - <<'PY' || exit 0
import json, datetime, sys
p = json.load(open("data/projections.json")); now = datetime.datetime.now(datetime.timezone.utc)
def kick(g):
    try: return datetime.datetime.fromisoformat(g["kick"].replace("Z", "+00:00"))
    except Exception: return None
for g in p.get("games", {}).values():
    k = kick(g)
    if g.get("state") == "in": sys.exit(0)
    if k and -5 * 3600 < (now - k).total_seconds() < 15 * 60: sys.exit(0)      # kicking within 15 min, or kicked in the last 5 h
sys.exit(1)
PY
python3 tools/refresh_projections.py >> logs/winprob_log.out 2>&1 || { log "refresh_projections FAILED"; exit 12; }
python3 tools/sync_league.py >> logs/winprob_log.out 2>&1 || log "sync_league failed (using last rosters)"
NODE_PATH=./node_modules node tools/winprob_log.js >> logs/winprob_log.out 2>&1; RC=$?
if [ "$RC" = 3 ]; then exit 0; fi
if [ "$RC" != 0 ]; then log "winprob_log.js FAILED rc=$RC"; exit "$RC"; fi
log "$(tail -1 logs/winprob_log.out)"
git add -- data/winprob_log.json
if git diff --cached --quiet -- data/winprob_log.json; then exit 0; fi
git commit -q -m "Win-prob log $(date '+%Y-%m-%dT%H:%M%z')" -- data/winprob_log.json || { log "commit FAILED"; exit 30; }
git pull -q --rebase --autostash origin main >> logs/winprob_log.out 2>&1 || { log "pull --rebase FAILED"; git rebase --abort 2>/dev/null; exit 30; }
git push -q origin HEAD:main >> logs/winprob_log.out 2>&1 || { log "push FAILED"; exit 30; }
log "pushed $(git rev-parse --short HEAD)"
