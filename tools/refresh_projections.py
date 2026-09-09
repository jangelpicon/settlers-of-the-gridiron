#!/usr/bin/env python3
"""Snapshot the live projection feeds into data/projections.json (fallback for season.html).

season.html fetches these SAME three feeds live in the browser on every load (all three send
Access-Control-Allow-Origin: *). This file is only the safety net when a feed is down, and the
input for the headless test / weekly Discord report. Shape must stay identical to the page's
normalize() in season.html.

Feeds (all public, no auth):
  ESPN fantasy projections + injury status  lm-api-reads.fantasy.espn.com  kona_player_info (week N)
  Sleeper projections + injury status       api.sleeper.com/projections/nfl/<season>/<week>
  Vegas lines / kickoffs / game status      site.api.espn.com scoreboard (week N)
Usage: python3 tools/refresh_projections.py [week]
"""
import json, re, sys, datetime, zoneinfo, urllib.request, unicodedata
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
SEASON = 2026
ESPN_TEAM = {1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAX",33:"BAL",34:"HOU"}
TEAM_NAME = {"ATL":"Atlanta Falcons","BUF":"Buffalo Bills","CHI":"Chicago Bears","CIN":"Cincinnati Bengals","CLE":"Cleveland Browns","DAL":"Dallas Cowboys","DEN":"Denver Broncos","DET":"Detroit Lions","GB":"Green Bay Packers","TEN":"Tennessee Titans","IND":"Indianapolis Colts","KC":"Kansas City Chiefs","LV":"Las Vegas Raiders","LAR":"Los Angeles Rams","MIA":"Miami Dolphins","MIN":"Minnesota Vikings","NE":"New England Patriots","NO":"New Orleans Saints","NYG":"New York Giants","NYJ":"New York Jets","PHI":"Philadelphia Eagles","ARI":"Arizona Cardinals","PIT":"Pittsburgh Steelers","LAC":"Los Angeles Chargers","SF":"San Francisco 49ers","SEA":"Seattle Seahawks","TB":"Tampa Bay Buccaneers","WAS":"Washington Commanders","CAR":"Carolina Panthers","JAX":"Jacksonville Jaguars","BAL":"Baltimore Ravens","HOU":"Houston Texans"}
ESPN_POS = {1:"QB",2:"RB",3:"WR",4:"TE",5:"K",16:"DST"}
ALIAS = {"WSH":"WAS","JAC":"JAX","LA":"LAR","OAK":"LV","SD":"LAC","STL":"LAR"}
ESPN_INJ = {"ACTIVE":"ACT","DAY_TO_DAY":"DTD","QUESTIONABLE":"Q","DOUBTFUL":"D","OUT":"O","INJURY_RESERVE":"IR","SUSPENSION":"SUSP"}
SLEEPER_INJ = {"Questionable":"Q","Doubtful":"D","Out":"O","IR":"IR","PUP":"IR","Sus":"SUSP","NA":"O","COV":"O"}
UA = {}  # ESPN 403s on a browser UA; a plain client works
SLEEPER_UA = {"User-Agent": "curl/8.4.0"}  # Sleeper 403s on Python's default UA

def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=45) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))

def norm(name):
    n = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    n = re.sub(r"\bd/st\b", "", n)
    return re.sub(r"[^a-z]", "", n)

def team(code): code = (code or "").upper(); return ALIAS.get(code, code)

def scoreboard(week):
    d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week={week}", UA)
    games = {}
    for e in d.get("events", []):
        c = e["competitions"][0]
        odds = (c.get("odds") or [{}])[0]
        ou = odds.get("overUnder"); det = odds.get("details") or ""
        m = re.match(r"([A-Z]{2,4})\s*([-+]?\d+(?:\.\d+)?)", det); fav, line = (team(m.group(1)), abs(float(m.group(2)))) if m else (None, None)
        st = (c.get("status") or {}).get("type") or {}
        w = c.get("weather") or {}
        comps = c["competitors"]
        for t in comps:
            code = team(t["team"]["abbreviation"]); opp = team([x for x in comps if x is not t][0]["team"]["abbreviation"])
            spread = None if line is None else (-line if code == fav else line)   # negative = favorite
            implied = None if (ou is None or spread is None) else round((ou - spread) / 2, 2)
            games[code] = {"opp": opp, "home": t["homeAway"] == "home", "kick": e["date"], "ou": ou, "spread": spread, "implied": implied,
                           "state": st.get("state"), "status": st.get("shortDetail") or st.get("name"),
                           "score": int(t["score"]) if str(t.get("score", "")).isdigit() else None,
                           "weather": (w.get("displayValue") or "") + (f" {w['temperature']}°" if w.get("temperature") is not None else "")}
    return games, d.get("week", {}).get("number")

