#!/usr/bin/env python3
"""Grade every team's draft against the consensus pool and find trade partners.
Usage: python3 tools/league_analysis.py docs/draft-results-2026-09-07.csv --me "I'll be white!!"
"""
import csv, re, sys, argparse
from pathlib import Path
from collections import defaultdict
ap = argparse.ArgumentParser(); ap.add_argument("csv"); ap.add_argument("--me", required=True); a = ap.parse_args()
html = (Path(__file__).resolve().parent.parent / "index.html").read_text()
pool = re.search(r'<textarea id="playerInput"[^>]*>(.*?)</textarea>', html, re.S).group(1)
P = {}
for i, l in enumerate(x for x in pool.split("\n") if x.strip()):
    f = [y.strip() for y in l.split(",")]
    while len(f) < 8: f.append("")
    P[f[0].lower()] = dict(ecr=i+1, pos=f[1], adp=float(f[3]) if f[3] else None, tier=f[4], bye=f[5], inj=f[6], note=f[7])
teams = defaultdict(list)
for r in csv.DictReader(open(a.csv)):
    p = P.get(r["Player"].lower(), dict(ecr=260, pos=r["Position"], adp=None, tier="?", bye="?", inj="", note=""))
    teams[r["Team"]].append(dict(name=r["Player"], overall=int(r["Overall"]), rnd=int(r["Round"]), **p))
SKILL = ("QB","RB","WR","TE")
def starters_value(roster):
    # crude lineup strength: sum of (260-ecr) over best QB1,RB2,WR2,TE1,FLEX1
    by = defaultdict(list)
    for p in roster: by[p["pos"]].append(p)
    for k in by: by[k].sort(key=lambda p: p["ecr"])
    line = by["QB"][:1] + by["RB"][:2] + by["WR"][:2] + by["TE"][:1]
    flexpool = by["RB"][2:] + by["WR"][2:] + by["TE"][1:]
    flexpool.sort(key=lambda p: p["ecr"])
    line += flexpool[:1]
    return sum(260 - p["ecr"] for p in line), line, by
rows = []
for t, roster in teams.items():
    skill = [p for p in roster if p["pos"] in SKILL]
    value = sum(p["overall"] - p["ecr"] for p in skill)  # + = drafted later than consensus (good)
    reaches = sorted(skill, key=lambda p: p["ecr"] - p["overall"], reverse=True)[:2]
    steals = sorted(skill, key=lambda p: p["overall"] - p["ecr"], reverse=True)[:2]
    sv, line, by = starters_value(roster)
    rb = by["RB"]; wr = by["WR"]
    rows.append(dict(team=t, sv=sv, value=value, rb=rb, wr=wr, qb=by["QB"], te=by["TE"], reaches=reaches, steals=steals, roster=roster))
rows.sort(key=lambda r: -r["sv"])
print("LINEUP STRENGTH (starters, consensus-based) & DRAFT VALUE (sum of pick# − consensus rank over skill players; + = value)")
for i, r in enumerate(rows, 1):
    me = " <== YOU" if r["team"] == a.me else ""
    print(f"{i}. {r['team']:<24} strength {r['sv']:4d}  value {r['value']:+4d}  RB:{len(r['rb'])} WR:{len(r['wr'])} QB:{len(r['qb'])} TE:{len(r['te'])}{me}")
    print("     RBs: " + ", ".join(f"{p['name']}(#{p['ecr']})" for p in r["rb"]))
    print("     WRs: " + ", ".join(f"{p['name']}(#{p['ecr']})" for p in r["wr"]))
    print("     steals: " + ", ".join(f"{p['name']} (pick {p['overall']}, rank {p['ecr']})" for p in r["steals"]) +
          " | reaches: " + ", ".join(f"{p['name']} (pick {p['overall']}, rank {p['ecr']})" for p in r["reaches"]))
print("\nINJURED PLAYERS DRAFTED:")
for r in rows:
    for p in r["roster"]:
        if p["inj"] in ("IR","O","SUSP"): print(f"  {r['team']}: {p['name']} {p['inj']} {p['note']}")
print("\nTRADE-PARTNER SCAN (teams with 4+ RBs or a top-40 RB3, and thin/weak WR2-3):")
for r in rows:
    if r["team"] == a.me: continue
    rb3 = r["rb"][2] if len(r["rb"]) > 2 else None
    wr2 = r["wr"][1] if len(r["wr"]) > 1 else None
    wr3 = r["wr"][2] if len(r["wr"]) > 2 else None
    flag = (rb3 and rb3["ecr"] <= 60) or len(r["rb"]) >= 4
    weakwr = (wr2 is None or wr2["ecr"] > 45) or (wr3 is None or wr3["ecr"] > 80)
    if flag:
        print(f"  {r['team']}: RB3 = {rb3['name'] if rb3 else '-'}(#{rb3['ecr'] if rb3 else '-'}), RBs {len(r['rb'])}; WR2 = {wr2['name'] if wr2 else '-'}(#{wr2['ecr'] if wr2 else '-'}), WR3 = {wr3['name'] if wr3 else '-'}(#{wr3['ecr'] if wr3 else '-'}) {'<- WR-needy' if weakwr else ''}")
