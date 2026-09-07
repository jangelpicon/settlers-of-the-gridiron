#!/usr/bin/env python3
"""Merge ESPN injury status into the player pool embedded in index.html.

Adds/updates the optional 7th CSV field (injury code) on every pool line:
  IR   = Injured Reserve     O = Out     D = Doubtful     Q = Questionable
  SUSP = Suspension          (blank = active / no report)
Also stamps the "Injuries refreshed" line in the header. Idempotent — re-run any time.

Usage:  python3 tools/merge_injuries.py            # fetch + merge
        python3 tools/merge_injuries.py --dry-run  # report only
"""
import json, re, sys, urllib.request, datetime, unicodedata, zoneinfo
from pathlib import Path

ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
FRESH_DAYS = 10
CODES = {"Injured Reserve": "IR", "Out": "O", "Doubtful": "D", "Questionable": "Q", "Suspension": "SUSP"}
HERE = Path(__file__).resolve().parent.parent
INDEX = HERE / "index.html"

def norm(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    n = n.lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    n = re.sub(r"[^a-z]", "", n)
    return n

def fetch():
    with urllib.request.urlopen(ESPN, timeout=30) as r:
        d = json.load(r)
    latest = {}  # (normname, pos) -> (date, code, note)
    for team in d.get("injuries", []):
        for row in team.get("injuries", []):
            a = row.get("athlete", {})
            status = row.get("status")
            code = CODES.get(status)
            if not code:
                continue
            key = (norm(a.get("displayName", "")), (a.get("position", {}) or {}).get("abbreviation", ""))
            date = row.get("date", "")
            # Preseason "questionable" tags linger for weeks; only keep soft designations that are recent.
            if code in ("Q", "D") and date[:10] < (datetime.date.today() - datetime.timedelta(days=FRESH_DAYS)).isoformat():
                continue
            det = row.get("details") or {}
            bits = []
            if det.get("type") and det["type"].lower() not in ("not specified", "unknown"):
                bits.append(det["type"])
            rd = det.get("returnDate") or ""
            if rd:
                try:
                    bits.append("back ~" + datetime.date.fromisoformat(rd[:10]).strftime("%-m/%-d"))
                except ValueError:
                    pass
            note = " · ".join(bits).replace(",", " ")[:60]
            if key not in latest or date > latest[key][0]:
                latest[key] = (date, code, note)
    return latest

def main():
    dry = "--dry-run" in sys.argv
    html = INDEX.read_text()
    m = re.search(r'(<textarea id="playerInput"[^>]*>)(.*?)(</textarea>)', html, re.S)
    if not m:
        sys.exit("player pool textarea not found")
    inj = fetch()
    by_name = {}
    for (n, pos), v in inj.items():
        by_name.setdefault(n, []).append((pos, v[1], v[2]))
    lines = m.group(2).split("\n")
    out, hits = [], []
    for line in lines:
        if not line.strip():
            out.append(line); continue
        parts = [p.strip() for p in line.split(",")]
        while len(parts) < 8:
            parts.append("")
        name, pos = parts[0], parts[1].upper()
        code, note = "", ""
        if pos not in ("DST",):
            cands = by_name.get(norm(name), [])
            exact = [c for c in cands if c[0] == pos]
            pick = exact[0] if exact else (cands[0] if cands else None)
            if pick:
                code, note = pick[1], pick[2]
        parts[6], parts[7] = code, note  # cleared automatically when no longer on the report
        if code:
            hits.append(f"{name} ({pos}) -> {code} {note}")
        # trim trailing empties beyond the 6th field so untouched lines stay clean
        while len(parts) > 6 and parts[-1] == "":
            parts.pop()
        out.append(", ".join(parts))
    new_pool = "\n".join(out)
    now = datetime.datetime.now(zoneinfo.ZoneInfo("America/Chicago")).strftime("%Y-%m-%d %-I:%M %p CT")
    html2 = html[:m.start(2)] + new_pool + html[m.end(2):]
    stamp = f'<span id="injStamp">Injuries refreshed: <b>{now}</b> (ESPN)</span>'
    if 'id="injStamp"' in html2:
        html2 = re.sub(r'<span id="injStamp">.*?</span>', stamp, html2, count=1, flags=re.S)
    else:
        html2 = html2.replace("(FantasyPros PPR ECR/ADP/Tier)</div>", "(FantasyPros PPR ECR/ADP/Tier) · " + stamp + "</div>", 1)
    print(f"{len(hits)} flagged of {sum(1 for l in lines if l.strip())} pool players:")
    for h in hits:
        print("  " + h)
    if dry:
        print("(dry run — nothing written)")
    else:
        INDEX.write_text(html2)
        print("index.html updated, stamp:", now)

if __name__ == "__main__":
    main()
