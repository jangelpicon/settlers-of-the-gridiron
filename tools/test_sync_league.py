#!/usr/bin/env python3
"""Fixture test for tools/sync_league.py parsing (no network). Run: python3 tools/test_sync_league.py"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_league as sl

FIX = {"settings": {"name": "I got sheep FF"}, "teams": [
    {"id": 1, "name": "I'll be white!!", "roster": {"entries": [
        {"lineupSlotId": 0, "playerPoolEntry": {"player": {"fullName": "Drake Maye", "defaultPositionId": 1, "proTeamId": 17}}},
        {"lineupSlotId": 16, "playerPoolEntry": {"player": {"fullName": "Vikings D/ST", "defaultPositionId": 16, "proTeamId": 16}}},
        {"lineupSlotId": 21, "playerPoolEntry": {"player": {"fullName": "Hurt Guy", "defaultPositionId": 2, "proTeamId": 8}}},
        {"lineupSlotId": 20, "playerPoolEntry": {"player": {"fullName": "Some Coach", "defaultPositionId": 9, "proTeamId": 8}}}]}},
    {"id": 2, "location": "SACK OF", "nickname": "WHEAT", "roster": {"entries": [
        {"lineupSlotId": 2, "playerPoolEntry": {"player": {"fullName": "Kyren Williams", "defaultPositionId": 2, "proTeamId": 14}}}]}}]}

fails = 0
def ok(c, m):
    global fails
    print(("  ok - " if c else "  FAIL - ") + m); fails += 0 if c else 1

t = sl.parse_league(FIX)
ok(set(t) == {"I'll be white!!", "SACK OF WHEAT"}, "team names parsed from both ESPN shapes (name, location+nickname)")
me = t["I'll be white!!"]
ok([p["name"] for p in me] == ["Drake Maye", "Minnesota Vikings", "Hurt Guy"], "players parsed; D/ST renamed to full team name; non-fantasy positions skipped")
ok(me[0]["pos"] == "QB" and me[0]["team"] == "NE" and me[1]["pos"] == "DST" and me[1]["team"] == "MIN", "position + NFL team mapped from ESPN ids")
ok(me[2].get("ir") is True and not me[0].get("ir"), "IR slot flagged")
ok(t["SACK OF WHEAT"][0]["team"] == "LAR", "LAR mapping")
ok(sl.norm("Vikings D/ST") == sl.norm("Minnesota Vikings D/ST".replace("Minnesota ", "")) and sl.norm("Luther Burden III") == "lutherburden", "name normalisation matches the page's")
SET = {"settings": {"name": "I got sheep FF", "size": 9, "scheduleSettings": {"matchupPeriodCount": 14, "playoffTeamCount": 5,
    "matchupPeriods": {str(i): [i] for i in range(1, 18)}, "playoffMatchupPeriodLength": 1, "playoffMatchupPeriodLengthByRound": {},
    "variablePlayoffMatchupPeriodLength": False, "playoffReseed": False, "playoffSeedingRule": "TOTAL_POINTS_SCORED", "playoffSeedingRuleBy": 0,
    "divisions": [{"id": 0, "name": "League Standings", "size": 9}]}}}
st = sl.parse_settings(SET)
ok(st["regularSeasonWeeks"] == 14 and st["playoffTeamCount"] == 5 and st["playoffRounds"] == 3, "settings: 14-week regular season, 5 playoff teams -> 3 rounds")
ok(st["playoffScoringPeriods"] == [[15], [16], [17]] and st["playoffRoundLengths"] == [1, 1, 1], "settings: playoff weeks = matchup periods after the regular season, 1 week per round")
ok(st["playoffSeedingRule"] == "TOTAL_POINTS_SCORED" and st["playoffReseed"] is False and len(st["divisions"]) == 1, "settings: tiebreaker, reseed flag, divisions carried through")
VAR = json.loads(json.dumps(SET)); VAR["settings"]["scheduleSettings"].update({"playoffTeamCount": 6, "variablePlayoffMatchupPeriodLength": True, "playoffMatchupPeriodLengthByRound": {"3": 2}})
ok(sl.parse_settings(VAR)["playoffRoundLengths"] == [1, 1, 2], "settings: variable-length playoff rounds honoured (two-week final)")
ok(sl.parse_settings({"settings": {"scheduleSettings": {"playoffTeamCount": 4}}}) is None, "settings: missing regular-season length -> None (no guessed format)")
print("ALL SYNC TESTS PASSED" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