def espn(week):
    flt = json.dumps({"players": {"filterSlotIds": {"value": [0, 2, 4, 6, 17, 16]}, "limit": 900, "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                                  "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [f"00{SEASON}", f"10{SEASON}", f"11{SEASON}{week}", f"02{SEASON}"]}}})
    d = get(f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leaguedefaults/3?scoringPeriodId={week}&view=kona_player_info",
            {"x-fantasy-filter": flt, "Accept": "application/json", **UA})
    out = {}
    for x in d.get("players", []):
        p = x["player"]; pos = ESPN_POS.get(p.get("defaultPositionId"))
        if not pos: continue
        tm = ESPN_TEAM.get(p.get("proTeamId"))
        name = TEAM_NAME.get(tm, p["fullName"]) if pos == "DST" else p["fullName"]
        proj = actual = None
        for s in p.get("stats", []):
            if s.get("scoringPeriodId") == week and s.get("statSplitTypeId") == 1:
                if s.get("statSourceId") == 1: proj = s.get("appliedTotal")
                elif s.get("statSourceId") == 0: actual = s.get("appliedTotal")
        out[norm(name)] = {"name": name, "pos": pos, "team": tm, "proj": None if proj is None else round(proj, 2),
                           "actual": None if actual is None else round(actual, 2), "inj": ESPN_INJ.get(p.get("injuryStatus") or "ACTIVE", "ACT"),
                           "own": round((p.get("ownership") or {}).get("percentOwned") or 0, 1)}
    return out

def sleeper(week):
    d = get(f"https://api.sleeper.com/projections/nfl/{SEASON}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_ppr", SLEEPER_UA)
    out = {}
    for r in d:
        p = r.get("player") or {}; st = r.get("stats") or {}
        if st.get("pts_ppr") is None: continue
        pos = "DST" if p.get("position") == "DEF" else p.get("position")
        name = f"{p.get('first_name','')} {p.get('last_name','')}".strip()
        out[norm(name)] = {"name": name, "pos": pos, "team": team(r.get("team")), "proj": round(st["pts_ppr"], 2),
                           "inj": SLEEPER_INJ.get(p.get("injury_status") or "", "ACT"), "injNote": p.get("injury_body_part") or ""}
    return out

def main():
    week = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if week is None:
        sb0 = get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", UA)
        week = (sb0.get("week") or {}).get("number") or 1
    games, _ = scoreboard(week)
    e = espn(week); s = sleeper(week)
    if len(e) < 200 or len(s) < 200 or len(games) < 20:
        sys.exit(f"feed too small — refusing (espn {len(e)}, sleeper {len(s)}, games {len(games)})")
    players = {}
    for n, r in e.items(): players[n] = {"name": r["name"], "pos": r["pos"], "team": r["team"], "espn": r["proj"], "actual": r["actual"], "injE": r["inj"], "own": r["own"]}
    for n, r in s.items():
        q = players.setdefault(n, {"name": r["name"], "pos": r["pos"], "team": r["team"]})
        q["sleeper"] = r["proj"]; q["injS"] = r["inj"]
        if r.get("injNote"): q["injNote"] = r["injNote"]
        if not q.get("team"): q["team"] = r["team"]
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago"))
    out = {"generated": now.strftime("%Y-%m-%d %-I:%M %p CT"), "generatedMs": int(now.timestamp() * 1000), "week": week, "season": SEASON,
           "sources": {"espn": len(e), "sleeper": len(s), "games": len(games)}, "games": games, "players": players}
    (HERE / "data" / "projections.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"week {week}: espn {len(e)}, sleeper {len(s)}, games {len(games)}, merged {len(players)} -> data/projections.json ({out['generated']})")

if __name__ == "__main__":
    main()
