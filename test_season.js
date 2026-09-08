// Headless test for season.html: loads the real page in jsdom with real data/season.json + data/rosters.json.
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "season.html"), "utf8");
const season = JSON.parse(fs.readFileSync(path.join(__dirname, "data/season.json"), "utf8"));
const rosters = JSON.parse(fs.readFileSync(path.join(__dirname, "data/rosters.json"), "utf8"));
const exclusions = JSON.parse(fs.readFileSync(path.join(__dirname, "data/exclusions.json"), "utf8"));
const tradeLog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/trades.json"), "utf8"));
let failures = 0;
const assert = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) failures++; };
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w){ w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 30));
  const w = dom.window, d = w.document, T = w.__seasonTest;
  T.inject(season, rosters, exclusions, tradeLog);
  console.log("== Lineup ==");
  const starters = [...d.querySelectorAll("#tab-lineup .row.start")];
  assert(starters.length === 9, "9 starting slots rendered (QB,RB1,RB2,WR1,WR2,TE,DST,K,FLEX)");
  const txt = s => s.textContent;
  assert(starters.some(s => /WR1|WR2/.test(txt(s)) && /Ja'Marr Chase/.test(txt(s))), "Chase starts at WR");
  assert(starters.some(s => /^\s*QB/.test(txt(s)) && /Drake Maye/.test(txt(s))), "Maye starts at QB");
  const slotOf = s => s.querySelector(".slot").textContent.trim();
  assert(starters.some(s => slotOf(s) === "DST" && /Vikings/.test(txt(s))) && starters.some(s => slotOf(s) === "K" && /Tyler Loop/.test(txt(s))), "DST and K slots filled from roster");
  assert(starters.every(s => !/BYE/.test(txt(s))), "no bye-week player in the starting lineup");
  const bench = [...d.querySelectorAll("#tab-lineup .row.sit")];
  assert(bench.length === 5, "5 bench players");
  const me = rosters.teams[rosters.me].map(T.info);
  assert(me.every(p => p.ros != null), "every rostered player resolves to a rest-of-season rank");
  assert(me.filter(p => ["QB","RB","WR","TE"].includes(p.pos)).every(p => p.wkRank != null), "every skill player resolves to a Week " + season.week + " rank");
  console.log("== Waivers ==");
  const fa = T.freeAgents();
  assert(fa.length > 200, "free-agent pool is large (" + fa.length + ") in a 9-team league");
  const allRostered = new Set(Object.values(rosters.teams).flat().map(p => T.norm(p.name)));
  assert(fa.every(p => !allRostered.has(p.n)), "no rostered player appears as a free agent");
  assert(!fa.some(p => p.n === T.norm("Tetairoa McMillan")), "excluded player (not in ESPN's pool) never appears as a free agent or waiver suggestion");
  assert(!/McMillan/.test(d.getElementById("tab-waivers").textContent), "waiver tab does not mention the excluded player");
  assert(/Streamers this week/.test(d.getElementById("tab-waivers").textContent), "streamer section rendered");
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
  console.log("== Trade tracking ==");
  const top = trades[0];
  const before = trades.length;
  d.querySelector("#tab-trades .tbtns button[data-status='declined']").click();   // decline the #1 offer
  let after = T.findTrades();
  assert(!after.some(x => x.team === top.team && x.get.n === top.get.n && x.give.n === top.give.n), "a declined offer disappears from the list");
  assert(T.teamFloor(top.team) === top.theirGain + 3, "declining teaches the model: that team's floor rises to (declined their-side + 3)");
  assert(after.filter(x => x.team === top.team).every(x => x.theirGain >= top.theirGain + 3), "remaining offers to that team are all sweeter for them than the declined one");
  assert(/declined/.test(d.getElementById("tab-trades").textContent) && /Trade log/.test(d.getElementById("tab-trades").textContent), "decline shows up in the trade log");
  d.querySelector("#tab-trades .tb-undo").click();                                 // undo it
  assert(T.findTrades().length === before, "undo restores the list");
  // propose then accept the #1 offer -> rosters swap locally and everything recomputes
  d.querySelector("#tab-trades .tbtns button[data-status='proposed']").click();
  assert(/Open proposals/.test(d.getElementById("tab-trades").textContent) && T.getLog().some(e => e.status === "proposed"), "proposed offer moves to the Open proposals section");
  d.querySelector("#tab-trades .tbtns button[data-status='accepted']").click();
  const RR = T.getRosters();
  assert(RR.teams[RR.me].some(p => T.norm(p.name) === top.get.n) && !RR.teams[RR.me].some(p => T.norm(p.name) === top.give.n), "accepted: I now have the player I got and no longer have the one I gave");
  assert(RR.teams[top.team].some(p => T.norm(p.name) === top.give.n), "accepted: the other team now has my player");
  assert(!T.findTrades().some(x => x.get.n === top.get.n), "accepted trade no longer proposed");
  assert([...d.querySelectorAll("#tab-lineup .row")].some(r => new RegExp(top.get.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(r.textContent)), "lineup tab now shows the acquired player");
  // reset local log so later assertions/printouts use the clean state
  T.getLog().filter(e => e.local).forEach(e => { d.querySelector("#tab-trades .tb-undo") && d.querySelector("#tab-trades .tb-undo").click(); });
  T.inject(season, rosters, exclusions, tradeLog);
  console.log("== Byes / League ==");
  assert([...d.querySelectorAll("#tab-byes .row")].length >= 5, "bye map has rows");
  assert([...d.querySelectorAll("#tab-league .row")].length === 9, "power ranking lists all 9 teams");
  console.log("\n--- OPTIMAL TRADES ---");
  { const seen = new Set();
    T.findTrades().filter(t => { const k = t.team + "|" + t.get.n; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8).forEach((t, i) =>
      console.log(`${i+1}. ${t.team}: give ${t.give.name} (${t.give.pos} ROS#${t.give.ros}) for ${t.get.name} (${t.get.pos} ROS#${t.get.ros}) | me +${t.myGain} them ${t.theirGain >= 0 ? "+" : ""}${t.theirGain} [${t.odds.label}] EV ${t.ev}`)); }
  console.log("\n--- WAIVER SUGGESTIONS ---");
  console.log(d.getElementById("tab-waivers").textContent.replace(/\s+/g, " ").slice(0, 900));
  console.log("\n--- LINEUP ---");
  starters.forEach(s => console.log(" ", txt(s).replace(/\s+/g, " ").trim().slice(0, 110)));
  console.log("\n--- POWER ---");
  [...d.querySelectorAll("#tab-league .row")].forEach(r => console.log(" ", r.textContent.replace(/\s+/g, " ").trim()));
  console.log(failures ? failures + " FAILED" : "ALL SEASON TESTS PASSED"); process.exit(failures ? 1 : 0);
})().catch(e => { console.error("crash", e); process.exit(1); });
