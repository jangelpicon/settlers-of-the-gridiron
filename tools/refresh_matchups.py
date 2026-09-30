#!/usr/bin/env python3
"""Build data/matchups.json — opponent-adjusted form + defense-vs-position + next-4 outlook.

What it computes, from real box scores (ESPN league scoring) + the NFL schedule:
  defVsPos    per defense x position: avg fantasy points allowed per game to that position
              (for DST "defense" means the offense it faced — how many points opposing D/STs
              score against that team). leagueAvg = per-position league mean of those.
  playerForm  per player: games played, actual pts/game, and facedAvg = what the defenses he
              faced normally allow to his position (unscaled pool average). season.html projects
              matchupProj = actAvg x (thisWeekDefAllows / facedAvg): his own production, scaled
              by how much softer or stingier this week's defense is than the ones he already
              faced. A player who produced against stingy defenses grades up; a soft-schedule
              stat line grades down. Share-invariant, so it works for QB and WR alike.
  outlook     per NFL team: the next 4 weeks (opponent, home/away; missing week = bye), so the
              page can render any position's upcoming-matchup strip from defVsPos.

Small-sample caveat: early season this runs on 2-3 games per defense; season.html shrinks the
form signal by games played (w = n/(n+3), capped 0.5) so one hot week can't dominate.
Usage: python3 tools/refresh_matchups.py [currentWeek]
"""
import json, sys, datetime, zoneinfo, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "tools"))
from refresh_projections import get, norm, team, SEASON, ESPN_TEAM, TEAM_NAME, ESPN_POS, UA

OUTLOOK_WEEKS = 4
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]


def schedule_week(week):
    d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week={week}", UA)
    games = {}
    for e in d.get("events", []):
        comps = e["competitions"][0]["competitors"]
        for t in comps:
            code = team(t["team"]["abbreviation"])
            opp = team([x for x in comps if x is not t][0]["team"]["abbreviation"])
            games[code] = {"opp": opp, "home": t["homeAway"] == "home"}
    return games


def current_week():
    sb = get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", UA)
    week = (sb.get("week") or {}).get("number") or 1
    evs = sb.get("events") or []
    # ESPN reports the finished week until its Wednesday rollover (same rule as refresh_projections)
    if evs and all(((ev.get("status") or {}).get("type") or {}).get("completed") for ev in evs):
        week += 1
    return week


def actuals_week(week):
    """Per-week actual fantasy points. Needs the 01-prefixed actual split ids in the filter —
    without them ESPN returns week-1 actuals empty."""
    flt = json.dumps({"players": {"filterSlotIds": {"value": [0, 2, 4, 6, 17, 16]}, "limit": 900,
                                  "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                                  "filterStatsForTopScoringPeriodIds": {"value": 5, "additionalValue": [
                                      f"00{SEASON}", f"10{SEASON}", f"11{SEASON}{week}",
                                      f"02{SEASON}", f"01{SEASON}", f"01{SEASON}{week}"]}}})
    d = get(f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leaguedefaults/3?scoringPeriodId={week}&view=kona_player_info",
            {"x-fantasy-filter": flt, "Accept": "application/json", **UA})
    out = {}
    for x in d.get("players", []):
        p = x["player"]; pos = ESPN_POS.get(p.get("defaultPositionId"))
        if not pos: continue
        tm = ESPN_TEAM.get(p.get("proTeamId"))
        name = TEAM_NAME.get(tm, p["fullName"]) if pos == "DST" else p["fullName"]
        actual = None
        for s in p.get("stats", []):
            if s.get("scoringPeriodId") == week and s.get("statSplitTypeId") == 1 and s.get("statSourceId") == 0:
                actual = s.get("appliedTotal")
        if actual is not None and tm:
            out[norm(name)] = {"pos": pos, "team": tm, "pts": round(actual, 2)}
    return out


def main():
    wk = int(sys.argv[1]) if len(sys.argv) > 1 else current_week()
    played = list(range(1, wk))
    if not played:
        sys.exit("no completed weeks yet — nothing to compute")
    sched = {w: schedule_week(w) for w in played + list(range(wk, min(wk + OUTLOOK_WEEKS, 19)))}
    weeks = {w: actuals_week(w) for w in played}

    # defense x position: points allowed per game
    allowed = {}   # def -> pos -> [per-game totals]
    for w in played:
        per = {}   # (team, pos) -> pts that week
        for r in weeks[w].values():
            per[(r["team"], r["pos"])] = per.get((r["team"], r["pos"]), 0.0) + r["pts"]
        for (tm, pos), pts in per.items():
            g = sched[w].get(tm)
            if g:
                allowed.setdefault(g["opp"], {}).setdefault(pos, []).append(round(pts, 2))
    def_vs_pos = {d: {pos: {"avg": round(sum(v) / len(v), 2), "games": len(v)} for pos, v in by.items()}
                  for d, by in allowed.items()}
    league_avg = {}
    for pos in POSITIONS:
        vals = [by[pos]["avg"] for by in def_vs_pos.values() if pos in by]
        if vals:
            league_avg[pos] = round(sum(vals) / len(vals), 2)

    # player form: his production + the (unscaled) difficulty of the defenses he faced
    logs = {}      # norm -> {pos, team, games: [(week, opp, pts)]}
    for w in played:
        for n, r in weeks[w].items():
            g = sched[w].get(r["team"])
            if not g: continue
            e = logs.setdefault(n, {"pos": r["pos"], "team": r["team"], "games": []})
            e["team"] = r["team"]
            e["games"].append((w, g["opp"], r["pts"]))
    player_form = {}
    for n, e in logs.items():
        lg = league_avg.get(e["pos"])
        if not lg: continue
        ng = len(e["games"])
        act = sum(p for _, _, p in e["games"]) / ng
        faced = sum((def_vs_pos.get(opp, {}).get(e["pos"], {}).get("avg") or lg) for _, opp, _ in e["games"]) / ng
        player_form[n] = {"pos": e["pos"], "team": e["team"], "n": ng,
                          "actAvg": round(act, 2), "facedAvg": round(faced, 2)}

    outlook = {}
    for tm in TEAM_NAME:
        outlook[tm] = [{"w": w, "opp": sched[w][tm]["opp"], "home": sched[w][tm]["home"]} if tm in sched[w]
                       else {"w": w, "bye": True} for w in range(wk, min(wk + OUTLOOK_WEEKS, 19))]

    if len(def_vs_pos) < 20 or len(player_form) < 200:
        sys.exit(f"sample too small — refusing (defenses {len(def_vs_pos)}, players {len(player_form)})")
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago"))
    out = {"generated": now.strftime("%Y-%m-%d %-I:%M %p CT"), "generatedMs": int(now.timestamp() * 1000),
           "season": SEASON, "currentWeek": wk, "weeksSampled": played,
           "leagueAvg": league_avg, "defVsPos": def_vs_pos, "playerForm": player_form, "outlook": outlook}
    (HERE / "data" / "matchups.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"week {wk}: sampled weeks {played}, defenses {len(def_vs_pos)}, players {len(player_form)} -> data/matchups.json ({out['generated']})")


if __name__ == "__main__":
    main()
