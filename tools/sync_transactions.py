#!/usr/bin/env python3
"""Pull the league's add/drop/waiver/trade history from ESPN and write data/transactions.json.

Feeds the "Waiver log" tab (Jose, 2026-10-30). ESPN's mTransactions2 view is per scoring period and
leaks a few next-week rows into each week, so every week 1..current is fetched and deduped by id.
Lineup shuffles (ROSTER / FUTURE_ROSTER), the draft and trade bookkeeping are left out — the tab is
about who added, dropped, claimed (or failed to claim) whom. (Executed trades do not appear in this
feed with their players — only canceled proposals do — so trades stay on the Trades tab.)

Player ids are resolved to names through kona_player_info with a filterIds filter (the league endpoint
honors it; the bare /players endpoint ignores it). The snapshot stores the RAW ESPN transaction rows
plus an id -> {name,pos,team} map; season.html normalizes both this file and its own live fetch with
the same code, so the two can never disagree in shape.

Usage: python3 tools/sync_transactions.py [--dry-run]
"""
import json, sys, datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_league import HERE, auth_headers, get, player_row, team_name_of  # noqa: E402

KEEP = {"WAIVER", "FREEAGENT"}
TX_KEYS = ("id", "type", "status", "executionType", "teamId", "scoringPeriodId", "processDate", "proposedDate", "bidAmount")
ITEM_KEYS = ("type", "playerId", "fromTeamId", "toTeamId")

def prune(t):  # same ESPN field names, only the ones the page reads
    r = {k: t[k] for k in TX_KEYS if k in t}
    r["items"] = [{k: i[k] for k in ITEM_KEYS if k in i} for i in t.get("items", [])]
    return r

def main():
    dry = "--dry-run" in sys.argv
    cfg = json.loads((HERE / "data" / "league.json").read_text())
    league, season = cfg["leagueId"], int(cfg.get("season") or 2026)
    h = auth_headers()
    base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"
    d = get(base + "?view=mTeam", h)
    teams = {t["id"]: team_name_of(t) for t in d.get("teams", [])}
    cur = int((d.get("status") or {}).get("currentMatchupPeriod") or d.get("scoringPeriodId") or 1)
    if len(teams) < 2: sys.exit("league returned <2 teams — refusing")
    seen, rows = set(), []
    for w in range(1, cur + 1):
        for t in get(base + f"?view=mTransactions2&scoringPeriodId={w}", h).get("transactions", []):
            if t.get("id") in seen or t.get("type") not in KEEP: continue
            seen.add(t["id"]); rows.append(prune(t))
    ids = sorted({i.get("playerId") for t in rows for i in t.get("items", []) if i.get("playerId") is not None})
    players = {}
    for k in range(0, len(ids), 150):
        flt = json.dumps({"players": {"filterIds": {"value": ids[k:k + 150]}}})
        for x in get(base + "?view=kona_player_info", {**h, "x-fantasy-filter": flt}).get("players", []):
            r = player_row(x)
            if r: players[str(x["id"])] = r
    missing = [i for i in ids if str(i) not in players]
    now = datetime.datetime.now(datetime.timezone.utc).astimezone()
    out = {"note": "ESPN league transactions (view=mTransactions2, weeks 1..current, deduped, WAIVER + FREEAGENT only, fields pruned). Written by tools/sync_transactions.py — do not hand-edit. season.html normalizes these raw rows (and its own live fetch) with the same code.",
           "generated": now.strftime("%Y-%m-%d %I:%M %p %Z"), "generatedMs": int(now.timestamp() * 1000), "leagueId": league, "season": season, "currentWeek": cur,
           "teams": {str(k): v for k, v in teams.items()}, "players": players, "transactions": sorted(rows, key=lambda t: t.get("processDate") or t.get("proposedDate") or 0)}
    kinds = {}
    for t in rows: kinds[t["type"]] = kinds.get(t["type"], 0) + 1
    print(f"league {league}: weeks 1..{cur}, {len(rows)} transactions kept {kinds}, {len(players)} player names resolved" + (f", UNRESOLVED ids: {missing}" if missing else ""))
    if dry: return
    (HERE / "data" / "transactions.json").write_text(json.dumps(out, separators=(",", ":")))
    print("wrote data/transactions.json")

if __name__ == "__main__":
    main()
