#!/usr/bin/env python3
"""Pull every roster in the ESPN league and write data/rosters.json + data/espn_pool.json.

No more hand-tracking: rosters come straight from ESPN (trades, waiver claims, drops by anyone in the
league). Run before every refresh (both weekly crons do) or any time by hand.

Config: data/league.json  {"leagueId": 12345678, "season": 2026, "public": true}
Private league? Either the commissioner sets League Settings -> Basic Settings -> "League Visibility" to
public (then the page can also read rosters live in the browser), or put the two ESPN cookies in
.espn_auth.json (git-ignored):  {"espn_s2": "...", "SWID": "{...}"}   (env ESPN_S2 / SWID also work).

Usage: python3 tools/sync_league.py [leagueId] [--dry-run]
"""
import json, os, re, sys, datetime, unicodedata, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
ESPN_TEAM = {1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAX",33:"BAL",34:"HOU"}
TEAM_NAME = {"ATL":"Atlanta Falcons","BUF":"Buffalo Bills","CHI":"Chicago Bears","CIN":"Cincinnati Bengals","CLE":"Cleveland Browns","DAL":"Dallas Cowboys","DEN":"Denver Broncos","DET":"Detroit Lions","GB":"Green Bay Packers","TEN":"Tennessee Titans","IND":"Indianapolis Colts","KC":"Kansas City Chiefs","LV":"Las Vegas Raiders","LAR":"Los Angeles Rams","MIA":"Miami Dolphins","MIN":"Minnesota Vikings","NE":"New England Patriots","NO":"New Orleans Saints","NYG":"New York Giants","NYJ":"New York Jets","PHI":"Philadelphia Eagles","ARI":"Arizona Cardinals","PIT":"Pittsburgh Steelers","LAC":"Los Angeles Chargers","SF":"San Francisco 49ers","SEA":"Seattle Seahawks","TB":"Tampa Bay Buccaneers","WAS":"Washington Commanders","CAR":"Carolina Panthers","JAX":"Jacksonville Jaguars","BAL":"Baltimore Ravens","HOU":"Houston Texans"}
ESPN_POS = {1:"QB",2:"RB",3:"WR",4:"TE",5:"K",16:"DST"}
IR_SLOT = 21

def norm(name):
    n = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n); n = re.sub(r"\bd/st\b", "", n)
    return re.sub(r"[^a-z]", "", n)

def auth_headers():
    a = {}
    f = HERE / ".espn_auth.json"
    if f.exists():
        try: a = json.loads(f.read_text())
        except Exception: sys.exit(".espn_auth.json is not valid JSON")
    s2 = os.environ.get("ESPN_S2") or a.get("espn_s2"); swid = os.environ.get("SWID") or a.get("SWID")
    h = {"Accept": "application/json"}
    if s2 and swid: h["Cookie"] = f"espn_s2={s2}; SWID={swid}"
    return h

def get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as r: return json.loads(r.read().decode("utf-8", "ignore"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403): sys.exit(f"ESPN refused ({e.code}): the league is private. Ask the commissioner to make it public, or add espn_s2 + SWID to .espn_auth.json (see docstring).")
        if e.code == 404: sys.exit("ESPN 404: league id / season not found. Double-check the leagueId in data/league.json.")
        raise

def player_row(pp):
    p = pp.get("playerPoolEntry", pp).get("player", {}) if "playerPoolEntry" in pp or "player" in pp else pp
    pos = ESPN_POS.get(p.get("defaultPositionId")); tm = ESPN_TEAM.get(p.get("proTeamId"))
    if not pos: return None
    name = TEAM_NAME.get(tm, p.get("fullName")) if pos == "DST" else p.get("fullName")
    return {"name": name, "pos": pos, "team": tm}

def parse_league(d):
    """-> {team display name: [players]} plus meta. Works with both team name shapes ESPN has used."""
    out = {}
    for t in d.get("teams", []):
        name = (t.get("name") or ((t.get("location") or "") + " " + (t.get("nickname") or ""))).strip()
        rows = []
        for e in (t.get("roster") or {}).get("entries", []):
            r = player_row(e)
            if r:
                if e.get("lineupSlotId") == IR_SLOT: r["ir"] = True
                rows.append(r)
        out[name] = rows
    return out

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]; dry = "--dry-run" in sys.argv
    cfgp = HERE / "data" / "league.json"
    cfg = json.loads(cfgp.read_text()) if cfgp.exists() else {}
    league = int(args[0]) if args else cfg.get("leagueId")
    season = int(cfg.get("season") or 2026)
    if not league: sys.exit("No league id. Put it in data/league.json as {\"leagueId\": 12345678, \"season\": 2026} or pass it as the first argument.")
    h = auth_headers()
    base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"
    d = get(base + "?view=mTeam&view=mRoster&view=mSettings", h)
    teams = parse_league(d)
    if len(teams) < 2: sys.exit("league returned <2 teams — refusing")
    rp = HERE / "data" / "rosters.json"
    old = json.loads(rp.read_text()) if rp.exists() else {"me": None}
    me = cfg.get("myTeam") or old.get("me")
    if me not in teams:
        sys.exit(f"My team '{me}' is not among the league's team names: {sorted(teams)}. Set \"myTeam\" in data/league.json to the exact name.")
    # ESPN's player universe for THIS league (rostered + free agents + waivers) -> replaces the hand-kept exclusions list
    flt = json.dumps({"players": {"filterSlotIds": {"value": [0, 2, 4, 6, 17, 16]}, "limit": 1500, "sortPercOwned": {"sortPriority": 1, "sortAsc": False}}})
    kp = get(base + "?view=kona_player_info", {**h, "x-fantasy-filter": flt})
    pool = {}
    for x in kp.get("players", []):
        r = player_row(x)
        if r: pool[norm(r["name"])] = {"onTeamId": x.get("onTeamId", 0), "status": x.get("status")}
    if len(pool) < 300: sys.exit(f"league player pool too small ({len(pool)}) — refusing")
    now = datetime.datetime.now(datetime.timezone.utc).astimezone()
    rosters = {"me": me, "updated": datetime.date.today().isoformat(), "source": f"ESPN league {league} sync {now.strftime('%Y-%m-%d %H:%M %Z')}",
               "leagueName": (d.get("settings") or {}).get("name"), "teams": teams}
    changes = []
    for t, rows in teams.items():
        o = {norm(p["name"]) for p in (old.get("teams") or {}).get(t, [])}; n = {norm(p["name"]) for p in rows}
        if o != n: changes.append(f"{t}: +{[p['name'] for p in rows if norm(p['name']) not in o]} -{sorted(o - n)}")
    print(f"league {league} '{rosters['leagueName']}': {len(teams)} teams, {sum(len(v) for v in teams.values())} rostered, ESPN pool {len(pool)}; me = {me}")
    print("changes vs previous rosters.json:" if changes else "no roster changes vs previous rosters.json"); [print("  " + c) for c in changes]
    if dry: return
    rp.write_text(json.dumps(rosters, indent=1))
    (HERE / "data" / "espn_pool.json").write_text(json.dumps({"note": "Players in ESPN's pool for this league (rostered, free agent or waivers). The page only treats FantasyPros-ranked players as free agents if they are in here and on no roster.",
        "leagueId": league, "updated": rosters["updated"], "players": sorted(pool)}, separators=(",", ":")))
    print("wrote data/rosters.json + data/espn_pool.json")

if __name__ == "__main__":
    main()
