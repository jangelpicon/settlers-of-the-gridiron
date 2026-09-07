#!/usr/bin/env python3
"""Monte Carlo pre-draft plan for a snake draft, from the pool in index.html.

Opponents draft by ESPN ADP with noise (pick ~ Normal(adp, 1.5 + 0.13*adp)), skipping
IR/OUT/SUSP players and K/DST until the last 2 rounds. "Me" takes best-available ECR
(healthy, no K/DST) at each of my picks so later rounds reflect my own removals.
Reports, for each of my picks, the probability each nearby player is still on the board.

Usage: python3 tools/draft_plan.py --slot 4 --teams 9 --rounds 14 [--sims 3000]
"""
import re, sys, random, argparse
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--slot", type=int, required=True)   # 1-based draft slot
ap.add_argument("--teams", type=int, default=9)
ap.add_argument("--rounds", type=int, default=14)
ap.add_argument("--sims", type=int, default=3000)
ap.add_argument("--show", type=int, default=8)       # players listed per pick
ap.add_argument("--seed", type=int, default=7)
a = ap.parse_args()
random.seed(a.seed)

html = (Path(__file__).resolve().parent.parent / "index.html").read_text()
pool = re.search(r'<textarea id="playerInput"[^>]*>(.*?)</textarea>', html, re.S).group(1)
players = []
for i, line in enumerate(l for l in pool.split("\n") if l.strip()):
    f = [x.strip() for x in line.split(",")]
    while len(f) < 8: f.append("")
    adp = float(f[3]) if f[3] else 400.0
    players.append({"i": i, "name": f[0], "pos": f[1], "team": f[2], "adp": adp, "tier": f[4], "inj": f[6], "note": f[7]})
N = len(players)
undraftable = {p["i"] for p in players if p["inj"] in ("IR", "O", "SUSP")}
late = {p["i"] for p in players if p["pos"] in ("K", "DST")}

def team_for(overall):
    r = (overall - 1) // a.teams
    pos = (overall - 1) % a.teams
    return pos if r % 2 == 0 else a.teams - 1 - pos

my_idx = a.slot - 1
total = a.teams * a.rounds
my_picks = [o for o in range(1, total + 1) if team_for(o) == my_idx]
avail_count = {o: [0] * N for o in my_picks}
my_choice = {o: {} for o in my_picks}

for _ in range(a.sims):
    # each opponent draws a noisy "value" per player once per sim: lower = earlier
    noisy = [p["adp"] + random.gauss(0, 1.5 + 0.13 * p["adp"]) for p in players]
    order = sorted(range(N), key=lambda i: noisy[i])
    taken = [False] * N
    for o in range(1, total + 1):
        rnd = (o - 1) // a.teams + 1
        allow_late = rnd > a.rounds - 2
        if team_for(o) == my_idx:
            for i in range(N):
                if not taken[i]: avail_count[o][i] += 1
            for p in players:  # my pick: best ECR, healthy, no K/DST before late rounds
                i = p["i"]
                if taken[i] or i in undraftable or (i in late and not allow_late): continue
                taken[i] = True; my_choice[o][i] = my_choice[o].get(i, 0) + 1; break
        else:
            for i in order:
                if taken[i] or i in undraftable or (i in late and not allow_late): continue
                taken[i] = True; break

def label(p):
    inj = f" [{p['inj']}{' ' + p['note'] if p['note'] else ''}]" if p["inj"] else ""
    return f"{p['name']} ({p['pos']} T{p['tier']} ADP {p['adp']:g}){inj}"

print(f"Slot {a.slot} of {a.teams}, {a.rounds} rounds, {a.sims} sims. My picks: {', '.join('#'+str(o) for o in my_picks)}\n")
for o in my_picks[:8]:
    rnd = (o - 1) // a.teams + 1
    probs = [(avail_count[o][i] / a.sims, players[i]) for i in range(N) if i not in undraftable and i not in late]
    # candidates: best-ECR players with >=15% availability, plus the realistic top
    cands = [(pr, p) for pr, p in probs if pr >= 0.15][: a.show]
    print(f"Round {rnd} — pick #{o}")
    for pr, p in cands:
        print(f"   {int(pr*100):3d}%  {label(p)}")
    top_my = sorted(my_choice[o].items(), key=lambda kv: -kv[1])[:3]
    print("   most likely BPA for you: " + ", ".join(f"{players[i]['name']} {int(c/a.sims*100)}%" for i, c in top_my))
    print()
