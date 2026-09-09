// Headless test for season.html: loads the real page in jsdom with real data/season.json + data/rosters.json
// + data/projections.json (snapshot of the live ESPN/Sleeper/Vegas feeds — no network in the test).
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "season.html"), "utf8");
const season = JSON.parse(fs.readFileSync(path.join(__dirname, "data/season.json"), "utf8"));
const rosters = JSON.parse(fs.readFileSync(path.join(__dirname, "data/rosters.json"), "utf8"));
const exclusions = JSON.parse(fs.readFileSync(path.join(__dirname, "data/exclusions.json"), "utf8"));
const tradeLog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/trades.json"), "utf8"));
const projections = JSON.parse(fs.readFileSync(path.join(__dirname, "data/projections.json"), "utf8"));
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
  assert(starters.some(s => /^\s*QB/.test(txt(s)) && /Drake Maye/.test(txt(s))), "Maye starts at QB");
  const myDst = rosters.teams[rosters.me].filter(p => p.pos === "DST").map(p => p.name), myK = rosters.teams[rosters.me].filter(p => p.pos === "K").map(p => p.name);
  assert(starters.some(s => slotOf(s) === "DST" && myDst.some(n => rx(n).test(txt(s)))) && starters.some(s => slotOf(s) === "K" && myK.some(n => rx(n).test(txt(s)))), "DST and K slots filled from roster (" + myDst.join("/") + ", " + myK.join("/") + ")");
  assert(starters.every(s => !/BYE/.test(txt(s))), "no bye-week player in the starting lineup");
  assert([...d.querySelectorAll("#tab-lineup .row.sit")].length === 5, "5 bench players");
  const me0 = rosters.teams[rosters.me].map(T.info);
  assert(me0.every(p => p.ros != null), "every rostered player resolves to a rest-of-season rank");
  assert(me0.filter(p => ["QB","RB","WR","TE"].includes(p.pos)).every(p => p.wkRank != null), "every skill player resolves to a Week " + season.week + " rank");
  assert(/consensus ranks/.test(d.getElementById("tab-lineup").textContent), "fallback mode says it is using consensus ranks");

  // ======================= Projection mode (the real thing) =======================
  T.inject(season, rosters, exclusions, tradeLog, projections);
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
  const benchSkill = T.optimalLineup(me, "ros").bench.filter(p => !["K","DST"].includes(p.pos)).sort((a, b) => (b.ros || 420) - (a.ros || 420));
  assert(WS.sugg.concat(WS.marginal).every(s => !["K","DST","QB"].includes(s.add.pos) && s.drop.n === benchSkill[0].n), "add/drop suggestions drop your least-valuable bench player (" + benchSkill[0].name + ") and never touch K/DST/QB");
  assert(WS.sugg.every(s => T.waiverBoard([s.add])[0].verdict.key === "add") && WS.marginal.every(s => T.waiverBoard([s.add])[0].verdict.key === "marginal"), "suggestion box and per-player verdict column agree (one rule)");
  assert(me.every(p => typeof p.seasonProj === "number"), "every rostered player has a live ESPN full-season projection");
  const wtxt = d.getElementById("tab-waivers").textContent;
  assert(/season-long only/.test(wtxt) && /never a reason to drop/.test(wtxt), "waiver tab states the season-long rule in plain language");
  assert(/1-wk rental/.test(wtxt) || !/Jared Goff/.test(wtxt), "a QB streamer who out-projects Maye this week is labelled a 1-week rental, not an upgrade");
  const qbBlock = wtxt.slice(wtxt.indexOf("QB — yours:"), wtxt.indexOf("DST — yours:"));
  assert(qbBlock.length > 0 && !/better than yours this week/.test(qbBlock), "'better than yours this week' is never shown for a QB streamer while Jose has a healthy QB");
  console.log("== Waivers: who to drop ==");
  const WB = T.waiverBoard();
  const benchRos = T.optimalLineup(me, "ros").bench.filter(p => !["K","DST"].includes(p.pos));
  const worstBench = benchRos.slice().sort((a, b) => (b.ros || 420) - (a.ros || 420))[0];
  assert(WB.length > 0 && WB.filter(b => !["K","DST"].includes(b.fa.pos)).every(b => b.drop && b.drop.n === worstBench.n), "every skill free agent names the same drop candidate: the bench player with the least rest-of-season value (" + worstBench.name + ")");
  assert(WB.filter(b => b.fa.pos === "DST").every(b => b.drop && b.drop.pos === "DST") && WB.filter(b => b.fa.pos === "K").every(b => b.drop && b.drop.pos === "K"), "K/DST free agents are a straight swap for your K/DST");
  assert(WB.every(b => ["add","marginal","pass","rental","none"].includes(b.verdict.key) && b.verdict.text.length > 3), "every free agent has a verdict (add / marginal / pass / rental)");
  assert(WB.filter(b => ["RB","WR","TE"].includes(b.fa.pos)).every(b => (b.verdict.key === "add") === (b.verdict.rosDelta >= T.ROS_MARGIN && (b.verdict.seasonDelta == null || b.verdict.seasonDelta >= 0))), "ADD verdict matches the season-long rule exactly");
  assert(WB.filter(b => b.fa.pos === "QB").every(b => b.verdict.key === "rental"), "QB free agents are always labelled 1-week rentals");
  const whdr = [...d.querySelectorAll("#tab-waivers .hrow")];
  const wrows = [...d.querySelectorAll("#tab-waivers .row.grid")];
  assert(whdr.length >= 4 && wrows.length > 0 && wrows.every(r => r.querySelector(".sub") && /Drop for him:/.test(r.querySelector(".sub").textContent) && /Verdict:/.test(r.querySelector(".sub").textContent) && r.querySelector(".sub .tag")), "every waiver row carries a full-width 'Drop for him → Verdict' line (nothing hidden off-screen)");
  assert(wrows.every(r => [...r.children].filter(c => !c.classList.contains("sub") && !c.classList.contains("detail")).length === whdr[0].children.length), "waiver rows have exactly the header's columns plus the drop/verdict line");
  const flagged = WS.sugg.concat(WS.marginal).map(s => s.add.name);
  assert(flagged.every(n => wrows.some(r => rx(n).test(r.textContent))), "every ADD/marginal player is in the free-agent table (" + (flagged.join(", ") || "none this week") + ")");
  const cards = [...d.querySelectorAll("#tab-waivers .suggest")].map(x => x.textContent);
  assert(WS.marginal.every(s => cards.some(c => /Marginal/.test(c) && rx(s.add.name).test(c))), "marginal players get their own card, not a footnote");
  assert(new RegExp(worstBench.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(d.getElementById("tab-waivers").textContent), "the drop candidate's name appears on the waiver tab");
  const faRows = [...d.querySelectorAll("#tab-waivers .row.grid")];
  assert(faRows.length > 0 && faRows.some(r => /^\d+$/.test(r.children[10].textContent.trim())), "free agents show their live season projection in the Season pts column");

  console.log("== Trades ==");
  const trades = T.findTrades();
  assert(trades.length > 0, "at least one win-win 1-for-1 trade found (" + trades.length + ")");
  assert(trades.every(t => t.myGain > 0 && t.theirGain >= -12), "every suggested trade improves my lineup and has a realistic pitch");
  const isSorted = (arr, key) => arr.every((x, i) => i === 0 || key(arr[i-1]) >= key(x));
  assert(isSorted(trades, t => t.ev), "single list sorted by expected value (my gain × acceptance odds)");
  assert(trades.every(t => Math.abs(t.ev - Math.round(t.myGain * t.odds.p * 10) / 10) < 1e-9), "expected value = my gain × odds");
  assert(!d.getElementById("tradeSort"), "no sort selector — one list only");
  const oddsTags = [...d.querySelectorAll("#tab-trades .suggest .tag")].map(x => x.textContent);
  assert(oddsTags.length > 0 && oddsTags.every(x => ["easy yes","likely","coin flip","long shot"].includes(x)), "every trade card carries an acceptance-odds label");
  assert(trades.slice(0, 8).some(t => t.get.pos === "RB"), "top suggestions include getting a running back");
  const top = trades[0];
  const st = T.tradeStats(top.team, top.give.name, top.get.name);
  assert(st && st.myGain === top.myGain && st.theirGain === top.theirGain && st.ev === top.ev, "tradeStats reproduces the suggestion's numbers for a named deal");
  assert(T.tradeStats(top.team, "Nobody Real", top.get.name) === null, "tradeStats returns null when a player is not on the roster");

  console.log("== Trade tracking ==");
  const before = trades.length;
  d.querySelector("#tab-trades .tbtns button[data-status='declined']").click();   // decline the #1 offer
  let after = T.findTrades();
  assert(!after.some(x => x.team === top.team && x.get.n === top.get.n && x.give.n === top.give.n), "a declined offer disappears from the list");
  assert(T.teamFloor(top.team) === top.theirGain + 3, "declining teaches the model: that team's floor rises to (declined their-side + 3)");
  assert(after.filter(x => x.team === top.team).every(x => x.theirGain >= top.theirGain + 3), "remaining offers to that team are all sweeter for them than the declined one");
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
  assert(T.teamFloor(top.team) === top.theirGain + 3, "all-declined raises the floor for the team that said no");
  assert(!T.findTrades().some(x => x.team === top.team && x.get.n === top.get.n && x.give.n === top.give.n), "declined-by-button offers are gone from the suggestions");
  // reset local log
  while (d.querySelector("#tab-trades .tb-undo")) d.querySelector("#tab-trades .tb-undo").click();
  assert(T.findTrades().length === before, "undo everything restores the list");
  // a decline that came from Sheldon's repo log (no their-side number stored) still raises the floor
  T.inject(season, rosters, exclusions, { entries: [{ team: top.team, give: top.give.name, get: top.get.name, status: "declined", date: "2026-09-09" }] }, projections);
  assert(T.teamFloor(top.team) === top.theirGain + 3, "a repo-logged decline (from tools/trade_log.py) raises that team's floor too");
  assert(!T.findTrades().some(x => x.team === top.team && x.get.n === top.get.n && x.give.n === top.give.n), "repo-logged declined offer is not re-suggested");
  T.inject(season, rosters, exclusions, tradeLog, projections);
  // accept the #1 offer -> rosters swap locally and everything recomputes
  d.querySelector("#tab-trades .tbtns button[data-status='accepted']").click();
  const RR = T.getRosters();
  assert(RR.teams[RR.me].some(p => T.norm(p.name) === top.get.n) && !RR.teams[RR.me].some(p => T.norm(p.name) === top.give.n), "accepted: I now have the player I got and no longer have the one I gave");
  assert(RR.teams[top.team].some(p => T.norm(p.name) === top.give.n), "accepted: the other team now has my player");
  assert(!T.findTrades().some(x => x.get.n === top.get.n), "accepted trade no longer proposed");
  assert([...d.querySelectorAll("#tab-lineup .row")].some(r => rx(top.get.name).test(r.textContent)), "lineup tab now shows the acquired player");
  while (d.querySelector("#tab-trades .tb-undo")) d.querySelector("#tab-trades .tb-undo").click();
  T.inject(season, rosters, exclusions, tradeLog, projections);

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
  T.inject(season, rosters, exclusions, tradeLog, projections, { players: ["jaredgoff"] });
  const faPool = T.freeAgents();
  assert(faPool.length === 1 && faPool[0].n === "jaredgoff", "with an ESPN league pool synced, only players in that pool count as free agents");
  T.inject(season, rosters, exclusions, tradeLog, projections);
  console.log("== Column headers ==");
  const headers = tab => [...d.querySelectorAll("#tab-" + tab + " .hrow")];
  assert(headers("lineup").length >= 3 && headers("waivers").length >= 4 && headers("trades").length >= 0 && headers("byes").length === 1 && headers("league").length === 1, "every tab's list has a header row (lineup " + headers("lineup").length + ", waivers " + headers("waivers").length + ", byes 1, league 1)");
  const h0 = headers("lineup")[0].textContent;
  assert(/Slot/.test(h0) && /Proj/.test(h0) && /Floor–Ceil/.test(h0) && /Wk rank/.test(h0) && /ROS rank/.test(h0) && /Season pts/.test(h0) && /Status/.test(h0), "player header names every column: " + h0.replace(/\s+/g, " ").trim());
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
  console.log("\n--- START/SIT CALLS (chance bench player outscores the starter he'd replace) ---");
  [...d.querySelectorAll("#tab-lineup .row")].filter(r => /%/.test(r.textContent) && /over/.test(r.textContent)).forEach(r => console.log("  " + r.textContent.replace(/\s+/g, " ").trim()));
  const iw = [...d.querySelectorAll("#tab-lineup .suggest")].map(x => x.textContent.replace(/\s+/g, " ").trim()).filter(x => /Injury watch/.test(x));
  if (iw.length) console.log("  " + iw.join("\n  "));
  console.log("\n--- POWER ---");
  [...d.querySelectorAll("#tab-league .row")].forEach(r => console.log(" ", r.textContent.replace(/\s+/g, " ").trim()));
  console.log(failures ? failures + " FAILED" : "ALL SEASON TESTS PASSED"); process.exit(failures ? 1 : 0);
})().catch(e => { console.error("crash", e); process.exit(1); });
