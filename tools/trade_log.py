#!/usr/bin/env python3
"""Record a trade outcome in data/trades.json (and apply accepted trades to rosters).
  python3 tools/trade_log.py proposed "SACK OF WHEAT" "Bucky Irving" "Kyren Williams"
  python3 tools/trade_log.py declined "SACK OF WHEAT" "Bucky Irving" "Kyren Williams"
  python3 tools/trade_log.py accepted "SACK OF WHEAT" "Bucky Irving" "Kyren Williams"   # also swaps rosters
  python3 tools/trade_log.py countered|withdrawn ...
give = the player Jose gives, get = the player Jose receives."""
import json, sys, datetime, subprocess
from pathlib import Path
root = Path(__file__).resolve().parent.parent
p = root / "data" / "trades.json"
d = json.loads(p.read_text())
status, team, give, get = sys.argv[1:5]
if status not in ("proposed","declined","countered","accepted","withdrawn"): sys.exit(__doc__)
key = f"{team}|{give.lower()}|{get.lower()}"
d["entries"] = [e for e in d["entries"] if e["key"] != key]
d["entries"].append({"key": key, "team": team, "give": give, "get": get, "status": status, "date": datetime.date.today().isoformat()})
p.write_text(json.dumps(d, indent=1))
print("logged:", status, team, give, "->", get)
if status == "accepted":
    me = json.loads((root / "data" / "rosters.json").read_text())["me"]
    subprocess.run([sys.executable, str(root / "tools" / "update_roster.py"), "trade", me, give, team, get], check=True)
