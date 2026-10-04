// Headless test for season.html: loads the real page in jsdom with real data/season.json + data/rosters.json
// + data/projections.json (snapshot of the live ESPN/Sleeper/Vegas feeds — no network in the test).
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "season.html"), "utf8");
const season = JSON.parse(fs.readFileSync(path.join(__dirname, "data/season.json"), "utf8"));
const rosters = JSON.parse(fs.readFileSync(path.join(__dirname, "data/rosters.json"), "utf8"));
const exclusions = JSON.parse(fs.readFileSync(path.join(__dirname, "data/exclusions.json"), "utf8"));
const tradeLog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/trades.json"), "utf8"));
const projections = JSON.parse(fs.readFileSync(path.join(__dirname, "data/projections.json"), "utf8"));
// Pre-lock twin of the snapshot: kicks pushed 24h out, games reset to pre, live points wiped.
// The decision tests (start/sit, swaps, close calls) exercise THIS world — those decisions
// vanish by design once games lock. The lock-aware section injects the real snapshot instead.
const unlockedProjections = JSON.parse(JSON.stringify(projections));
Object.values(unlockedProjections.games || {}).forEach(g => { g.kick = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z?$/, "Z"); g.state = "pre"; g.status = ""; g.score = null; });
Object.values(unlockedProjections.players || {}).forEach(p => { if (p && typeof p === "object") p.actual = null; });
let failures = 0;
const assert = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) failures++; };
const rx = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w){ w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 30));
  const w = dom.window, d = w.document, T = w.__seasonTest;
  const txt = s => s.textContent;
  const slotOf = s => s.querySelector(".slot").textContent.trim();

  // ======================= Fallback mode (no projections) =======================
  T.inject(season, rosters, exclusions, tradeLog, null);
  console.log("== Lineup (rank fallback) ==");
  let starters = [...d.querySelectorAll("#tab-lineup .row.start")];
  assert(starters.length === 9, "9 starting slots rendered (QB,RB1,RB2,WR1,WR2,TE,DST,K,FLEX)");
  assert(starters.some(s => /WR1|WR2/.test(txt(s)) && /Ja'Marr Chase/.test(txt(s))), "Chase starts at WR");
  const myQBs = rosters.teams[rosters.me].filter(p => p.pos === "QB").map(p => p.name);
  assert(starters.some(s => slotOf(s) === "QB" && myQBs.some(n => rx(n).test(txt(s)))), "QB slot filled from roster (" + myQBs.join("/") + ")");
  const myDst = rosters.teams[rosters.me].filter(p => p.pos === "DST").map(p => p.name), myK = rosters.teams[rosters.me].filter(p => p.pos === "K").map(p => p.name);
  assert(starters.some(s => slotOf(s) === "DST" && myDst.some(n => rx(n).test(txt(s)))) && starters.some(s => slotOf(s) === "K" && myK.some(n => rx(n).test(txt(s)))), "DST and K slots filled from roster (" + myDst.join("/") + ", " + myK.join("/") + ")");
  assert(starters.every(s => !/BYE/.test(txt(s))), "no bye-week player in the starting lineup");
  assert([...d.querySelectorAll("#tab-lineup .row.sit")].length === 5, "5 bench players");
  const me0 = rosters.teams[rosters.me].map(T.info);
  assert(me0.every(p => p.ros != null), "every rostered player resolves to a rest-of-season rank");
  assert(me0.filter(p => ["QB","RB","WR","TE"].includes(p.pos)).every(p => p.wkRank != null), "every skill player resolves to a Week " + season.week + " rank");
  assert(/consensus ranks/.test(d.getElementById("tab-lineup").textContent), "fallback mode says it is using consensus ranks");

  // ======================= Projection mode (the real thing) =======================
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  console.log("== Projections ==");
  assert(projections.sources.espn >= 200 && projections.sources.sleeper >= 200 && projections.sources.games >= 20, "projection snapshot has all three feeds (espn " + projections.sources.espn + ", sleeper " + projections.sources.sleeper + ", games " + projections.sources.games + ")");
  assert(projections.week === season.week, "projections and rankings are for the same week (" + projections.week + ")");
  const me = rosters.teams[rosters.me].map(T.info);
  assert(me.every(p => typeof p.mu === "number"), "every rostered player gets a predicted-points number");
  assert(me.every(p => p.srcs.length >= 2), "every rostered player has at least two independent sources (ESPN / Sleeper / rank-implied)");
  assert(me.every(p => p.floor <= p.mu + 1e-9 && p.mu <= p.ceil + 1e-9 && p.floor >= 0), "floor ≤ predicted ≤ ceiling, floor never negative");
  assert(me.every(p => p.vegasMult >= 0.85 && p.vegasMult <= 1.15), "Vegas adjustment stays within ±15%");
  assert(me.every(p => typeof p.pPlay === "number" && p.pPlay >= 0 && p.pPlay <= 1), "chance-to-play is a probability for everyone");
  const qs = me.filter(p => p.injLive === "Q");
  assert(qs.every(p => Math.abs(p.mu - Math.round(0.75 * p.ifPlays * 10) / 10) <= 0.11 && p.floor === 0), "Questionable players are discounted to 75% of their if-he-plays number and shown with a zero floor" + (qs.length ? " (" + qs.map(p => p.name).join(", ") + ")" : " (none Q this week)"));
  const fake = T.predict({ name: "Nobody Real", n: "nobodyreal", pos: "WR", team: "CIN", wkRank: 5, inj: null });
  assert(fake.rankPts != null && fake.srcs.length === 1 && fake.mu > 10, "a player missing from both projection feeds still gets a rank-implied number from his consensus rank (" + fake.mu + ")");
  assert(T.rankPts("FLEX", 1) > T.rankPts("FLEX", 40) && T.rankPts("FLEX", 40) > T.rankPts("FLEX", 120), "rank→points curve is monotone (better rank, more points)");
  const outGuy = T.predict({ name: "Out Guy", n: "outguy", pos: "RB", team: "DET", wkRank: 10, inj: { code: "O", note: "knee" } });
  assert(outGuy.pPlay === 0 && outGuy.mu === 0, "an OUT player predicts 0 and is unusable");
  assert(Math.abs(T.pBeats({ mu: 10, sd: 5 }, { mu: 10, sd: 5 }) - 0.5) < 1e-6 && T.pBeats({ mu: 20, sd: 5 }, { mu: 10, sd: 5 }) > 0.9, "head-to-head probability: equal players 50%, big favorite >90%");

  console.log("== Lineup (predicted points) ==");
  starters = [...d.querySelectorAll("#tab-lineup .row.start")];
  assert(starters.length === 9, "9 starting slots rendered in projection mode");
  assert(/predicted points/.test(d.getElementById("tab-lineup").textContent), "lineup says it is using predicted points");
  assert(starters.every(s => s.querySelector(".proj")), "every starter shows a projection number with floor–ceiling");
  const L = T.optimalLineup(me, "mu");
  const startersByEligibility = b => L.slots.filter(s => s.p && (s.slot.replace(/\d$/, "") === b.pos || (s.slot === "FLEX" && ["RB","WR","TE"].includes(b.pos)))).map(s => s.p.mu);
  assert(L.bench.filter(b => b.mu != null && b.pPlay > 0).every(b => Math.min(...startersByEligibility(b)) >= b.mu - 1e-9), "no usable bench player out-projects a starter he could replace (lineup is optimal by predicted points)");
  assert(starters.some(s => /WR1|WR2/.test(txt(s)) && /Ja'Marr Chase/.test(txt(s))), "Chase still starts at WR by predicted points");
  assert(/Start\/sit calls/.test(d.getElementById("tab-lineup").textContent), "start/sit calls panel rendered");
  const calls = [...d.querySelectorAll("#tab-lineup .row")].filter(r => /%/.test(r.textContent) && /over/.test(r.textContent));
  assert(calls.length >= 1, "at least one bench-vs-starter call with a percentage (" + calls.length + ")");
  assert(calls.every(r => { const m = /(\d+)%/.exec(r.textContent); return m && +m[1] >= 0 && +m[1] <= 100; }), "every call shows a 0–100% chance");
  assert(/Projected total for this lineup/.test(d.getElementById("tab-lineup").textContent), "projected lineup total shown");
  assert(/How the prediction works/.test(d.getElementById("tab-lineup").textContent), "plain-language explanation of the model rendered");
  assert(/snapshot/.test(d.getElementById("pstamp").textContent), "header shows which projection data is in use");

  console.log("== Waivers ==");
  const fa = T.freeAgents();
  assert(fa.length > 200, "free-agent pool is large (" + fa.length + ") in a 9-team league");
  const allRostered = new Set(Object.values(rosters.teams).flat().map(p => T.norm(p.name)));
  assert(fa.every(p => !allRostered.has(p.n)), "no rostered player appears as a free agent");
  assert(!fa.some(p => p.n === T.norm("Tetairoa McMillan")), "excluded player (not in ESPN's pool) never appears as a free agent or waiver suggestion");
  assert(!/McMillan/.test(d.getElementById("tab-waivers").textContent), "waiver tab does not mention the excluded player");
  assert(/One-week streamers/.test(d.getElementById("tab-waivers").textContent) && /predicted points/.test(d.getElementById("tab-waivers").textContent), "streamer section rendered, ranked by predicted points");
  console.log("== Waivers: season-long rule ==");
  const WS = T.waiverSuggestions();
  assert(WS.sugg.every(s => s.gain >= T.ROS_MARGIN), "every add/drop suggestion is at least " + T.ROS_MARGIN + " rest-of-season rank spots better (" + WS.sugg.length + " suggestions)");
  assert(WS.sugg.concat(WS.marginal).every(s => s.add.seasonProj == null || s.drop.seasonProj == null || s.add.seasonProj >= s.drop.seasonProj), "no suggestion drops a player with a higher ESPN full-season projection than the add");
  const benchSkill = T.benchSkill().slice().sort((a, b) => (b.ros || 420) - (a.ros || 420));
  const scarceDrop = pos => T.scarcityPool(T.benchSkill(), pos).sort((a, b) => (b.ros || 420) - (a.ros || 420))[0];
  assert(WS.sugg.concat(WS.marginal).every(s => !["K","DST"].includes(s.add.pos) && (s.add.pos === "QB" ? s.drop.pos === "QB" : s.drop.n === scarceDrop(s.add.pos).n)), "suggestions drop your least-valuable spareable bench player (scarcity-aware); a QB suggestion is a straight QB swap; K/DST never suggested");
  assert(WS.sugg.every(s => T.waiverBoard([s.add])[0].verdict.key === "add") && WS.marginal.every(s => T.waiverBoard([s.add])[0].verdict.key === "marginal"), "suggestion box and per-player verdict column agree (one rule)");
  assert(me.every(p => typeof p.seasonProj === "number"), "every rostered player has a live ESPN full-season projection");
  const wtxt = d.getElementById("tab-waivers").textContent;
  assert(/season-long only/.test(wtxt) && /never a reason to drop/.test(wtxt), "waiver tab states the season-long rule in plain language");
  const qbBlock = wtxt.slice(wtxt.indexOf("QB — yours:"), wtxt.indexOf("DST — yours:"));
  assert(qbBlock.length > 0 && !/better than yours this week/.test(qbBlock), "a QB streamer is a rental or a season swap — never a one-week 'better than yours'");
  console.log("== Waivers: who to drop ==");
  const WB = T.waiverBoard();
  const benchRos = T.benchSkill();
  assert(WB.length > 0 && WB.filter(b => !["K","DST","QB"].includes(b.fa.pos)).every(b => b.drop && b.drop.n === scarceDrop(b.fa.pos).n), "every skill free agent names the scarcity-aware drop candidate: least rest-of-season value at a position you can spare");
  const benchCounts = {}; benchRos.forEach(p => benchCounts[p.pos] = (benchCounts[p.pos] || 0) + 1);
  const allSole = benchRos.every(p => benchCounts[p.pos] === 1);
  assert(WB.filter(b => ["RB","WR","TE"].includes(b.fa.pos) && b.drop && b.drop.pos !== b.fa.pos).every(b => benchCounts[b.drop.pos] > 1 || allSole), "a cross-position add never drops your only bench player at a position (scarcity guard)");
  const soleRB = benchRos.filter(p => p.pos === "RB").length === 1 ? benchRos.find(p => p.pos === "RB") : null;
  if (soleRB) assert(WB.filter(b => ["WR","TE"].includes(b.fa.pos)).every(b => !b.drop || b.drop.n !== soleRB.n), "your only bench RB (" + soleRB.name + ") is never the drop for a WR/TE add — but a better RB can still replace him");
  assert(WB.filter(b => b.fa.pos === "QB").every(b => b.drop && b.drop.pos === "QB"), "QB free agents are a straight swap for your QB, never a bench drop");
  assert(WB.filter(b => b.fa.pos === "DST").every(b => b.drop && b.drop.pos === "DST") && WB.filter(b => b.fa.pos === "K").every(b => b.drop && b.drop.pos === "K"), "K/DST free agents are a straight swap for your K/DST");
  assert(WB.every(b => ["add","marginal","pass","rental","none"].includes(b.verdict.key) && b.verdict.text.length > 3), "every free agent has a verdict (add / marginal / pass / rental)");
  assert(WB.filter(b => ["RB","WR","TE"].includes(b.fa.pos)).every(b => (b.verdict.key === "add") === (b.verdict.rosDelta >= T.ROS_MARGIN && (b.verdict.seasonDelta == null || b.verdict.seasonDelta >= 0))), "ADD verdict matches the season-long rule exactly");
  assert(WB.filter(b => b.fa.pos === "QB").every(b => b.verdict.key === (b.verdict.rosDelta >= T.ROS_MARGIN && (b.verdict.seasonDelta == null || b.verdict.seasonDelta >= 0) ? "add" : b.verdict.rosDelta > 0 && (b.verdict.seasonDelta == null || b.verdict.seasonDelta >= 0) ? "marginal" : "rental")), "a QB free agent is a SWAP when he beats your QB season-long, a rental otherwise — the season-long rule applies to QBs too");
  // capability check: hand Jose a weak QB and the tool must recommend swapping in the wire's best QB
  // (no hardcoded name — free agents change as leaguemates make pickups)
  {
    const save = JSON.parse(JSON.stringify(T.getRosters()));
    const weak = JSON.parse(JSON.stringify(save)); weak.teams[weak.me] = weak.teams[weak.me].map(p => p.name === "Drake Maye" ? { name:"Malik Willis", pos:"QB", team:"MIA" } : p);
    T.setRosters(weak);
    const qbAdds = T.waiverBoard().filter(b => b.fa.pos === "QB" && b.verdict.key === "add");
    assert(qbAdds.length >= 1 && qbAdds.every(b => /willis/.test(b.drop.n)), "with a weak QB rostered, the tool recommends the season-long QB swap (best FA QB over Willis: " + (qbAdds[0] ? qbAdds[0].fa.name : "none") + ")");
    assert(T.waiverSuggestions().sugg.some(s => qbAdds.some(b => b.fa.n === s.add.n)), "the QB swap shows up in the suggestion box, not just the table");
    T.setRosters(save);
  }
  console.log("== Waivers: drop order & roster fit ==");
  const DO = T.dropOrder();
  assert(DO.length > 0 && DO.every(p => !["K","DST"].includes(p.pos)), "drop order lists bench skill players only (K/DST swap for their own slot, never drop)");
  assert(DO.every((p, i) => i === 0 || (DO[i-1].ros || 420) >= (p.ros || 420)), "drop order runs least season-long value first");
  assert(WS.sugg.concat(WS.marginal).filter(s => s.add.pos !== "QB").every(s => s.drop.n === scarceDrop(s.add.pos).n), "every claim names the scarcity-aware top of the drop order — the ladder explains multi-add drops");
  const wtxt2 = d.getElementById("tab-waivers").textContent;
  assert(/Your drop order/.test(wtxt2) && (WS.sugg.length ? /Your claim sheet — enter exactly this in ESPN/.test(wtxt2) : /Nothing on the wire is a clear season-long upgrade/.test(wtxt2)), "waiver tab shows the drop order plus the claim sheet (or the empty-wire note when there are no suggestions)");
  {
    let pri = 0;
    const rows = [];
    WS.sugg.slice(0,6).forEach(s => { rows.push([++pri, s.add.name, s.drop.name]); if (s.chain && s.chain.worth) rows.push([++pri, s.add.name, s.chain.drop.name]); });
    assert(rows.every(r => { const m = wtxt2.indexOf("Priority " + r[0]); if (m < 0) return false; const seg = wtxt2.slice(m, wtxt2.indexOf("Priority " + (r[0]+1)) > 0 ? wtxt2.indexOf("Priority " + (r[0]+1)) : m + 400); return rx(r[1]).test(seg) && rx(r[2]).test(seg); }), "claim sheet renders every row as 'Priority N · add X · drop Y' in exact order, backups included (" + rows.map(r => r[0] + ":" + r[1] + "/" + r[2]).join(", ") + ")");
    assert(WS.sugg.every(s => !s.chain || !s.chain.worth || /backup for Priority/.test(wtxt2)), "a worth-it deeper drop becomes its own backup claim row, ESPN-style");
  }
  const meTEbest = me.filter(p => p.pos === "TE").sort((a, b) => (a.ros || 420) - (b.ros || 420))[0];
  assert(meTEbest && T.fitNote({ pos: "TE", ros: (meTEbest.ros || 0) + 5, name: "Backup Te" }, me) != null && T.fitNote({ pos: "WR", ros: 10, name: "Some Wr" }, me) == null, "fit note flags a TE stuck behind your better TE, never a WR");
  const firstFit = WS.sugg.findIndex(s => s.fit), lastClean = WS.sugg.map((s, i) => s.fit ? -1 : i).reduce((a, b) => Math.max(a, b), -1);
  assert(firstFit === -1 || lastClean === -1 || firstFit > lastClean, "bench-clog adds rank below clean adds in the claim ladder");
  console.log("== Waivers: chained claims ==");
  assert(!WS.sugg.length || WS.sugg[0].chain == null, "claim 1 never carries a chained drop — nothing above it can land");
  assert(WS.sugg.every(s => !s.chain || s.chain.drop.n !== s.drop.n), "a chained drop is only shown when it differs from the claim's own drop");
  assert(WS.sugg.every(s => !s.chain || (s.chain.worth === (s.chain.verdict.key === "add"))), "the deeper drop gets its own season-long verdict — worth it only on a real ADD");
  if (WS.sugg.length >= 2 && WS.sugg[0].drop && WS.sugg[0].add.pos !== "QB" && WS.sugg[1].chain){
    const sim = benchRos.filter(p => p.n !== WS.sugg[0].drop.n).concat([WS.sugg[0].add]);
    const expect = T.scarcityPool(sim, WS.sugg[1].add.pos).sort((a, b) => (b.ros || 420) - (a.ros || 420))[0];
    assert(WS.sugg[1].chain.drop.n === expect.n, "when claim 1 lands, claim 2's chained drop is the scarcity-aware next man up (" + expect.name + ")");
  }
  {
    const usedDrops = WS.sugg.map(s => s.chain ? (s.chain.worth ? s.chain.drop.n : null) : (s.drop && s.drop.n)).filter(Boolean);
    assert(new Set(usedDrops).size === usedDrops.length, "in the all-claims-land scenario no player is dropped twice");
  }
  assert(WS.sugg.every(s => !s.chain || s.chain.worth || /isn't worth dropping for him, so this claim just fails/.test(d.getElementById("tab-waivers").textContent)), "a not-worth-it deeper drop gets no backup row and says the claim just fails");
  // fairness: a deal where they hand over the far bigger name craters the accept odds; landing the bigger name raises them
  assert(T.acceptOdds(0, 30).p <= 0.1 && T.acceptOdds(0, 15).p < T.acceptOdds(0, 0).p && T.acceptOdds(-4, -20).p > T.acceptOdds(-4, 0).p, "accept odds fall when the deal looks lopsided against them by consensus rank, rise when they land the bigger name");
  const whdr = [...d.querySelectorAll("#tab-waivers .hrow")];
  const wrows = [...d.querySelectorAll("#tab-waivers .row.grid")];
  assert(whdr.length >= 4 && wrows.length > 0 && wrows.every(r => r.querySelector(".sub") && /Drop for him:/.test(r.querySelector(".sub").textContent) && /Verdict:/.test(r.querySelector(".sub").textContent) && r.querySelector(".sub .tag")), "every waiver row carries a full-width 'Drop for him → Verdict' line (nothing hidden off-screen)");
  assert(wrows.every(r => [...r.children].filter(c => !c.classList.contains("sub") && !c.classList.contains("detail")).length === whdr[0].children.length), "waiver rows have exactly the header's columns plus the drop/verdict line");
  const flagged = WS.sugg.concat(WS.marginal).map(s => s.add.name);
  assert(flagged.every(n => wrows.some(r => rx(n).test(r.textContent))), "every ADD/marginal player is in the free-agent table (" + (flagged.join(", ") || "none this week") + ")");
  const cards = [...d.querySelectorAll("#tab-waivers .suggest")].map(x => x.textContent);
  assert(WS.marginal.every(s => cards.some(c => /Marginal/.test(c) && rx(s.add.name).test(c))), "marginal players get their own card, not a footnote");
  assert(new RegExp(benchSkill[0].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(d.getElementById("tab-waivers").textContent), "the drop candidate's name appears on the waiver tab");
  const faRows = [...d.querySelectorAll("#tab-waivers .row.grid")];
  assert(faRows.length > 0 && faRows.some(r => /^\d+$/.test(r.children[10].textContent.trim())), "free agents show their live season projection in the Season pts column");

  console.log("== Trades ==");
  const trades = T.findTrades();
  assert(trades.length > 0, "at least one win-win trade found (" + trades.length + ")");
  assert(trades.some(t => t.gives.length === 1 && t.gets.length === 1), "list includes 1-for-1 swaps");
  assert(trades.some(t => t.gives.length === 2 && t.gets.length === 2), "list includes 2-for-2 packages");
  assert(trades.every(t => t.myGain > 0 && t.theirGain >= -12), "every suggested trade improves my lineup and has a realistic pitch");
  const isSorted = (arr, key) => arr.every((x, i) => i === 0 || key(arr[i-1]) >= key(x));
  assert(isSorted(trades, t => t.ev), "single list sorted by expected value (my gain × acceptance odds)");
  assert(trades.every(t => Math.abs(t.ev - Math.round(t.myGain * t.odds.p * 10) / 10) < 1e-9), "expected value = my gain × odds");
  assert(!d.getElementById("tradeSort"), "no sort selector — one list only");
  const oddsTags = [...d.querySelectorAll("#tab-trades .suggest .tag")].map(x => x.textContent);
  const oddsLabelRx = /^(looks insulting — they give up the far bigger name|(easy yes|likely|coin flip|long shot)(, but they give the bigger name| — they land the bigger name)?)$/;
  const needTagRx = /fills your biggest need/;
  const surTagRx = /dead weight — can never start for you|surplus — bye\/injury cover only|cover at a need position/;
  const injTagRx = /ROS price predates the injury news/;
  assert(oddsTags.length > 0 && oddsTags.every(x => oddsLabelRx.test(x) || needTagRx.test(x) || surTagRx.test(x) || injTagRx.test(x)), "every trade card carries an acceptance-odds label (incl. fairness variants; need, surplus and injury-reprice tags allowed)");
  assert(oddsTags.some(x => oddsLabelRx.test(x)), "odds labels still present among the tags");
  const needs = T.teamNeeds();
  assert(Array.isArray(needs.needs) && needs.needs.every(n => n.gap > 0 && n.mine && n.lgMedian != null), "teamNeeds reports only real starter gaps (my ROS rank worse than the league-median starter in that slot)");
  assert(/Your needs/.test(d.getElementById("tab-trades").textContent) && /Your needs/.test(d.getElementById("tab-waivers").textContent), "needs banner renders on both the Trades and Waivers tabs");
  assert(trades.some(t => t.gets.some(p => p.pos === "RB")), "suggestions include getting a running back somewhere in the list");
  const top = trades[0];
  const st = T.tradeStats(top.team, top.giveName, top.getName);
  assert(st && st.myGain === top.myGain && st.theirGain === top.theirGain && st.ev === top.ev, "tradeStats reproduces the suggestion's numbers for a named deal");
  assert(T.tradeStats(top.team, "Nobody Real", top.getName) === null, "tradeStats returns null when a player is not on the roster");

  console.log("== Surplus ==");
  const sur = T.findSurplus();
  const meInfo = rosters.teams[rosters.me].map(T.info);
  const optRos = T.optimalLineup(meInfo, "ros");
  assert(sur.every(s => !optRos.used.has(s.p.n)), "no starter is ever listed as surplus (" + sur.map(s => s.p.name).join(", ") + ")");
  const myQBcount = meInfo.filter(p => p.pos === "QB").length;
  if (myQBcount >= 3) {
    assert(sur.some(s => s.p.pos === "QB" && s.dead), "with " + myQBcount + " QBs rostered, a third-string QB is flagged dead weight");
  }
  assert(sur.filter(s => s.dead).every(s => {
    const better = meInfo.filter(q => q.pos === s.p.pos && q.ros != null && q.ros < s.p.ros).length;
    return better >= 2;
  }), "dead weight means at least a starter AND a cover body already rank ahead of him");
  sur.forEach(s => assert(s.buyers.every(b => b.gain > 0), s.p.name + ": every listed buyer genuinely upgrades by starting him" + (s.buyers.length ? " (" + s.buyers.map(b => b.team).join(", ") + ")" : " (no market)")));
  const withBuyers = sur.find(s => s.buyers.length);
  if (withBuyers) {
    const sd = T.surplusDeals(withBuyers, T.teamNeeds());
    assert(sd.every(dl => dl.st.theirGain >= -3), withBuyers.p.name + ": surplus sell offers keep the other side at worst a near-yes (their gain ≥ −3)");
    assert(sd.every(dl => dl.get.pos !== withBuyers.p.pos), "sell offers bring back a different position (cover, not another copy of the surplus)");
    sur.forEach(s => T.surplusDeals(s, T.teamNeeds()).forEach(dl => {
      const better = meInfo.filter(x => x.n !== s.p.n && x.pos === dl.get.pos && x.ros != null && x.ros < dl.get.ros).length;
      const startable = { QB:1, RB:3, WR:3, TE:2 }[dl.get.pos];
      assert(better < startable + 1, s.p.name + " sell: incoming " + dl.get.name + " (" + dl.get.pos + ") would not himself be dead weight here");
    }));
  }
  if (sur.length) {
    assert(/Surplus — bench players who can't help you/.test(d.getElementById("tab-trades").textContent), "surplus panel renders on the Trades tab");
    assert(/dead weight|bye\/injury cover/.test(d.getElementById("tab-trades").textContent), "surplus players carry a dead-weight or cover tag");
    assert(/no team upgrades by starting him|would start for:/.test(d.getElementById("tab-trades").textContent), "each surplus player shows his market (buyers) or says there is none");
  }
  const queue = T.allSurplusDeals();
  const cls = dl => (dl.sp.dead ? 2 : 0) + (dl.need ? 1 : 0);
  assert(queue.every((dl, i) => i === 0 || (cls(queue[i-1]) > cls(dl)) || (cls(queue[i-1]) === cls(dl) && queue[i-1].score >= dl.score)), "sell queue is strictly ordered: dead-weight sells, then need-position cover, then expected return");
  assert(queue.every(dl => dl.score === Math.round((420 - dl.get.ros) * dl.st.odds.p)), "expected return = incoming player's ROS value × acceptance odds");
  const qKeys = queue.map(dl => dl.team + "|" + dl.get.n);
  assert(new Set(qKeys).size === qKeys.length, "same incoming piece never listed twice — cheapest payment wins");
  if (queue.length) {
    assert(/Sell queue — in the order to send them/.test(d.getElementById("tab-trades").textContent), "sell queue renders with explicit ordering");
    assert(/#1 · /.test(d.getElementById("tab-trades").textContent), "queue entries are numbered so the top priority is unambiguous");
    const surBtn = [...d.querySelectorAll("#tab-trades .tbtns")].find(w => w.dataset.give === queue[0].sp.p.name && w.dataset.get === queue[0].get.name);
    assert(!!surBtn, "the #1 sell carries working propose/decline/accept buttons");
  }

  console.log("== Lock-aware lineup ==");
  const mk = (n, pos, slot, locked, mu, extra) => ({ name: n, n: T.norm(n), pos, slot, locked, mu, ros: 50, wkRank: 20, pPlay: 1, injLive: "ACT", srcs: [], ...extra });
  const synth = [
    mk("Hurt Star", "WR", "WR", true, 0, { injLive: "O", pPlay: 0, actual: 5.7, gameState: "live" }),
    mk("Bench Stud", "WR", "BN", true, 19, { actual: 11.4, gameState: "live" }),
    mk("Free Wr", "WR", null, false, 8, {}),
    mk("Free Wr Two", "WR", null, false, 7, {}),
  ];
  const LA = T.lockAwareLineup(synth, "mu");
  assert(LA.slots.find(s => s.slot === "WR1").p && LA.slots.find(s => s.slot === "WR1").p.name === "Hurt Star", "a locked starter who got hurt mid-game STAYS in his ESPN slot — not auto-benched after kickoff");
  assert(!LA.slots.some(s => s.p && s.p.name === "Bench Stud") && LA.bench.some(p => p.name === "Bench Stud"), "a locked bench player is never recommended into the lineup, even when he outscores a starter");
  assert(LA.slots.find(s => s.slot === "WR2").p && LA.slots.find(s => s.slot === "WR2").p.name === "Free Wr", "unlocked players still fill the open slots by predicted points");
  assert(LA.slots.find(s => s.slot === "FLEX").p && LA.slots.find(s => s.slot === "FLEX").p.name === "Free Wr Two", "FLEX still fills from the unlocked pool");
  const noSlots = T.lockAwareLineup(synth.map(p => ({ ...p, slot: null })), "mu");
  assert(noSlots.slots.find(s => s.slot === "WR1").p.name === "Bench Stud", "without ESPN slot data the page falls back to the pure optimizer");
  const meSlots = rosters.teams[rosters.me].filter(p => p.slot && p.slot !== "BN" && p.slot !== "IR");
  assert(meSlots.length === 9, "sync_league.py now records every actual ESPN lineup slot (9 starters found)");
  // The real snapshot (games kicked) drives the locked-mirror render; restored to pre-lock after.
  T.inject(season, rosters, exclusions, tradeLog, projections);
  const anyLocked = rosters.teams[rosters.me].map(T.info).some(p => p.locked);
  if (anyLocked) {
    const lineupTxt = d.getElementById("tab-lineup").textContent;
    assert(/locked players are shown where your ESPN lineup actually has them/.test(lineupTxt), "lineup header explains the locked-mirror mode once games kick");
    rosters.teams[rosters.me].filter(p => p.slot && p.slot !== "BN" && p.slot !== "IR").forEach(p => {
      const ip = T.info(p);
      if (!ip.locked) return;
      assert([...d.querySelectorAll("#tab-lineup .row.start")].some(r => rx(p.name).test(r.textContent)), p.name + " (locked ESPN starter) renders as a starter, matching ESPN");
    });
  }
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections); // back to the pre-lock world

  console.log("== Injuries in trade math ==");
  const hardInj = p => ["IR","O","SUSP"].includes(p.injLive);
  const allSuggested = trades.flatMap(t => t.gives.concat(t.gets)).concat(queue.flatMap(dl => [dl.sp.p, dl.get]));
  assert(allSuggested.every(p => !hardInj(p)), "no OUT/IR/SUSP player (live designation) ever appears on either side of a suggested deal");
  const softIncoming = trades.flatMap(t => t.gets).concat(queue.map(dl => dl.get)).filter(p => p.injLive && p.injLive !== "ACT");
  if (softIncoming.length) {
    assert(injTagRx.test(d.getElementById("tab-trades").textContent), "a Questionable/Doubtful incoming player triggers the stale-ROS-price warning on his card (" + softIncoming.map(p => p.name + " " + p.injLive).join(", ") + ")");
  } else {
    console.log("  ok - (no Q/D incoming players in this snapshot — reprice-warning render untestable today, filter asserted above)");
  }

  console.log("== Trade tracking ==");
  const before = trades.length;
  d.querySelector("#tab-trades .tbtns button[data-status='declined']").click();   // decline the #1 offer
  let after = T.findTrades();
  assert(!after.some(x => x.team === top.team && x.getName === top.getName && x.giveName === top.giveName), "a declined offer disappears from the list");
  assert(T.teamFloor(top.team) === top.theirGain + 3, "declining teaches the model: that team's floor rises to (declined their-side + 3)");
  assert(after.filter(x => x.team === top.team).length === trades.filter(x => x.team === top.team).length - 1, "a decline hides only that exact deal — the floor no longer filters out other offers to the team");
  assert(/declined/.test(d.getElementById("tab-trades").textContent) && /Trade log/.test(d.getElementById("tab-trades").textContent), "decline shows up in the trade log");
  assert(new RegExp("\\+" + top.myGain + " / [+-]?" + Math.abs(top.theirGain) + " \\(" + top.odds.label + "\\)").test(d.getElementById("tab-trades").textContent), "trade log row shows the deal's numbers (your gain / their side (odds))");
  d.querySelector("#tab-trades .tb-undo").click();                                 // undo it
  assert(T.findTrades().length === before, "undo restores the list");
  // propose the #1 and #2 offers -> open proposals with stats
  d.querySelectorAll("#tab-trades .tbtns button[data-status='proposed']")[0].click();
  d.querySelectorAll("#tab-trades .tbtns button[data-status='proposed']")[0].click();
  const openTxt = () => d.getElementById("tab-trades").textContent;
  assert(/Open proposals/.test(openTxt()) && T.getLog().filter(e => e.status === "proposed").length === 2, "proposed offers move to the Open proposals section (2 open)");
  assert(new RegExp("your gain \\+" + top.myGain + " · their side").test(openTxt()) && /EV /.test(openTxt()) && /wk proj/.test(openTxt()), "open proposal shows gain, their side, acceptance odds, EV and this-week projections");
  assert(/waiting 0d/.test(openTxt()), "open proposal shows how long it has been waiting");
  assert(/If everything landed/.test(openTxt()) && /expected acceptances/.test(openTxt()), "open proposals summary line rendered");
  // All declined
  d.getElementById("declineAll").click();
  assert(!/Open proposals/.test(openTxt()) && T.getLog().filter(e => e.status === "proposed").length === 0 && T.getLog().filter(e => e.status === "declined").length === 2, "'All declined' marks every open proposal declined");
  const declinedToTop = T.getLog().filter(e => e.status === "declined" && e.team === top.team && typeof e.theirGain === "number");
  assert(T.teamFloor(top.team) === Math.max(...declinedToTop.map(e => e.theirGain)) + 3, "all-declined raises the floor for the team that said no (max across its declined offers)");
  assert(!T.findTrades().some(x => x.team === top.team && x.getName === top.getName && x.giveName === top.giveName), "declined-by-button offers are gone from the suggestions");
  // reset local log
  while (d.querySelector("#tab-trades .tb-undo")) d.querySelector("#tab-trades .tb-undo").click();
  assert(T.findTrades().length === before, "undo everything restores the list");
  // a decline that came from Sheldon's repo log (no their-side number stored) still raises the floor
  T.inject(season, rosters, exclusions, { entries: [{ team: top.team, give: top.giveName, get: top.getName, status: "declined", date: "2026-09-09" }] }, unlockedProjections);
  assert(T.teamFloor(top.team) === top.theirGain + 3, "a repo-logged decline (from tools/trade_log.py) raises that team's floor too");
  assert(!T.findTrades().some(x => x.team === top.team && x.getName === top.getName && x.giveName === top.giveName), "repo-logged declined offer is not re-suggested");
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  // accept the #1 offer -> rosters swap locally and everything recomputes
  d.querySelector("#tab-trades .tbtns button[data-status='accepted']").click();
  const RR = T.getRosters();
  assert(top.gets.every(g => RR.teams[RR.me].some(p => T.norm(p.name) === g.n)) && top.gives.every(g => !RR.teams[RR.me].some(p => T.norm(p.name) === g.n)), "accepted: I now have the players I got and no longer have the ones I gave");
  assert(top.gives.every(g => RR.teams[top.team].some(p => T.norm(p.name) === g.n)), "accepted: the other team now has my players");
  assert(!T.findTrades().some(x => x.gets.some(p => top.gets.some(q => q.n === p.n))), "accepted trade no longer proposed");
  assert([...d.querySelectorAll("#tab-lineup .row")].some(r => rx(top.get.name).test(r.textContent)), "lineup tab now shows the acquired player");
  while (d.querySelector("#tab-trades .tb-undo")) d.querySelector("#tab-trades .tb-undo").click();
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);

  console.log("== ESPN league roster sync ==");
  const leagueFix = { teams: [
    { id: 1, name: rosters.me, roster: { entries: [
      { lineupSlotId: 0, playerPoolEntry: { player: { fullName: "Drake Maye", defaultPositionId: 1, proTeamId: 17 } } },
      { lineupSlotId: 16, playerPoolEntry: { player: { fullName: "Vikings D/ST", defaultPositionId: 16, proTeamId: 16 } } },
      { lineupSlotId: 21, playerPoolEntry: { player: { fullName: "Hurt Guy", defaultPositionId: 2, proTeamId: 8 } } } ] } },
    { id: 2, location: "SACK OF", nickname: "WHEAT", roster: { entries: [ { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "Kyren Williams", defaultPositionId: 2, proTeamId: 14 } } } ] } } ] };
  const lt = T.rostersFromLeague(leagueFix);
  assert(Object.keys(lt).length === 2 && lt[rosters.me] && lt["SACK OF WHEAT"], "league payload parsed into team rosters (both ESPN team-name shapes)");
  assert(lt[rosters.me].map(p => p.name).join(",") === "Drake Maye,Minnesota Vikings,Hurt Guy" && lt[rosters.me][1].pos === "DST" && lt[rosters.me][1].team === "MIN" && lt[rosters.me][2].ir === true, "players, D/ST full name, NFL team and IR flag come through");
  T.setRosters({ me: rosters.me, updated: "2026-09-09", teams: lt, live: true });
  assert([...d.querySelectorAll("#tab-lineup .row")].some(r => /Drake Maye/.test(r.textContent)) && [...d.querySelectorAll("#tab-league .row")].length === 2, "page re-renders from live ESPN rosters");
  // pool restriction: inject a two-man pool (one rostered, one genuine FA) — only the FA may come through.
  // Names are picked at test time so leaguemates' pickups can't rot this fixture.
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  const poolFA = T.freeAgents()[0];
  const poolRostered = rosters.teams[rosters.me].find(p => !["DST","K"].includes(p.pos));
  T.inject(season, rosters, exclusions, tradeLog, projections, { players: [T.norm(poolRostered.name), poolFA.n] });
  const faPool = T.freeAgents();
  assert(faPool.length === 1 && faPool[0].n === poolFA.n, "with an ESPN league pool synced, only players in that pool count as free agents (rostered " + poolRostered.name + " filtered, FA " + poolFA.name + " kept)");
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  console.log("== Column headers ==");
  const headers = tab => [...d.querySelectorAll("#tab-" + tab + " .hrow")];
  assert(headers("lineup").length >= 3 && headers("waivers").length >= 4 && headers("trades").length >= 0 && headers("byes").length === 1 && headers("league").length === 1, "every tab's list has a header row (lineup " + headers("lineup").length + ", waivers " + headers("waivers").length + ", byes 1, league 1)");
  const h0 = headers("lineup")[0].textContent;
  assert(/Slot/.test(h0) && /Proj/.test(h0) && /Floor–Ceil/.test(h0) && /Opp/.test(h0) && /Status/.test(h0) && !/Wk rank/.test(h0) && !/ROS rank/.test(h0) && !/Season pts/.test(h0), "lineup header keeps only the decision columns: " + h0.replace(/\s+/g, " ").trim());
  const hw = headers("waivers")[0].textContent;
  assert(/Wk rank/.test(hw) && /ROS rank/.test(hw) && /Season pts/.test(hw), "waiver header keeps the season-long columns: " + hw.replace(/\s+/g, " ").trim());
  assert(headers("lineup")[0].children.length === d.querySelector("#tab-lineup .row.grid.start").querySelectorAll(":scope > *:not(.detail)").length, "player rows have exactly as many cells as the header");
  assert(/Odds/.test(d.getElementById("tab-lineup").textContent) && headers("lineup").some(x => /Verdict/.test(x.textContent)), "start/sit table has its own header (Odds … Verdict)");
  assert(/Rank/.test(headers("league")[0].textContent) && /Strength/.test(headers("league")[0].textContent), "league header names rank / this week / strength");
  assert(/Coverage/.test(headers("byes")[0].textContent), "byes header names coverage");
  assert(d.getElementById("legend") && /What the columns mean/.test(d.getElementById("legend").textContent) && d.querySelectorAll("#legend dt").length >= 12, "plain-language legend explains every column");
  d.querySelector("#tab-trades .tbtns button[data-status='declined']").click();
  assert(headers("trades").some(x => /Outcome/.test(x.textContent) && /Your gain/.test(x.textContent)), "trade log has a header once it has entries");
  while (d.querySelector("#tab-trades .tb-undo")) d.querySelector("#tab-trades .tb-undo").click();
  console.log("== Byes / League ==");
  assert([...d.querySelectorAll("#tab-byes .row")].length >= 5, "bye map has rows");
  assert([...d.querySelectorAll("#tab-league .row")].length === 9, "power ranking lists all 9 teams");
  assert([...d.querySelectorAll("#tab-league .row")].every(r => /^\d+\.\d$/.test(r.children[2].textContent.trim())), "power ranking shows each team's projected points this week in its own column");

  // ======================= Printouts for the weekly Discord report =======================
  console.log("\n--- OPTIMAL TRADES ---");
  { const seen = new Set();
    T.findTrades().filter(t => { const k = t.team + "|" + t.get.n; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8).forEach((t, i) =>
      console.log(`${i+1}. ${t.team}: give ${t.give.name} (${t.give.pos} ROS#${t.give.ros}) for ${t.get.name} (${t.get.pos} ROS#${t.get.ros}) | me +${t.myGain} them ${t.theirGain >= 0 ? "+" : ""}${t.theirGain} [${t.odds.label}] EV ${t.ev}`)); }
  console.log("\n--- OPEN PROPOSALS (repo log) ---");
  tradeLog.entries.filter(e => e.status === "proposed").forEach(e => { const s = T.tradeStats(e.team, e.give, e.get); console.log(`  ${e.team}: give ${e.give} for ${e.get} (sent ${e.date})` + (s ? ` | me +${s.myGain} them ${s.theirGain >= 0 ? "+" : ""}${s.theirGain} [${s.odds.label}] EV ${s.ev}` : " | stats n/a")); });
  if (!tradeLog.entries.some(e => e.status === "proposed")) console.log("  (none)");
  console.log("\n--- WAIVER SUGGESTIONS ---");
  console.log(d.getElementById("tab-waivers").textContent.replace(/\s+/g, " ").slice(0, 900));
  console.log("\n--- LINEUP (predicted points: proj floor–ceil | sources) ---");
  console.log("  projections: " + projections.generated);
  L.slots.forEach(s => { const p = s.p; console.log(`  ${s.slot.padEnd(4)} ${p ? `${p.name} (${p.pos} ${p.liveTeam}) ${p.mu.toFixed(1)} [${p.floor.toFixed(0)}–${p.ceil.toFixed(0)}] | ${p.srcs.map(x => x.k + " " + x.v.toFixed(1)).join(", ")} | Vegas ×${p.vegasMult.toFixed(2)}${p.injLive !== "ACT" ? " | " + p.injLive + " " + Math.round(p.pPlay*100) + "% to play" : ""}${p.game ? " | " + (p.game.home ? "vs " : "at ") + p.game.opp + " " + p.game.status : ""}` : "— empty —"}`); });
  console.log("  BENCH:");
  L.bench.forEach(p => console.log(`       ${p.name} (${p.pos}) ${p.mu != null ? p.mu.toFixed(1) + " [" + p.floor.toFixed(0) + "–" + p.ceil.toFixed(0) + "]" : "n/a"}${p.injLive !== "ACT" ? " | " + p.injLive + " " + Math.round(p.pPlay*100) + "%" : ""}`));
  // ======================= WR1-out alert =======================
  {
    const pjO = JSON.parse(JSON.stringify(projections));
    Object.values(pjO.players).forEach(q => { if (q.name === "A.J. Brown") { q.injE = "O"; q.injS = "O"; } });
    T.inject(season, rosters, exclusions, tradeLog, pjO);
    const lu = d.getElementById("tab-lineup").textContent;
    assert(/Drake Maye alert/.test(lu) && /A\.J\. Brown/.test(lu) && /rest-of-season rank reprices slowly/.test(lu), "when the QB's No.1 receiver is OUT, the Lineup tab shows the alert naming both players");
    const pjH = JSON.parse(JSON.stringify(projections));
    Object.values(pjH.players).forEach(q => { if (q.name === "A.J. Brown") { q.injE = "ACT"; q.injS = "ACT"; delete q.injNote; } });
    T.inject(season, rosters, exclusions, tradeLog, pjH);
    assert(!/Drake Maye alert/.test(d.getElementById("tab-lineup").textContent), "no WR1 alert when the receiver is healthy");
    T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  }

  console.log("== Plug-and-play ?team= link ==");
  {
    T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
    T.setTeamParam("?team=sack+of+wheat");
    assert(d.getElementById("teamTitle").textContent === "SACK OF WHEAT", "?team=sack+of+wheat repoints the whole page (case/punctuation-insensitive match)");
    const sackNames = new Set(rosters.teams["SACK OF WHEAT"].map(p => T.norm(p.name)));
    const lu = [...d.querySelectorAll("#tab-lineup .row.start")];
    assert(lu.length === 9 && T.getRosters().me === "SACK OF WHEAT", "their view renders a full 9-slot lineup as 'me'");
    assert(T.benchSkill().every(p => sackNames.has(p.n)), "waiver drop candidates come from THEIR bench, not Jose's");
    T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
    T.setTeamParam("?team=nobody+real");
    assert(T.getRosters().me === rosters.me && /not found/.test(d.getElementById("teamTitle").textContent) && /SACK OF WHEAT/.test(d.getElementById("teamTitle").textContent), "unknown team name: keeps the default view and lists the league's team names");
    T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
    T.setTeamParam("?nothing=here");
    assert(T.getRosters().me === rosters.me, "no ?team= param: Jose's view, unchanged");
  }

  // ======================= Matchup engine (opponent-adjusted form) =======================
  console.log("== Matchup engine ==");
  const matchups = JSON.parse(fs.readFileSync(path.join(__dirname, "data/matchups.json"), "utf8"));
  assert(Object.keys(matchups.defVsPos).length >= 30, "defense-vs-position table covers the league (" + Object.keys(matchups.defVsPos).length + " defenses)");
  assert(["QB","RB","WR","TE","K","DST"].every(pos => matchups.leagueAvg[pos] > 0), "league average present for all six positions");
  assert(matchups.defVsPos.DET && matchups.defVsPos.DET.QB && matchups.defVsPos.DET.QB.avg > matchups.leagueAvg.QB * 1.3, "sanity anchor: Detroit is a far-above-average QB matchup (" + (matchups.defVsPos.DET ? matchups.defVsPos.DET.QB.avg : "?") + " vs lg " + matchups.leagueAvg.QB + ")");
  // graceful degrade: no matchups file = consensus-only, no matchup fields, no errors
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections);
  const anyQB = rosters.teams[rosters.me].filter(p => p.pos === "QB").map(p => T.info(p));
  assert(anyQB.length > 0 && anyQB.every(p => p.matchup == null && p.mu != null), "without matchups.json every projection still computes, consensus-only");
  const consensusMu = {}; anyQB.forEach(p => consensusMu[p.n] = p.mu);
  // synthetic fixture: opponent allows exactly 2x what he faced -> matchup view doubles his average, half weight
  const fxP = anyQB[0], fxTeam = w.__seasonTest.norm ? null : null;
  const fxOpp = (projections.games[fxP.liveTeam] || {}).opp;
  if (fxOpp) {
    const fx = { generated: "fixture", weeksSampled: [1,2,3], leagueAvg: { QB: 20 }, outlook: {},
      defVsPos: { [fxOpp]: { QB: { avg: 20, games: 3 } } },
      playerForm: { [fxP.n]: { pos: "QB", team: fxP.liveTeam, n: 3, actAvg: 10, facedAvg: 10 } } };
    T.inject(season, rosters, exclusions, tradeLog, projections, null, fx);
    const p = T.info({ name: fxP.name, pos: "QB", team: fxP.team });
    assert(p.matchup && Math.abs(p.matchup.proj - 16) < 0.01 && Math.abs(p.matchup.w - 0.5) < 0.01, "fixture: raw 2x ratio hard-caps at 1.6x -> matchup view 10 x 1.6 = " + (p.matchup ? p.matchup.proj : "?") + ", 3 games = 50% weight");
    const want = (0.5 * p.base + 0.5 * 16) * p.vegasMult * (p.injLive === "Q" ? 0.95 : 1);
    assert(Math.abs(p.ifPlays - want) < 0.15, "fixture: blended projection = (1-w)*consensus + w*capped matchup, then Vegas (" + p.ifPlays + " vs expected " + want.toFixed(1) + ")");
  } else assert(false, "fixture skipped — no game found for " + fxP.name);
  // real data: form-adjusted projections move away from consensus and the page renders the outlook
  T.inject(season, rosters, exclusions, tradeLog, projections, null, matchups);
  const withMu = rosters.teams[rosters.me].filter(p => p.pos === "QB").map(p => T.info(p));
  assert(withMu.some(p => p.matchup != null), "real matchups.json attaches matchup data to rostered QBs");
  assert(withMu.some(p => Math.abs(p.mu - consensusMu[p.n]) > 0.05), "matchup blend actually moves projections off the pure consensus");
  assert(!/next 4/.test(d.getElementById("tab-lineup").textContent), "lineup tab no longer carries the next-4 strip (waivers-only)");
  assert(/next 4/.test(d.getElementById("tab-waivers").textContent), "waiver rows render the next-4 opponent outlook");
  assert(/matchup/.test(d.getElementById("legend").textContent), "legend explains the matchup view");
  // fitted weights: the matchup view's vote is measured by walk-forward backtest, not hand-picked
  const predlog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/predlog.json"), "utf8"));
  assert(predlog.rows.length > 500, "prediction log holds a real backtest sample (" + predlog.rows.length + " scored player-weeks)");
  assert(predlog.rows.every(r => r.w >= 2 && r.actual != null && r.cons != null && r.mview != null), "every log row is a scored week-2+ prediction pair (walk-forward, no week-1 hindsight)");
  assert(matchups.fittedW && Object.keys(matchups.fittedW).length >= 4, "fitted weights present for most positions");
  assert(Object.values(matchups.fittedW).every(v => v.use >= 0 && v.use <= 0.8 && v.mseFit <= v.mseCons + 0.01), "every fitted weight is sane and never scores worse than consensus-only on the backtest");
  const qbW = matchups.fittedW.QB;
  const fittedQB = withMu.find(p => p.matchup && p.matchup.fitted);
  if (qbW && fittedQB) assert(Math.abs(fittedQB.matchup.w - Math.min(qbW.use, fittedQB.matchup.n/(fittedQB.matchup.n+3))) < 0.011, "predict() applies the fitted QB weight (" + fittedQB.matchup.w + " vs fitted " + qbW.use + ")");
  const love = withMu.find(p => /Jordan Love/.test(p.name)), maye = withMu.find(p => /Drake Maye/.test(p.name));
  if (love && maye) console.log("  info - QB board under fitted weights: Love " + love.mu + " vs Maye " + maye.mu + " (measured weights decide, not narrative)");
  // regression (Saints D/ST 9/30): tiny-sample D/ST ratios exploded (6.9x -> proj 15 vs ESPN 3).
  // Every matchup multiplier must respect the cap, and no projection may exceed 1.6x its consensus.
  const everyone = Object.values(T.getRosters().teams).flat().map(T.info).concat(T.freeAgents());
  const withRatio = everyone.filter(p => p.matchup && p.matchup.ratio != null);
  assert(withRatio.length > 50, "matchup ratios computed across the league (" + withRatio.length + " players)");
  assert(withRatio.every(p => p.matchup.ratio >= 0.5 && p.matchup.ratio <= 1.6), "every matchup multiplier within the 0.5x-1.6x cap");
  assert(withRatio.every(p => { const a = p.matchup.actAvg * 0.5, b = p.matchup.actAvg * 1.6; return p.matchup.proj >= Math.min(a,b) - 0.06 && p.matchup.proj <= Math.max(a,b) + 0.06; }), "matchup view stays within 0.5x-1.6x of the player's own production (negative producers included)");
  const saints = T.info({ name: "New Orleans Saints", pos: "DST", team: "NO" });
  if (saints.matchup) assert(saints.mu < 9, "Saints D/ST regression: capped blend stays sane (" + saints.mu + ", was 15.2 uncapped vs ESPN 3.3)");
  else console.log("  ok - Saints D/ST regression skipped (no matchup row this week)");

  console.log("\n--- START/SIT CALLS (chance bench player outscores the starter he'd replace) ---");
  [...d.querySelectorAll("#tab-lineup .row")].filter(r => /%/.test(r.textContent) && /over/.test(r.textContent)).forEach(r => console.log("  " + r.textContent.replace(/\s+/g, " ").trim()));
  const iw = [...d.querySelectorAll("#tab-lineup .suggest")].map(x => x.textContent.replace(/\s+/g, " ").trim()).filter(x => /Injury watch/.test(x));
  if (iw.length) console.log("  " + iw.join("\n  "));
  // ======================= Matchup tab (head-to-head + season trends) =======================
  console.log("== Matchup tab ==");
  // graceful degrade: no history file -> tab explains itself, nothing crashes
  T.inject(season, rosters, exclusions, tradeLog, projections, null, null, null);
  assert(/No league schedule data yet/.test(d.getElementById("tab-matchup").textContent), "without schedule data the Matchup tab says so instead of crashing");
  // ESPN payload parsing: normalises names, scores, and flips a bye row so the team that plays goes first
  const histFix = T.historyFromLeague({ status: { currentMatchupPeriod: 2 },
    teams: [ { id: 1, name: "Alpha" }, { id: 2, location: "Beta", nickname: "Boys" } ],
    schedule: [ { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 101.5 }, away: { teamId: 2, totalPoints: 99 }, winner: "HOME" },
                { matchupPeriodId: 2, home: {}, away: { teamId: 2, totalPoints: 50 }, winner: "UNDECIDED" } ] });
  assert(histFix.currentWeek === 2 && histFix.schedule.length === 2 && histFix.schedule[0].home === "Alpha" && histFix.schedule[0].away === "Beta Boys" && histFix.schedule[0].hp === 101.5, "historyFromLeague parses both ESPN team-name shapes with scores");
  assert(histFix.schedule[1].home === "Beta Boys" && histFix.schedule[1].away === null && histFix.schedule[1].hp === 50, "a row where only the away team plays is flipped so the playing team comes first (9-team bye shape)");
  // synthetic fixture with hand-checkable numbers (real team names so lineups resolve)
  const ME = rosters.me, OPP = "Unnecessary Sanctions", T2 = "SACK OF WHEAT", T3 = "PapasCabezas";
  const hx = { currentWeek: 3, standings: {}, schedule: [
    { w: 1, home: ME, away: OPP, hp: 130, ap: 90, winner: "HOME" },
    { w: 1, home: T2, away: T3, hp: 80, ap: 70, winner: "HOME" },
    { w: 2, home: ME, away: null, hp: 110, ap: null, winner: "UNDECIDED" },
    { w: 2, home: OPP, away: T2, hp: 120, ap: 60, winner: "HOME" },
    { w: 3, home: OPP, away: ME, hp: 0, ap: 0, winner: "UNDECIDED" } ] };
  T.inject(season, rosters, exclusions, tradeLog, projections, null, null, hx);
  const ts = T.teamSeason(ME);
  assert(ts.wins === 1 && ts.losses === 0 && ts.rows.length === 2 && ts.rows[1].res === "BYE", "fixture: 1-0 record with the no-matchup week counted as 'sat', not a loss");
  assert(ts.avg === 120 && ts.high === 130 && ts.low === 110 && ts.pf === 240 && ts.pa === 90, "fixture: avg/high/low/PF/PA computed from both scored weeks (bye score included, PA only from real games)");
  assert(ts.allPlay.w === 4 && ts.allPlay.l === 1, "fixture: all-play 4-1 (wk1 beat all three scores, wk2 beat one of two)");
  assert(ts.expWins === 0.8, "fixture: all-play says the scores deserved 0.8 wins over 1 game");
  const co = T.currentOpponent();
  assert(co && co.week === 3 && co.opp === OPP && co.home === false, "fixture: current opponent detected (week 3, at " + OPP + ")");
  assert(T.scoringRank(ME).rank === 1, "fixture: top average score ranks 1st");
  let mtxt = d.getElementById("tab-matchup").textContent;
  assert(new RegExp("Week 3 — at " + OPP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(mtxt), "matchup header names the week and opponent (away game)");
  assert(/win odds/.test(mtxt) && /%/.test(mtxt), "win odds rendered from both projected totals");
  const mrows = [...d.querySelectorAll("#tab-matchup .gm .row.grid")];
  assert(mrows.length === 9, "head-to-head compares all 9 slots");
  const edges = mrows.map(r => r.querySelector(".tag")).filter(Boolean).map(x => parseInt(x.textContent));
  assert(edges.length >= 7 && edges.every(v => v >= 0 && v <= 100), "per-slot edge percentages are probabilities (" + edges.length + " slots with both players)");
  assert(/Season so far/.test(mtxt) && /all-play/.test(mtxt) && /1–0/.test(mtxt), "season story shows the record and all-play line");
  assert(/Head-to-head this season/.test(mtxt) && /Week 1/.test(mtxt), "past meeting with this opponent listed");
  assert(/sat/.test(mtxt) && /odd team out/.test(mtxt), "the no-matchup week renders as 'sat' with a plain-language note");
  // my-bye current week: no opponent -> explains the 9-team odd-team-out, no head-to-head
  const hxBye = { currentWeek: 3, standings: {}, schedule: hx.schedule.slice(0, 4).concat([{ w: 3, home: ME, away: null, hp: 0, ap: null, winner: "UNDECIDED" }]) };
  T.setHistory(hxBye);
  assert(/odd team out this fantasy week|the odd team out/.test(d.getElementById("tab-matchup").textContent), "when I sit this week the tab says so instead of showing a ghost opponent");
  // real file: records derived from the schedule must match ESPN's own standings for every team
  const histReal = JSON.parse(fs.readFileSync(path.join(__dirname, "data/league_history.json"), "utf8"));
  T.inject(season, rosters, exclusions, tradeLog, projections, null, matchups, histReal);
  const standTeams = Object.keys(histReal.standings);
  assert(standTeams.length === 9 && standTeams.every(t => { const s = T.teamSeason(t); return s.wins === histReal.standings[t].wins && s.losses === histReal.standings[t].losses; }), "real data: schedule-derived W-L matches ESPN's standings for all 9 teams");
  const coReal = T.currentOpponent();
  assert(coReal && (coReal.opp == null || rosters.teams[coReal.opp]), "real data: current opponent is a known roster (or a bye)");
  assert([...d.querySelectorAll("#tab-matchup .gh .row.grid")].length >= 4, "real data: week-by-week history rows render for both teams");
  assert(/Win odds \(matchup\)/.test(d.getElementById("legend").textContent) && /All-play/.test(d.getElementById("legend").textContent), "legend explains win odds, all-play and luck");
  console.log("\n--- MATCHUP (week " + (histReal.currentWeek || "?") + ") ---");
  console.log(d.getElementById("tab-matchup").textContent.replace(/\s+/g, " ").slice(0, 700));
  T.inject(season, rosters, exclusions, tradeLog, projections, null, matchups, histReal);

  console.log("== Strength tab ==");
  const stTab = d.getElementById("tab-strength");
  assert(/League rank \(1 = strongest\)/.test(stTab.textContent), "rank grid renders (per-position + overall)");
  assert(/Position strength by team/.test(stTab.textContent) && !/Position strength by team/.test(d.getElementById("tab-trades").textContent), "position bars live on the Strength tab, not Trades");
  const stSvgs = [...stTab.querySelectorAll("svg")];
  assert(stSvgs.length === 2 && stSvgs.every(s => s.querySelectorAll("path").length === 9), "both timeseries charts render one line per team");
  assert(stSvgs.every(s => s.querySelectorAll("title").length >= 18), "every chart point carries a hover tooltip (team · week · points)");
  assert(/everyone else/.test(stTab.textContent), "legend explains the gray context lines");
  assert(/Total/.test(stTab.textContent), "scores table view renders beside the charts");

  console.log("\n--- POWER ---");
  [...d.querySelectorAll("#tab-league .row")].forEach(r => console.log(" ", r.textContent.replace(/\s+/g, " ").trim()));
  console.log(failures ? failures + " FAILED" : "ALL SEASON TESTS PASSED"); process.exit(failures ? 1 : 0);
})().catch(e => { console.error("crash", e); process.exit(1); });
