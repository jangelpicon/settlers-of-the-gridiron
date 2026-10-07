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
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "data/settings.json"), "utf8"));
  T.setSettings(settings); // persists across inject(); the simulator runs wherever schedule data is injected
  const txt = s => s.textContent;
  const slotOf = s => s.querySelector(".slot").textContent.trim();

  // ======================= Fallback mode (no projections) =======================
  T.inject(season, rosters, exclusions, tradeLog, null);
  console.log("== Lineup (rank fallback) ==");
  let starters = [...d.querySelectorAll("#tab-lineup .row.start")];
  assert(starters.length === 9, "9 starting slots rendered (QB,RB1,RB2,WR1,WR2,TE,DST,K,FLEX)");
  // Data-driven, not a hardcoded star: names rot with real injuries (Chase went Q/concussion in Wk 5 and is correctly benched).
  const bestWkWR = rosters.teams[rosters.me].map(T.info).filter(p => p.pos === "WR" && !p.onBye && p.wkRank != null && !(p.inj && /^(O|IR|SUSP)$/.test(p.inj.code))).sort((a, b) => a.wkRank - b.wkRank)[0];
  assert(bestWkWR && starters.some(s => /WR1|WR2/.test(slotOf(s)) && rx(bestWkWR.name).test(txt(s))), "my best-ranked available WR this week starts at WR (" + (bestWkWR && bestWkWR.name) + ", wk #" + (bestWkWR && bestWkWR.wkRank) + ")");
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
  const bestMuWR = me.filter(p => p.pos === "WR" && p.mu != null && p.pPlay > 0).sort((a, b) => b.mu - a.mu)[0];
  assert(bestMuWR && starters.some(s => /WR1|WR2/.test(slotOf(s)) && rx(bestMuWR.name).test(txt(s))), "my top-projected WR starts at WR by predicted points (" + (bestMuWR && bestMuWR.name) + ", " + (bestMuWR && bestMuWR.mu) + ")");
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
  const SC = T.weeklyStreamClaims();
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
  assert(/Your drop order/.test(wtxt2) && ((WS.sugg.length || SC.length) ? /Your claim sheet — enter exactly this in ESPN/.test(wtxt2) : /Nothing on the wire is a clear season-long upgrade/.test(wtxt2)), "waiver tab shows the drop order plus the claim sheet (or the empty-wire note when there are no season-long OR weekly K/DST moves)");
  assert(SC.every(s => ["K","DST"].includes(s.pos) && (s.drop == null || s.drop.pos === s.pos)), "weekly stream claims are K/DST only and swap straight for your own (" + SC.map(s => s.pos + ":" + s.add.name).join(", ") + ")");
  assert(!SC.length || (/weekly (K|DST)/.test(wtxt2) && SC.every(s => rx(s.add.name).test(wtxt2))), "weekly K/DST streams appear on the claim sheet, tagged weekly, so the order is never empty when there's a stream to make");
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
  // Click the button for the EXACT deal under test. The tab renders a tiered plan (Tier 1 = biggest need)
  // above the EV-sorted list, so "first button on the page" is not trades[0].
  const btnFor = (t, status) => { const w = [...d.querySelectorAll("#tab-trades .tbtns")].find(x => x.dataset.team === t.team && x.dataset.give === t.giveName && x.dataset.get === t.getName); return w && w.querySelector("button[data-status='" + status + "']"); };
  const second = trades.slice(1).find(t => !(t.team === top.team && t.giveName === top.giveName && t.getName === top.getName) && btnFor(t, "proposed"));
  assert(btnFor(top, "declined") && second, "the #1 deal and a #2 deal both render with tracking buttons");
  btnFor(top, "declined").click();   // decline the #1 offer
  let after = T.findTrades();
  assert(!after.some(x => x.team === top.team && x.getName === top.getName && x.giveName === top.giveName), "a declined offer disappears from the list");
  assert(T.teamFloor(top.team) === top.theirGain + 3, "declining teaches the model: that team's floor rises to (declined their-side + 3)");
  assert(after.filter(x => x.team === top.team).length === trades.filter(x => x.team === top.team).length - 1, "a decline hides only that exact deal — the floor no longer filters out other offers to the team");
  assert(/declined/.test(d.getElementById("tab-trades").textContent) && /Trade log/.test(d.getElementById("tab-trades").textContent), "decline shows up in the trade log");
  assert(new RegExp("\\+" + top.myGain + " / [+-]?" + Math.abs(top.theirGain) + " \\(" + top.odds.label + "\\)").test(d.getElementById("tab-trades").textContent), "trade log row shows the deal's numbers (your gain / their side (odds))");
  d.querySelector("#tab-trades .tb-undo").click();                                 // undo it
  assert(T.findTrades().length === before, "undo restores the list");
  // propose the #1 and #2 offers -> open proposals with stats
  btnFor(top, "proposed").click();
  btnFor(second, "proposed").click();
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
  btnFor(top, "accepted").click();
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
  assert(lt[rosters.me][0].slot === "QB" && lt[rosters.me][1].slot === "DST" && lt[rosters.me][2].slot === "IR" && lt["SACK OF WHEAT"][0].slot === "RB", "live in-browser roster refresh keeps the actual lineup slot — the locked-lineup mirror survives the live overwrite");
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
  assert(/Rank/.test(headers("league")[0].textContent) && /Roster talent \(ROS\)/.test(headers("league")[0].textContent), "league header names rank / this week / roster talent (relabeled from 'Strength' — paper talent, not a ranking)");
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

  console.log("== Championship simulator ==");
  { // own scope: this section reuses short names (mk, calls) used earlier in the file
  // --- strength() unchanged: hand-computed fixture (independent of the weekly data files) ---
  const mk = (name, pos, ros) => ({ name, n: T.norm(name), pos, ros, onBye: false, pPlay: 1, injLive: "ACT", mu: 10, sd: 3 });
  const fxRoster = [mk("Q One","QB",10), mk("R One","RB",20), mk("R Two","RB",30), mk("R Three","RB",40), mk("W One","WR",5), mk("W Two","WR",50), mk("W Three","WR",60), mk("T One","TE",70), mk("K One","K",200), mk("D One","DST",150)];
  // QB10 RB20 RB30 WR5 WR50 TE70 FLEX=RB40 (beats WR60) K200 DST150 → Σ(420 − rank) = 410+400+390+415+370+350+380+220+270
  assert(T.strength(fxRoster) === 3205, "strength() unchanged: hand-computed 9-starter fixture = 3205 (" + T.strength(fxRoster) + ")");
  T.inject(season, rosters, exclusions, tradeLog, projections, null, matchups, histReal);
  const lgRows = [...d.querySelectorAll("#tab-league .gl .row")];
  const talentCol = r => +r.children[8].textContent.trim().split(" ")[0];
  assert(lgRows.length === 9 && lgRows.every(r => { const t = r.children[1].textContent.replace(" 🐑", "").trim(); return talentCol(r) === T.strength(rosters.teams[t].map(T.info)); }), "League tab 'Roster talent (ROS)' column is exactly strength() for every team (relabeled, not recomputed)");

  // --- determinism with the fixed seed ---
  const L1 = T.leagueSim(); const c1 = Object.keys(L1.byTeam).map(t => L1.byTeam[t].champ);
  T.setSettings(settings); // drops the cache → full rebuild
  const L2 = T.leagueSim(); const c2 = Object.keys(L2.byTeam).map(t => L2.byTeam[t].champ);
  assert(L1 !== L2 && c1.every((v, i) => v === c2[i]), "sim determinism: a full rebuild with the fixed seed reproduces every title % exactly");
  const Za = T.simNormals(T.SIM_SEED, 1000), Zb = T.simNormals(T.SIM_SEED, 1000), Zc = T.simNormals(T.SIM_SEED + 1, 1000);
  assert(Za.every((v, i) => v === Zb[i]) && Za.some((v, i) => v !== Zc[i]), "normal draws: same seed → identical stream, different seed → different stream");
  const zm = Za.reduce((a, b) => a + b, 0) / Za.length, zv = Za.reduce((a, b) => a + (b - zm) * (b - zm), 0) / (Za.length - 1);
  assert(Math.abs(zm) < 0.1 && Math.abs(zv - 1) < 0.15, "normal draws are standard normal (mean " + zm.toFixed(3) + ", var " + zv.toFixed(3) + ")");
  const champSum = c2.reduce((a, b) => a + b, 0), poSum = Object.values(L2.byTeam).reduce((a, x) => a + x.playoff, 0);
  assert(Math.abs(champSum - 1) < 1e-9 && Math.abs(poSum - settings.playoffTeamCount) < 1e-9, "every simulated season crowns exactly one champion and seeds exactly " + settings.playoffTeamCount + " playoff teams");
  assert(L2.spec.games.length > 0 && L2.spec.games.every(g => g[2] >= histReal.currentWeek && g[2] <= settings.regularSeasonWeeks), "remaining schedule = undecided weeks " + histReal.currentWeek + "–" + settings.regularSeasonWeeks + " only (" + L2.spec.games.length + " games)");
  const lev = L2.leverage;
  assert(!lev || (lev.champIfWin >= lev.champIfLoss && lev.pWin > 0 && lev.pWin < 1), "this week's leverage: title % if I win ≥ title % if I lose");

  // --- seeding against a known standings fixture: ESPN's own playoffSeed + pointsFor after week 4 ---
  // (frozen from ESPN mTeam 2026-10-06; sat-week scores are NOT in ESPN's points-for — The Brady Bunch
  //  out-seeds ur done on points at 1-2 only if the 77.0 / 119.22 sat-week scores are excluded)
  const FX_ROWS = [{"w":1,"home":"PapasCabezas","away":null,"hp":135.16,"ap":null,"winner":"UNDECIDED"},{"w":1,"home":"Knight Moves Ore Else","away":"ur done","hp":156.92,"ap":128.12,"winner":"HOME"},{"w":1,"home":"Bad Hombres","away":"Resting Blitz Face","hp":121.66,"ap":105.36,"winner":"HOME"},{"w":1,"home":"SACK OF WHEAT","away":"The Brady Bunch","hp":117.3,"ap":148.56,"winner":"AWAY"},{"w":1,"home":"Unnecessary Sanctions","away":"BlitzAndGiggles","hp":132.06,"ap":139.56,"winner":"AWAY"},{"w":2,"home":"ur done","away":null,"hp":119.22,"ap":null,"winner":"UNDECIDED"},{"w":2,"home":"Resting Blitz Face","away":"PapasCabezas","hp":121.04,"ap":142.5,"winner":"AWAY"},{"w":2,"home":"The Brady Bunch","away":"Knight Moves Ore Else","hp":115.02,"ap":141.96,"winner":"AWAY"},{"w":2,"home":"BlitzAndGiggles","away":"Bad Hombres","hp":89.48,"ap":136.58,"winner":"AWAY"},{"w":2,"home":"Unnecessary Sanctions","away":"SACK OF WHEAT","hp":152.32,"ap":110.96,"winner":"HOME"},{"w":3,"home":"Resting Blitz Face","away":null,"hp":139.18,"ap":null,"winner":"UNDECIDED"},{"w":3,"home":"ur done","away":"The Brady Bunch","hp":121.66,"ap":95.6,"winner":"HOME"},{"w":3,"home":"PapasCabezas","away":"BlitzAndGiggles","hp":149.14,"ap":98.44,"winner":"HOME"},{"w":3,"home":"Knight Moves Ore Else","away":"Unnecessary Sanctions","hp":106.26,"ap":142.76,"winner":"AWAY"},{"w":3,"home":"Bad Hombres","away":"SACK OF WHEAT","hp":105.34,"ap":117.04,"winner":"AWAY"},{"w":4,"home":"The Brady Bunch","away":null,"hp":77.0,"ap":null,"winner":"UNDECIDED"},{"w":4,"home":"BlitzAndGiggles","away":"Resting Blitz Face","hp":127.36,"ap":121.72,"winner":"HOME"},{"w":4,"home":"Unnecessary Sanctions","away":"ur done","hp":174.42,"ap":83.18,"winner":"HOME"},{"w":4,"home":"SACK OF WHEAT","away":"PapasCabezas","hp":126.5,"ap":129.38,"winner":"AWAY"},{"w":4,"home":"Bad Hombres","away":"Knight Moves Ore Else","hp":112.48,"ap":155.12,"winner":"AWAY"}];
  const ESPN_W4 = {"PapasCabezas":{seed:1,pf:421.02},"Unnecessary Sanctions":{seed:2,pf:601.56},"Knight Moves Ore Else":{seed:3,pf:560.26},"Bad Hombres":{seed:4,pf:476.06},"BlitzAndGiggles":{seed:5,pf:454.84},"The Brady Bunch":{seed:6,pf:359.18},"ur done":{seed:7,pf:332.96},"SACK OF WHEAT":{seed:8,pf:471.8},"Resting Blitz Face":{seed:9,pf:348.12}};
  T.setHistory({ currentWeek: 5, standings: {}, schedule: FX_ROWS });
  const LF = T.leagueSim();
  assert(LF && LF.spec.teams.every((t, i) => Math.abs(LF.spec.pf0[i] - ESPN_W4[t].pf) < 0.01), "points-for (game weeks only) matches ESPN's pointsFor for all 9 teams");
  const fxOrder = T.simSeedOrder(9, LF.spec.w0, LF.spec.g0, LF.spec.pf0).map(i => LF.spec.teams[i]);
  assert(fxOrder.every((t, k) => ESPN_W4[t].seed === k + 1), "standings → seeds reproduce ESPN's playoffSeed 1–9 exactly (win % first — 3-0 over 3-1 — then points): " + fxOrder.join(" > "));
  assert(LF.spec.games.length === 0 && Object.entries(LF.byTeam).every(([t, x]) => x.playoff === (ESPN_W4[t].seed <= 5 ? 1 : 0)), "no games left → the top-5 seeds make the bracket with certainty, the rest never do");
  T.setHistory(histReal);
  // bracket structure: 5 teams, 3 rounds, no reseed → round 1 is 4v5 only; then 1 v W(4/5), 2 v 3; final
  const calls = []; const score = (t, r) => { calls.push([t, r]); return 100 - t; }; // team index = seed-1 → better seed scores more
  const champ5 = T.simPlayoffs([0, 1, 2, 3, 4], 3, false, score);
  const r0 = calls.filter(c => c[1] === 0).map(c => c[0]).sort(), r1 = calls.filter(c => c[1] === 1).map(c => c[0]).sort(), r2 = calls.filter(c => c[1] === 2).map(c => c[0]).sort();
  assert(champ5 === 0 && JSON.stringify(r0) === "[3,4]" && JSON.stringify(r1) === "[0,1,2,3]" && JSON.stringify(r2) === "[0,1]", "5-team bracket: seeds 1–3 bye, 4v5 in round 1, 1 v W(4/5) + 2v3 in round 2, final in round 3");
  const upset = T.simPlayoffs([0, 1, 2, 3, 4], 3, false, (t, r) => t === 4 ? 999 : 100 - t);
  assert(upset === 4, "the 5 seed can run the table (beats 4, then 1, then the final)");
  assert(JSON.stringify(T.simBracketOrder(3)) === "[1,8,4,5,2,7,3,6]", "standard 8-slot bracket order");
  const rc = []; T.simPlayoffs([0, 1, 2, 3, 4, 5], 3, true, (t, r) => { rc.push([t, r]); return t === 5 ? 999 : 100 - t; });
  const rs1 = rc.filter(c => c[1] === 1).map(c => c[0]);
  assert(rs1.includes(0) && rs1.includes(1) && rs1.includes(5) && rs1.length === 4, "6-team reseeded bracket: 1 and 2 bye, the 6-seed winner is reseeded into round 2 against the 1 seed");

  // --- shrinkage edge cases ---
  // Real between-team spread (A ~150, E ~100) so tau² > 0; B averages 125 with a wild ±35 swing.
  const talent = { A: 3000, B: 3000, C: 3000, D: 3100, E: 2900 };
  const base = { A: [150, 154, 147, 151], B: [100, 160, 90, 150], D: [125, 129, 122, 126], E: [100, 97, 104, 101] };
  assert(T.simScoringModel(base, talent, 0.05).tau2 > 0, "fixture sanity: teams genuinely differ (tau² > 0)");
  const m0 = T.simScoringModel({ ...base, C: [] }, talent, 0.05);
  assert(m0.teams.C.n === 0 && m0.teams.C.w === 0 && Math.abs(m0.teams.C.mu - m0.teams.C.prior) < 1e-9 && m0.teams.C.sigma === m0.sigmaPool, "n=0: rate = talent prior exactly, weight on actual 0, swing = league-pooled");
  assert(Math.abs(m0.teams.C.muSd - Math.sqrt(m0.tau2)) < 1e-9, "n=0: rate uncertainty = full talent-line spread (sqrt tau²)");
  const m1 = T.simScoringModel({ ...base, C: [140] }, talent, 0.05);
  assert(m1.teams.C.n === 1 && m1.teams.C.sigma === m1.sigmaPool && m1.teams.C.w > 0 && m1.teams.C.w < m1.teams.A.w, "n=1: swing = league-pooled (no SD from one score); weight on actual > 0 but below a 4-game team's");
  assert(m1.teams.C.mu > m1.teams.C.prior && m1.teams.C.mu < 140, "n=1: one big week pulls the rate up, but only part way (" + m1.teams.C.prior.toFixed(1) + " → " + m1.teams.C.mu.toFixed(1) + ", not 140)");
  assert(m1.teams.B.sigma > m1.sigmaPool && m1.teams.A.sigma === m1.sigmaPool, "sigma: a wild team keeps its own bigger swing; a steady team is floored at the pooled swing (can't collapse)");
  assert(m1.teams.B.w < m1.teams.A.w, "high-variance team: its average is less informative, so it shrinks harder toward the prior (" + m1.teams.B.w.toFixed(2) + " vs " + m1.teams.A.w.toFixed(2) + ")");
  assert(T.simScoringModel({ A: [120], B: [130] }, { A: 3000, B: 3000 }, 0.05) === null, "every team at n=1 → no week-to-week swing measurable → simulator refuses (null), no guessed variance");
  const flat = T.simScoringModel({ A: [118, 122], B: [121, 119], C: [119, 121] }, { A: 3000, B: 3000, C: 3000 }, 0.05); // identical means
  assert(flat.tau2 === 0 && Object.values(flat.teams).every(x => x.w === 0 && x.muSd === 0), "tau² = 0 (observed spread fully explained by noise) → everyone at the talent line, no rate uncertainty");
  const grow = [1, 2, 4, 8].map(n => T.simScoringModel({ ...base, C: Array(n).fill(0).map((_, i) => 140 + (i % 2 ? 6 : -6)) }, talent, 0.05).teams.C.w);
  assert(grow.every((v, i) => i === 0 || v > grow[i - 1]), "prior weight decays as games pile up: weight on actual " + grow.map(v => v.toFixed(2)).join(" → "));
  const mObs = T.simScoringModel(base, talent, null);
  assert(mObs.slopeSrc === "observed" && mObs.slope >= 0, "no projections → talent→points slope fitted across teams, clamped ≥ 0 (" + mObs.slope.toFixed(4) + ")");

  // --- decisions on title odds ---
  T.inject(season, rosters, exclusions, tradeLog, unlockedProjections, null, matchups, histReal);
  const Ls = T.leagueSim();
  assert(Ls && Ls.model.slopeSrc === "projections" && Ls.model.slope > 0, "talent→points slope calibrated from player projections (" + Ls.model.slope.toFixed(4) + " pts/week per talent point)");
  const dUp = T.simDelta({ [rosters.me]: 40 }), dUp2 = T.simDelta({ [rosters.me]: 80 });
  assert(dUp > 0 && dUp2 > dUp, "more talent for me → higher title odds, monotone (" + (dUp * 100).toFixed(2) + " → " + (dUp2 * 100).toFixed(2) + " pp)");
  const fav = Object.keys(Ls.byTeam).filter(t => t !== rosters.me).sort((a, b) => Ls.byTeam[b].champ - Ls.byTeam[a].champ)[0];
  assert(T.simDelta({ [fav]: 80 }) < 0, "arming the title favourite (" + fav + ") costs me title odds");
  assert(T.simDelta({}) === 0 && T.simDelta({ [rosters.me]: 40 }) === dUp, "no change → 0; repeated deltas are exact (common random numbers, memoized)");
  const fastUp = T.simDeltaFast({ [rosters.me]: 40 });
  assert(fastUp > 0 && Math.abs(fastUp - dUp) < Math.max(0.01, Math.abs(dUp) * 0.5), "fast gradient estimate tracks the exact re-sim (" + (fastUp * 100).toFixed(2) + " vs " + (dUp * 100).toFixed(2) + " pp)");
  const simTrades = T.findTrades();
  assert(simTrades.length > 0 && simTrades.every(t => t.dChamp > 0), "with the simulator on, every listed trade raises my title odds (" + simTrades.length + ")");
  assert(isSorted(simTrades, t => t.ev) && simTrades.every(t => Math.abs(t.ev - t.dChamp * t.odds.p) < 1e-12), "trades ranked by EV = Δ title % × acceptance odds");
  assert(simTrades.slice(0, 40).every(t => t.exact), "every trade near the top was re-simulated exactly (no gradient estimates on screen)");
  const stS = T.tradeStats(simTrades[0].team, simTrades[0].giveName, simTrades[0].getName);
  assert(stS && stS.exact && Math.abs(stS.dChamp - simTrades[0].dChamp) < 1e-12, "tradeStats reproduces the top deal's exact Δ title %");
  assert(simTrades.every(t => t.odds.p === T.acceptOdds(t.theirGain, t.fairness).p), "acceptance odds still read the other side's roster-talent change (how managers judge offers)");
  const trTxt = d.getElementById("tab-trades").textContent;
  assert(/title [+−]\d+\.\d pp/.test(trTxt) && /change in your title odds/.test(trTxt), "Trades tab prices deals in title-odds points");
  const lgTxt = d.getElementById("tab-league").textContent;
  assert(/Title odds — who wins the league/.test(lgTxt) && !/Power ranking/.test(lgTxt) && /Roster talent \(ROS\)/.test(lgTxt), "League headline is title odds; roster talent demoted to a labeled column");
  const lgR = [...d.querySelectorAll("#tab-league .gl .row")].map(r => { const v = x => { const s = x.textContent.trim(); return s.startsWith("<") ? 0.05 : parseFloat(s); }; return { c: v(r.children[2]), p: v(r.children[3]) }; });
  assert(lgR.every((r, i) => i === 0 || r.c < lgR[i - 1].c || (r.c === lgR[i - 1].c && r.p <= lgR[i - 1].p + 1e-9)), "League rows sorted by title %, then playoff %");
  assert(/Roster talent \(ROS\)/.test(d.getElementById("tab-strength").textContent) && !/<b>Overall<\/b>/.test(d.getElementById("tab-strength").innerHTML) && /Title %/.test(d.getElementById("tab-strength").textContent), "Strength tab: 'Overall' relabeled 'Roster talent (ROS)', title % beside it");
  const leg = d.getElementById("legend").textContent;
  assert(/Title %/.test(leg) && /Roster talent \(ROS\)/.test(leg) && /never ranks teams on its own/.test(leg) && !/the power ranking/.test(leg), "glossary defines title %, scoring rate, roster talent (as an input, not a ranking)");
  const ssTxt = d.getElementById("tab-lineup").textContent;
  if (T.simLeverage() != null && T.currentOpponent() && T.currentOpponent().opp) assert(/Title stakes this week/.test(ssTxt) && /swap = title|variance play/.test(ssTxt), "start/sit calls priced in title odds via this week's win odds × leverage");
  const wb = T.waiverBoard().filter(b => b.drop && !["K","DST"].includes(b.fa.pos));
  assert(wb.length && wb.every(b => typeof b.verdict.dChamp === "number"), "waiver board carries a Δ title % on every season-long add/drop");
  T.setSettings(null); T.inject(season, rosters, exclusions, tradeLog, unlockedProjections, null, matchups, histReal);
  assert(/Title odds unavailable — roster talent only/.test(d.getElementById("tab-league").textContent) && T.findTrades().every(t => t.dChamp == null), "no league settings → League tab says so, trades fall back to talent EV (nothing simulated on a guessed format)");
  T.setSettings(settings); T.inject(season, rosters, exclusions, tradeLog, projections, null, matchups, histReal);
  }

  console.log("== Empty roster slot = replacement level, not 0 ==");
  { // Ruling 2026-10-07: Brady Bunch Love→JSN showed +266 "easy yes" because an empty RB slot scored 0.
    // Fixture: strip every QB from one opponent so they have exactly ONE empty positional slot, then pitch them
    // my QBs for each of their players. Old math (strength(), hole = 0) vs trade math (hole = best FA).
    const lab = st => st.odds.label.split(/, | — /)[0];
    // Trade math counts a bye-week player as present (bye ruling below); strength() doesn't. For the old-vs-new
    // comparison, "old math" = strength() on the same present roster, so the only difference is the hole = 0.
    const present = ps => ps.map(p => p.onBye ? { ...p, onBye: false, pPlay: 1 } : p);
    const myQBs = rosters.teams[rosters.me].map(T.info).filter(p => p.pos === "QB" && !/^(O|IR|SUSP)$/.test(p.injLive || "") && !p.onBye && p.ros != null);
    let fx = null;
    for (const t of Object.keys(rosters.teams).filter(t => t !== rosters.me)){
      // Stripped QBs go to another opponent's bench (not the waiver wire) so the replacement is a real FA, not his own QB.
      const r2 = JSON.parse(JSON.stringify(rosters)), park = Object.keys(r2.teams).find(x => x !== rosters.me && x !== t);
      r2.teams[park] = r2.teams[park].concat(r2.teams[t].filter(p => p.pos === "QB")); r2.teams[t] = r2.teams[t].filter(p => p.pos !== "QB");
      // Any OTHER hole this week (a K/DST on bye, an OUT starter) gets plugged with its replacement FA first, so the
      // fixture always isolates exactly one empty slot regardless of the weekly bye/injury calendar.
      T.setRosters(r2);
      T.replFill(T.tradeLineup(T.getRosters().teams[t].map(T.info)).slots).filter(h => h.slot !== "QB" && h.pos).forEach(h => r2.teams[t].push({ name: h.src, pos: h.pos, team: "" }));
      T.setRosters(r2);
      const holes = T.replFill(T.tradeLineup(T.getRosters().teams[t].map(T.info)).slots);
      if (holes.length === 1 && holes[0].slot === "QB"){ fx = { t, r2, hole: holes[0] }; break; }
    }
    assert(fx && myQBs.length, "fixture: an opponent with exactly one empty positional slot (QB stripped" + (fx ? " from " + fx.t + ", replacement " + fx.hole.src + " = " + fx.hole.v : "") + ")");
    if (fx && myQBs.length){
      const them = T.getRosters().teams[fx.t].map(T.info), me = T.getRosters().teams[rosters.me].map(T.info);
      assert(T.tradeTalent(them) === T.strength(present(them)) + fx.hole.v, "trade talent = strength() + the replacement FA's value for the hole; strength() itself still scores the hole 0");
      const repl = T.info({ name: fx.hole.src, pos: "QB", team: "" });
      const pure = [];
      myQBs.forEach(q => them.filter(p => p.ros != null && !["K","DST"].includes(p.pos)).forEach(g => {
        const st = T.tradeStats(fx.t, q.name, g.name); if (!st) return;
        const oldGain = T.strength(present(them.filter(p => p.n !== g.n).concat([q]))) - T.strength(present(them));
        const noHoleGain = T.strength(present(them.concat([repl]).filter(p => p.n !== g.n).concat([q]))) - T.strength(present(them.concat([repl])));
        if (oldGain >= 0 && noHoleGain < 0) pure.push({ q: q.name, g: g.name, oldGain, st });
      }));
      assert(pure.length > 0, "fixture exercises the defect: " + pure.length + " deals were 'easy yes' under hole = 0 but lose value once the hole is filled at replacement (e.g. " + (pure[0] ? pure[0].q + " → " + pure[0].g + " old +" + pure[0].oldGain + ", now " + pure[0].st.theirGain : "-") + ")");
      assert(pure.every(x => lab(x.st) !== "easy yes" && x.st.theirGain < 0), "a team with one empty slot is never labeled 'easy yes' purely on that slot (" + pure.length + " deals: " + [...new Set(pure.map(x => lab(x.st)))].join("/") + ")");
      const big = Math.max(...pure.map(x => x.oldGain)), bigNew = Math.max(...pure.map(x => x.st.theirGain));
      assert(bigNew < 0 && big > 0, "the hole raises need modestly, it doesn't zero the slot (worst old swing +" + big + " → now " + bigNew + ")");
    }
    T.setRosters(rosters);
    assert(Object.keys(rosters.teams).every(t => { const ps = rosters.teams[t].map(T.info); return T.tradeTalent(ps) === T.strength(present(ps)) + T.replFill(T.tradeLineup(ps).slots).reduce((a, r) => a + r.v, 0); }), "live rosters: every team's trade talent = strength() (bye players present) + replacement value of its empty slots");
  }

  console.log("== Bye week: player on bye is rostered and present for trade math ==");
  { // Ruling 2026-10-07: Mahomes on bye made The Brady Bunch read as a permanent empty-QB team and valued him ~0
    // to them, fabricating "easy yes" deals (Maye + Irving → Saquon + Mahomes, +7). Data-driven: every team whose
    // QB is on bye this week; if the calendar has none, a synthetic bye on a real starting QB.
    const byeKey = rosters.teams; let cases = [];
    Object.keys(byeKey).forEach(t => { const ps = byeKey[t].map(T.info); ps.filter(p => p.pos === "QB" && p.onBye && p.ros != null && !/^(O|IR|SUSP)$/.test(p.injLive || "")).forEach(qb => cases.push({ t, ps, qb, synthetic: false })); });
    if (!cases.length){ const t = Object.keys(byeKey).find(x => x !== rosters.me), ps = byeKey[t].map(T.info), qb = T.optimalLineup(ps, "ros").slots.find(s => s.slot === "QB").p;
      cases.push({ t, ps: ps.map(p => p.n === qb.n ? { ...p, onBye: true, pPlay: 0 } : p), qb: { ...qb, onBye: true, pPlay: 0 }, synthetic: true }); }
    assert(cases.length > 0, "fixture: QB(s) on bye this week — " + cases.map(c => c.qb.name + " (" + c.t + (c.synthetic ? ", synthetic" : "") + ")").join(", "));
    cases.forEach(({ t, ps, qb }) => {
      const qbSlot = T.tradeLineup(ps).slots.find(s => s.slot === "QB");
      assert(qbSlot.p && T.replFill(T.tradeLineup(ps).slots).every(h => h.slot !== "QB"), t + ": not flagged as an empty QB slot (" + (qbSlot.p ? qbSlot.p.name : "EMPTY") + " starts in trade math)");
      if (qbSlot.p && qbSlot.p.n === qb.n){ // he's their starter: his value to them = his ROS value over what replaces him
        const without = ps.filter(p => p.n !== qb.n), own = T.tradeTalent(ps) - T.tradeTalent(without), full = 420 - qb.ros;
        const after = T.tradeLineup(without).slots.find(s => s.slot === "QB"), hole = T.replFill(T.tradeLineup(without).slots).find(h => h.slot === "QB");
        const repl = after.p ? 420 - after.p.ros : hole.v, oldOwn = T.strength(ps) - T.strength(without);
        assert(own > 0 && own === full - repl && oldOwn === 0, t + ": " + qb.name + " is not valued near 0 to his own team — worth +" + own + " (ROS " + full + " − replacement " + (after.p ? after.p.name : hole.src) + " " + repl + "); bye-skipping math had him at " + oldOwn);
      } else assert(qbSlot.p && qbSlot.p.ros < qb.ros, t + ": " + qb.name + " is a backup (" + qbSlot.p.name + " starts), so his ~0 marginal value to them is correct, not the bye bug");
      assert(T.strength(ps) === T.strength(ps.filter(p => p.n !== qb.n)) || !qb.onBye, t + ": strength() fence intact — still skips the bye-week QB this week (Roster talent column unchanged)");
    });
  }

  console.log("== Realism guard: never 'easy yes' for stripping a team's only starter at a position ==");
  { // Ruling 2026-10-07: replacement-level fill made deals that take a team's ONLY startable QB/TE look fine for them.
    const lab = st => st.odds.label.split(/, | — /)[0];
    const meP = rosters.teams[rosters.me].map(T.info).filter(p => p.ros != null && !["K","DST"].includes(p.pos) && !/^(O|IR|SUSP)$/.test(p.injLive || ""));
    const strip = [];
    Object.keys(rosters.teams).filter(t => t !== rosters.me).forEach(t => {
      const them = rosters.teams[t].map(T.info);
      ["QB","TE","RB","WR"].forEach(pos => {
        const only = them.filter(p => p.pos === pos && p.ros != null && !/^(O|IR|SUSP)$/.test(p.injLive || ""));
        if (only.length !== 1) return;
        meP.filter(q => q.pos !== pos).forEach(q => { const st = T.tradeStats(t, q.name, only[0].name); if (st) strip.push({ t, pos, q, g: only[0], st }); });
      });
    });
    const tempting = strip.filter(x => x.st.theirGain >= 0);
    assert(tempting.length > 0, "fixture exercises the defect: " + tempting.length + "/" + strip.length + " strip deals score theirGain ≥ 0 (would have been 'easy yes'; e.g. " + (tempting[0] ? tempting[0].q.name + " → " + tempting[0].g.name + " [" + tempting[0].t + "'s only " + tempting[0].pos + "] +" + tempting[0].st.theirGain : "-") + ")");
    assert(strip.length > 0 && strip.every(x => lab(x.st) !== "easy yes" && x.st.strips.includes(x.pos) && x.st.odds.p <= 0.05), "every deal that strips a team's only startable starter is labeled won't-happen, never 'easy yes' (" + strip.length + " deals)");
    const stripKeys = new Set(strip.map(x => x.t + "|" + x.g.n));
    const sugg = T.findTrades();
    assert(sugg.every(d => !d.gets.some(g => stripKeys.has(d.team + "|" + g.n)) || d.gives.some(g => g.pos === d.gets.find(x => stripKeys.has(d.team + "|" + x.n)).pos)) && sugg.every(d => !d.strips.length), "findTrades() never suggests a deal that leaves the other side with no startable player at a position (" + sugg.length + " suggestions checked)");
    assert(T.allSurplusDeals().every(d => !d.st.strips.length), "surplus sell queue never asks for a team's only startable player at a position");
  }

  console.log("== Surplus list + FA replacement pool use the bye fence (rest-of-season lens) ==");
  { // Follow-up 2026-10-07: bye players count as present for the surplus/bench list and the replacement FA pool.
    const meP = rosters.teams[rosters.me].map(T.info);
    const benchN = new Set(T.tradeLineup(meP).bench.map(p => p.n));
    assert(T.findSurplus().every(s => benchN.has(s.p.n)), "surplus candidates come from my bye-present (trade) lineup bench, not the this-week lineup");
    const okFA = p => p.ros != null && !/^(O|IR|SUSP)$/.test(p.injLive || "");
    const fas = T.freeAgents().filter(okFA).sort((a, b) => a.ros - b.ros);
    const pos = ["QB","RB","WR","TE","DST","K"].filter(ps => fas.find(p => p.pos === ps));
    const byeTop = pos.filter(ps => fas.find(p => p.pos === ps).onBye);
    pos.forEach(ps => { const top = fas.find(p => p.pos === ps), h = T.replFill([{ slot: ps, p: null }])[0];
      assert(h.src === top.name, ps + " hole fills with the best FA at the position, bye or not (" + top.name + " #" + top.ros + (top.onBye ? ", on bye" : "") + ")"); });
    const byeFA = fas.find(p => p.onBye);
    assert(!!byeFA, "fixture: free agents on bye this week exist (" + fas.filter(p => p.onBye).length + ", best " + (byeFA ? byeFA.pos + " " + byeFA.name + " #" + byeFA.ros : "-") + ")");
    if (byeFA){ // open exactly enough holes at his position to reach him in rank order: he must be used, not skipped for the bye
      const k = fas.filter(p => p.pos === byeFA.pos && p.ros < byeFA.ros).length + 1;
      const fill = T.replFill(Array.from({ length: k }, () => ({ slot: byeFA.pos, p: null })));
      assert(fill.some(h => h.src === byeFA.name), "a free agent on bye stays in the replacement pool (" + k + " " + byeFA.pos + " holes → " + fill.map(h => h.src).join(", ") + ")");
    }
  }

  console.log("\n--- POWER ---");
  [...d.querySelectorAll("#tab-league .row")].forEach(r => console.log(" ", r.textContent.replace(/\s+/g, " ").trim()));
  console.log(failures ? failures + " FAILED" : "ALL SEASON TESTS PASSED"); process.exit(failures ? 1 : 0);
})().catch(e => { console.error("crash", e); process.exit(1); });
