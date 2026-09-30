#!/usr/bin/env python3
"""Build data/matchups.json — opponent-adjusted form + defense-vs-position + next-4 outlook —
and data/predlog.json — the walk-forward prediction log that fits the blend weights.

What it computes, from real box scores (ESPN league scoring) + the NFL schedule:
  defVsPos    per defense x position: avg fantasy points allowed per game to that position
              (for DST "defense" means the offense it faced — how many points opposing D/STs
              score against that team). "adj" = the same value regressed toward the league
              average by games/(games+3) — a 3-game sample only half counts. leagueAvg =
              per-position league mean of the raw values.
  playerForm  per player: games played, actual pts/game, facedAvg/facedAdj = what the defenses
              he faced normally allow to his position (raw / shrunk). season.html projects
              matchupView = actAvg x clamp(oppAdj / facedAdj, 0.5..1.6): his own production,
              scaled by how much softer or stingier this week's defense is than the ones he
              already faced, with the multiplier hard-capped so tiny samples can't run away.
  outlook     per NFL team: the next 4 weeks (opponent, home/away; missing week = bye).
  fittedW     per position: the consensus-vs-matchup blend weight FITTED on this season's own
              walk-forward prediction log instead of hand-picked. For every completed week w >= 2
              we rebuild the matchup view using ONLY weeks < w (no hindsight), pair it with the
              consensus projection ESPN/Sleeper served for week w (both retrievable retroactively),
              and score both against what actually happened. Grid-search the weight that minimizes
              squared error under the deployed rule wEff = min(w, n/(n+3)), then stabilize small
              samples by shrinking the fitted value toward the 0.5 default with 60 rows of prior
              strength: use = (fit*N + 0.5*60)/(N+60). Refits automatically every run as the
              season adds weeks, so the weights converge on measured accuracy.

Usage: python3 tools/refresh_matchups.py [currentWeek]
"""
import json, sys, datetime, zoneinfo, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "tools"))
from refresh_projections import get, norm, team, SEASON, ESPN_TEAM, TEAM_NAME, ESPN_POS, UA, SLEEPER_UA

OUTLOOK_WEEKS = 4
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]
RATIO_LO, RATIO_HI = 0.5, 1.6   # matchup multiplier cap — must mirror season.html predict()
W_DEFAULT = 0.5                  # hand-set prior weight, also the shrink target for thin fits
W_PRIOR_N = 60                   # rows of prior strength when stabilizing a fitted weight


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


def espn_week(week):
    """Per-week actual AND projected fantasy points (both retrievable retroactively). Needs the
    01-prefixed actual split ids in the filter — without them week-1 actuals come back empty."""
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
        actual = proj = None
        for s in p.get("stats", []):
            if s.get("scoringPeriodId") == week and s.get("statSplitTypeId") == 1:
                if s.get("statSourceId") == 0: actual = s.get("appliedTotal")
                elif s.get("statSourceId") == 1: proj = s.get("appliedTotal")
        if tm and (actual is not None or proj is not None):
            out[norm(name)] = {"pos": pos, "team": tm,
                               "pts": None if actual is None else round(actual, 2),
                               "proj": None if proj is None else round(proj, 2)}
    return out


def sleeper_week(week):
    d = get(f"https://api.sleeper.com/projections/nfl/{SEASON}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_ppr", SLEEPER_UA)
    out = {}
    for r in d:
        p = r.get("player") or {}; st = r.get("stats") or {}
        if st.get("pts_ppr") is None: continue
        name = f"{p.get('first_name','')} {p.get('last_name','')}".strip()
        out[norm(name)] = round(st["pts_ppr"], 2)
    return out


def build_model(weeks, sched, upto):
    """defVsPos / leagueAvg / playerForm from completed weeks < upto only (walk-forward safe)."""
    use = [w for w in weeks if w < upto]
    allowed = {}
    for w in use:
        per = {}
        for r in weeks[w].values():
            if r["pts"] is None: continue
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
    for by in def_vs_pos.values():
        for pos, e in by.items():
            lg = league_avg.get(pos)
            if lg:
                s = e["games"] / (e["games"] + 3)
                e["adj"] = round(lg + (e["avg"] - lg) * s, 2)
    logs = {}
    for w in use:
        for n, r in weeks[w].items():
            if r["pts"] is None: continue
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
        faced_adj = sum((def_vs_pos.get(opp, {}).get(e["pos"], {}).get("adj") or lg) for _, opp, _ in e["games"]) / ng
        player_form[n] = {"pos": e["pos"], "team": e["team"], "n": ng,
                          "actAvg": round(act, 2), "facedAvg": round(faced, 2), "facedAdj": round(faced_adj, 2)}
    return def_vs_pos, league_avg, player_form


