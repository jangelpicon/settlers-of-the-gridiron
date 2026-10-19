#!/usr/bin/env python3
"""Scout RB upgrade paths: trade targets (teams with RB surplus + a need Jose can fill) and FA RBs.
Reads data/rosters.json, data/season.json (FP ROS), data/projections.json (ESPN season proj), pulls
week-by-week actuals from ESPN kona_player_info. Read-only; prints a report."""
import json, re, urllib.request, sys, statistics as st
L=882823976; S=2026
SEASON=json.load(open('data/season.json')); ROSTERS=json.load(open('data/rosters.json'))
PROJ=json.load(open('data/projections.json')); POOL=json.load(open('data/espn_pool.json'))
ME=ROSTERS['me']; CUR_WEEK=SEASON['week']
def norm(n): 
    n=re.sub(r"[^a-z]","",n.lower()); return re.sub(r"(iii|ii|jr|sr)$","",n)
ROS={norm(p['name']):p for p in SEASON['ros']}
PJ={norm(p["name"]):p for p in PROJ["players"].values()}
def kona(slot, limit=160):
    f={"players":{"filterSlotIds":{"value":[slot]},"limit":limit,"sortPercOwned":{"sortPriority":1,"sortAsc":False},
       "filterStatsForTopScoringPeriodIds":{"value":CUR_WEEK,"additionalValue":[f"00{S}",f"10{S}"]+[f"01{S}"]}}}
    u=f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{S}/segments/0/leagues/{L}?view=kona_player_info"
    req=urllib.request.Request(u,headers={'Accept':'application/json','x-fantasy-filter':json.dumps(f)})
    return json.load(urllib.request.urlopen(req))['players']
def weekly(p):
    out={}
    for s in p['player'].get('stats',[]):
        if s.get('statSourceId')==0 and s.get('statSplitTypeId')==1 and s.get('seasonId')==S and s.get('scoringPeriodId',0)>=1:  # this season only; ESPN emits no row for a bye week, so ppg never sees a bye zero
            out[s['scoringPeriodId']]=round(s.get('appliedTotal',0),1)
    return out
ACT={}  # norm name -> {week:pts}
INJ={}; OWN={}
for slot in (2,0,4,6):  # RB QB WR TE
    for p in kona(slot, 160 if slot in (2,4) else 80):
        n=norm(p['player']['fullName']); ACT[n]=weekly(p); INJ[n]=p['player'].get('injuryStatus','ACTIVE'); OWN[n]=p['player'].get('ownership',{}).get('percentOwned',0)
def ppg(n, last=None):
    w=ACT.get(n,{}); ks=sorted(w)
    if last: ks=ks[-last:]
    v=[w[k] for k in ks if k<=CUR_WEEK]
    return (round(st.mean(v),1) if v else None, len(v))
def ros_rank(n): r=ROS.get(n); return r['rank'] if r else None
def pos_rank(n): r=ROS.get(n); return r.get('posRank') if r else None
def szn(n): p=PJ.get(n); return p.get('espnSeason') if p else None
def bye(n): r=ROS.get(n); return r.get('bye') if r else None
def card(pl):
    n=norm(pl['name']); m,k=ppg(n); l3,_=ppg(n,3)
    return f"{pl['pos']:3} {pl['name']:24} {pl['team']:4} ROS {str(ros_rank(n) or '-'):>4} {str(pos_rank(n) or ''):5} szn {str(szn(n) or '-'):>6} ppg {str(m or '-'):>5} (L3 {str(l3 or '-'):>5}, n={k}) bye {bye(n) or '-'} {INJ.get(n,'') if INJ.get(n,'ACTIVE')!='ACTIVE' else ''}"
rostered=set()
for t,pl in ROSTERS['teams'].items():
    for p in pl: rostered.add(norm(p['name']))
print(f"=== SCOUT RB — week {CUR_WEEK}, data {PROJ['generated']} ===\n")
print("--- TEAM-BY-TEAM: RB depth, QB situation, WR/TE need ---")
for t,pl in ROSTERS['teams'].items():
    rbs=sorted([p for p in pl if p['pos']=='RB'], key=lambda p: ros_rank(norm(p['name'])) or 999)
    qbs=sorted([p for p in pl if p['pos']=='QB'], key=lambda p: ros_rank(norm(p['name'])) or 999)
    wrs=sorted([p for p in pl if p['pos']=='WR'], key=lambda p: ros_rank(norm(p['name'])) or 999)
    tes=sorted([p for p in pl if p['pos']=='TE'], key=lambda p: ros_rank(norm(p['name'])) or 999)
    startable_rb=[p for p in rbs if (ros_rank(norm(p['name'])) or 999)<=60]
    tag=" <== ME" if t==ME else ""
    print(f"\n[{t}]{tag}  RBs≤ROS60: {len(startable_rb)} | QBs: {len(qbs)} | WRs: {len(wrs)} | TEs: {len(tes)}")
    for p in rbs: print("   ",card(p))
    for p in qbs: print("   ",card(p))
    print("    WR top3:", "; ".join(f"{p['name']} ROS{ros_rank(norm(p['name']))}" for p in wrs[:3]), "| worst starter-ish WR3:", (wrs[2]['name']+" ROS"+str(ros_rank(norm(wrs[2]['name'])))) if len(wrs)>2 else '-')
    print("    TE:", "; ".join(f"{p['name']} ROS{ros_rank(norm(p['name']))}" for p in tes))
print("\n--- FREE-AGENT RBs (ESPN pool, not rostered), by ROS ---")
fa=[]
for key in POOL['players']:
    n=norm(key) if not isinstance(key,dict) else norm(key['name'])
    r=ROS.get(n)
    if r and r['pos']=='RB' and n not in rostered: fa.append(r)
fa.sort(key=lambda r:r['rank'])
for r in fa[:15]: print("   ",card(r), f"own {OWN.get(norm(r['name']),0):.0f}%")
print("\n--- FA RBs by recent form (L3 ppg), ROS-unranked included ---")
form=[]
for n,w in ACT.items():
    if n in rostered: continue
    r=ROS.get(n); pos=(r or {}).get('pos') or (PJ.get(n) or {}).get('pos')
    if pos!='RB': continue
    m,k=ppg(n,3)
    if m and k>=2: form.append((m,n,k))
for m,n,k in sorted(form,reverse=True)[:12]:
    r=ROS.get(n) or {'name':n,'pos':'RB','team':(PJ.get(n) or {}).get('team','?')}
    print("   ",card(r), f"own {OWN.get(n,0):.0f}%")
