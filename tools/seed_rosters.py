#!/usr/bin/env python3
"""Seed data/rosters.json from a draft-results CSV (one-time). Edit rosters.json by hand
(or via update_roster.py) as trades and waiver moves happen."""
import csv, json, sys
from pathlib import Path
from collections import defaultdict
src = sys.argv[1]; me = sys.argv[2]
teams = defaultdict(list)
for r in csv.DictReader(open(src)):
    teams[r["Team"]].append({"name": r["Player"], "pos": r["Position"], "team": r["NFLTeam"]})
out = {"me": me, "updated": "2026-09-07", "teams": teams}
Path(__file__).resolve().parent.parent.joinpath("data", "rosters.json").write_text(json.dumps(out, indent=1))
print({t: len(v) for t, v in teams.items()})