def matchup_view(form, def_vs_pos, league_avg, opp):
    """Mirror of season.html predict(): capped opponent scaling of the player's own average."""
    dv = def_vs_pos.get(opp, {}).get(form["pos"])
    if not dv or form["facedAdj"] <= 0:
        return None
    opp_adj = dv.get("adj", dv["avg"])
    ratio = max(RATIO_LO, min(RATIO_HI, opp_adj / form["facedAdj"]))
    return round(form["actAvg"] * ratio, 2)


def backfill_log(weeks, sched, sleeper, wk):
    """Walk-forward: for each completed week w >= 2, matchup view from weeks < w only, paired with
    the consensus projection that was live for week w, scored against the actual."""
    rows = []
    for w in range(2, wk):
        dvp, lg, form = build_model(weeks, sched, upto=w)
        for n, r in weeks[w].items():
            if r["pts"] is None: continue
            f = form.get(n)
            if not f or f["pos"] != r["pos"]: continue
            g = sched[w].get(r["team"])
            if not g: continue
            mv = matchup_view(f, dvp, lg, g["opp"])
            cons = [v for v in (r["proj"], sleeper.get(w, {}).get(n)) if v is not None]
            if mv is None or not cons: continue
            rows.append({"w": w, "n": n, "pos": r["pos"], "games": f["n"],
                         "cons": round(sum(cons) / len(cons), 2), "mview": mv, "actual": r["pts"]})
    return rows


def fit_weights(rows):
    """Per position: grid-search the blend weight minimizing squared error under the deployed
    rule wEff = min(w, games/(games+3)); shrink thin fits toward the default."""
    out = {}
    for pos in POSITIONS:
        rs = [r for r in rows if r["pos"] == pos]
        if len(rs) < 20:
            continue
        def mse(wc):
            s = 0.0
            for r in rs:
                we = min(wc, r["games"] / (r["games"] + 3))
                pred = (1 - we) * r["cons"] + we * r["mview"]
                s += (pred - r["actual"]) ** 2
            return s / len(rs)
        grid = [i * 0.025 for i in range(0, 33)]   # 0.0 .. 0.8
        best = min(grid, key=mse)
        use = (best * len(rs) + W_DEFAULT * W_PRIOR_N) / (len(rs) + W_PRIOR_N)
        out[pos] = {"fit": round(best, 3), "use": round(use, 3), "nRows": len(rs),
                    "mseCons": round(mse(0.0), 2), "mseFit": round(mse(best), 2)}
    return out


def main():
    wk = int(sys.argv[1]) if len(sys.argv) > 1 else current_week()
    played = list(range(1, wk))
    if not played:
        sys.exit("no completed weeks yet — nothing to compute")
    sched = {w: schedule_week(w) for w in played + list(range(wk, min(wk + OUTLOOK_WEEKS, 19)))}
    weeks = {w: espn_week(w) for w in played}
    sleeper = {w: sleeper_week(w) for w in range(2, wk)}

    def_vs_pos, league_avg, player_form = build_model(weeks, sched, upto=wk)

    outlook = {}
    for tm in TEAM_NAME:
        outlook[tm] = [{"w": w, "opp": sched[w][tm]["opp"], "home": sched[w][tm]["home"]} if tm in sched[w]
                       else {"w": w, "bye": True} for w in range(wk, min(wk + OUTLOOK_WEEKS, 19))]

    rows = backfill_log(weeks, sched, sleeper, wk)
    fitted = fit_weights(rows)

    if len(def_vs_pos) < 20 or len(player_form) < 200:
        sys.exit(f"sample too small — refusing (defenses {len(def_vs_pos)}, players {len(player_form)})")
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago"))
    out = {"generated": now.strftime("%Y-%m-%d %-I:%M %p CT"), "generatedMs": int(now.timestamp() * 1000),
           "season": SEASON, "currentWeek": wk, "weeksSampled": played,
           "leagueAvg": league_avg, "defVsPos": def_vs_pos, "playerForm": player_form,
           "outlook": outlook, "fittedW": fitted}
    (HERE / "data" / "matchups.json").write_text(json.dumps(out, separators=(",", ":")))
    (HERE / "data" / "predlog.json").write_text(json.dumps(
        {"generated": out["generated"], "season": SEASON, "weeksScored": list(range(2, wk)), "rows": rows},
        separators=(",", ":")))
    fw = ", ".join(f"{p}: use {v['use']} (fit {v['fit']}, n={v['nRows']}, mse {v['mseCons']}->{v['mseFit']})" for p, v in fitted.items())
    print(f"week {wk}: sampled weeks {played}, defenses {len(def_vs_pos)}, players {len(player_form)}, "
          f"predlog rows {len(rows)} -> data/matchups.json + data/predlog.json ({out['generated']})")
    print("fitted weights:", fw or "none (insufficient rows)")


if __name__ == "__main__":
    main()
