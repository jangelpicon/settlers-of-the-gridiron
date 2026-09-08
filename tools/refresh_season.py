#!/usr/bin/env python3
"""Build data/season.json for the in-season page.

Pulls FantasyPros rest-of-season PPR ranks, this week's positional ranks (with opponent and
start/sit grade where FantasyPros provides one), and ESPN's public injury report.
Usage: python3 tools/refresh_season.py
"""
import json, re, sys, datetime, zoneinfo, urllib.request, unicodedata
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"}
FP = "https://www.fantasypros.com/nfl/rankings/{}.php"
ESPN_INJ = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
CODES = {"Injured Reserve": "IR", "Out": "O", "Doubtful": "D", "Questionable": "Q", "Suspension": "SUSP"}
FRESH_DAYS = 10

def get(url, headers=UA):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as r:
        return r.read().decode("utf-8", "ignore")

def norm(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    n = re.sub(r"\bd/st\b", "", n)
    return re.sub(r"[^a-z]", "", n)

def ecr(page):
    h = get(FP.format(page))
    m = re.search(r"var ecrData = (\{.*?\});\s*\n", h, re.S)
    if not m:
        sys.exit(f"no ecrData on {page}")
    d = json.loads(m.group(1))
    rows = []
    for p in d.get("players", []):
        rows.append({
            "name": p["player_name"], "n": norm(p["player_name"]),
            "pos": p.get("player_position_id"), "team": p.get("player_team_id"),
            "rank": p.get("rank_ecr"), "tier": p.get("tier"), "bye": int(p["player_bye_week"]) if str(p.get("player_bye_week") or "").isdigit() else None,
            "opp": p.get("player_opponent"), "grade": p.get("start_sit_grade"),
            "posRank": p.get("pos_rank"),
        })
    return d, rows

def injuries():
    d = json.loads(get(ESPN_INJ, headers={}))  # ESPN 403s on a browser UA; plain client works
    cutoff = (datetime.date.today() - datetime.timedelta(days=FRESH_DAYS)).isoformat()
    out = {}
    for team in d.get("injuries", []):
        for row in team.get("injuries", []):
            code = CODES.get(row.get("status"))
            if not code: continue
            date = row.get("date", "")
            if code in ("Q", "D") and date[:10] < cutoff: continue
            a = row.get("athlete", {}); det = row.get("details") or {}
            n = norm(a.get("displayName", ""))
            note = det.get("type") or ""
            rd = (det.get("returnDate") or "")[:10]
            if rd:
                try: note += " · back ~" + datetime.date.fromisoformat(rd).strftime("%-m/%-d")
                except ValueError: pass
            if n not in out or date > out[n]["date"]:
                out[n] = {"code": code, "note": note.strip(" ·"), "date": date}
    return {k: {"code": v["code"], "note": v["note"]} for k, v in out.items()}

def main():
    ros_meta, ros = ecr("ros-ppr-overall")
    if len(ros) < 200: sys.exit("ROS feed too small — refusing")
    weekly = {}
    week = None
    for key, page in (("FLEX", "ppr-flex"), ("QB", "qb"), ("DST", "dst"), ("K", "k")):
        meta, rows = ecr(page)
        weekly[key] = rows
        week = week or meta.get("week")
    if not weekly["FLEX"] or not weekly["QB"]: sys.exit("weekly feeds empty — refusing")
    inj = injuries()
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago"))
    out = {"generated": now.strftime("%Y-%m-%d %-I:%M %p CT"), "week": int(week) if week else None,
           "ros": ros, "weekly": weekly, "injuries": inj}
    (HERE / "data" / "season.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"week {out['week']}: ROS {len(ros)}, weekly FLEX {len(weekly['FLEX'])} QB {len(weekly['QB'])} DST {len(weekly['DST'])} K {len(weekly['K'])}, injuries {len(inj)} -> data/season.json ({out['generated']})")

if __name__ == "__main__":
    main()
