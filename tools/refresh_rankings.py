#!/usr/bin/env python3
"""Refresh the player pool embedded in index.html from FantasyPros (PPR).

Sources (both public pages, parsed from their embedded JSON):
  ECR / Tier / Bye : https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php  (var ecrData)
  ADP              : ESPN public player feed (leaguedefaults/3?view=kona_player_info), PPR sort —
                     the same ADP the ESPN draft room shows, which is where this league drafts.
Joined on normalized player name + position (DST by team nickname). Writes the top N (default 250) as
  Name, POS, Team, ADP, Tier, Bye[, Injury, Injury note]
preserving any existing injury fields by player name (run tools/merge_injuries.py
afterwards to bring those up to date). Stamps "Rankings refreshed" in the header.

Usage:  python3 tools/refresh_rankings.py            # fetch + write
        python3 tools/refresh_rankings.py --dry-run  # report movement only
        python3 tools/refresh_rankings.py --top 300
"""
import json, re, sys, urllib.request, datetime, zoneinfo
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"}
ECR_URL = "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"
ADP_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info"
ADP_FILTER = '{"players":{"limit":400,"sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"}}}'
ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
INDEX = Path(__file__).resolve().parent.parent / "index.html"

def get(url, extra=None):
    hdrs = dict(UA); hdrs.update(extra or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=hdrs), timeout=45) as r:
        return r.read().decode("utf-8", "ignore")

def norm(name):
    import unicodedata
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    return re.sub(r"[^a-z]", "", n)

def adp_key(name, pos):
    if pos == "DST":
        nick = re.sub(r"\s*d/st$", "", name, flags=re.I).strip().split()[-1]
        return ("dst", nick.lower())
    return (pos, norm(name))

def fetch_ecr():
    h = get(ECR_URL)
    m = re.search(r"var ecrData = (\{.*?\});\s*\n", h, re.S)
    if not m:
        sys.exit("ecrData not found on cheat sheet page (layout changed?)")
    players = json.loads(m.group(1))["players"]
    if len(players) < 200:
        sys.exit(f"only {len(players)} players in ecrData — refusing to clobber the pool")
    return players

def fetch_adp():
    d = json.loads(get(ADP_URL, {"x-fantasy-filter": ADP_FILTER, "Accept": "application/json"}))
    out = {}
    for row in d.get("players", []):
        pl = row.get("player") or {}
        pos = ESPN_POS.get(pl.get("defaultPositionId"))
        adp = (pl.get("ownership") or {}).get("averageDraftPosition")
        if not pos or adp is None or not pl.get("fullName"):
            continue
        out[adp_key(pl["fullName"], pos)] = round(float(adp), 1)
    if len(out) < 100:
        sys.exit(f"only {len(out)} ESPN ADP rows — refusing to proceed")
    return out

def main():
    dry = "--dry-run" in sys.argv
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 250
    html = INDEX.read_text()
    m = re.search(r'(<textarea id="playerInput"[^>]*>)(.*?)(</textarea>)', html, re.S)
    if not m:
        sys.exit("player pool textarea not found")
    old_lines = [l for l in m.group(2).split("\n") if l.strip()]
    old = {}
    for i, l in enumerate(old_lines):
        p = [x.strip() for x in l.split(",")]
        old[p[0]] = {"rank": i + 1, "adp": p[3] if len(p) > 3 else "", "inj": p[6:8] if len(p) > 6 else []}
    ecr = sorted(fetch_ecr(), key=lambda p: p["rank_ecr"])[:top]
    adp = fetch_adp()
    out, moves, missing_adp = [], [], 0
    for i, p in enumerate(ecr):
        name = p["player_name"].strip()
        pos = p["player_position_id"]
        team = p.get("player_team_id") or ""
        a = adp.get(adp_key(name, pos))
        if a is None:
            missing_adp += 1
        tier = p.get("tier")
        bye = p.get("player_bye_week") or ""
        fields = [name, pos, team, "" if a is None else str(a), "" if tier is None else str(tier), str(bye)]
        inj = old.get(name, {}).get("inj", [])
        if inj and inj[0]:
            fields += inj
        out.append(", ".join(fields))
        o = old.get(name)
        if o is None:
            moves.append(f"  NEW  #{i+1} {name} ({pos})")
        elif abs(o["rank"] - (i + 1)) >= 5:
            moves.append(f"  {o['rank']:>3} -> {i+1:<3} {name} ({pos})")
    dropped = [n for n in old if n not in {p["player_name"].strip() for p in ecr}]
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago")).strftime("%Y-%m-%d %-I:%M %p CDT")
    print(f"{len(out)} players written, {missing_adp} without ADP, {len(dropped)} dropped out of top {top}, {len(moves)} moved 5+ spots or new:")
    print("\n".join(moves[:60]) or "  (no movement)")
    if dropped:
        print("  dropped:", ", ".join(dropped[:20]))
    if dry:
        print("(dry run — nothing written)"); return
    html2 = html[:m.start(2)] + "\n".join(out) + html[m.end(2):]
    html2, n = re.subn(r"Rankings refreshed: <b>[^<]*</b>", f"Rankings refreshed: <b>{now}</b>", html2, count=1)
    INDEX.write_text(html2)
    print("index.html updated, stamp:", now if n else "(stamp not found)")

if __name__ == "__main__":
    main()
