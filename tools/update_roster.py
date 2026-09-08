#!/usr/bin/env python3
"""Apply roster moves to data/rosters.json.
  add:   python3 tools/update_roster.py add "Team" "Player Name" POS NFL
  drop:  python3 tools/update_roster.py drop "Team" "Player Name"
  trade: python3 tools/update_roster.py trade "Team A" "Player" "Team B" "Player"
"""
import json, sys, datetime
from pathlib import Path
p = Path(__file__).resolve().parent.parent / "data" / "rosters.json"
d = json.loads(p.read_text())
def find(team, name):
    for i, x in enumerate(d["teams"][team]):
        if x["name"].lower() == name.lower(): return i
    sys.exit(f"{name} not on {team}")
cmd = sys.argv[1]
if cmd == "add":
    team, name, pos, nfl = sys.argv[2:6]; d["teams"][team].append({"name": name, "pos": pos, "team": nfl})
elif cmd == "drop":
    team, name = sys.argv[2:4]; d["teams"][team].pop(find(team, name))
elif cmd == "trade":
    a, pa, b, pb = sys.argv[2:6]
    xa = d["teams"][a].pop(find(a, pa)); xb = d["teams"][b].pop(find(b, pb))
    d["teams"][a].append(xb); d["teams"][b].append(xa)
else:
    sys.exit(__doc__)
d["updated"] = datetime.date.today().isoformat()
p.write_text(json.dumps(d, indent=1)); print("ok:", cmd)
