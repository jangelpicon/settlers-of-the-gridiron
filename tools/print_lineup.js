// Prints the season.html dashboard's recommended lineup as JSON (slot -> player).
// Runs the real dashboard code headlessly in jsdom against the live data/ files,
// so output is exactly what the Lineup tab shows. Run from the repo root:
//   NODE_PATH=./node_modules node tools/print_lineup.js
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const dir = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(dir, "season.html"), "utf8");
const J = f => JSON.parse(fs.readFileSync(path.join(dir, "data", f), "utf8"));
const season = J("season.json"), rosters = J("rosters.json"), exclusions = J("exclusions.json"),
  trades = J("trades.json"), proj = J("projections.json");
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) { w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 50));
  const w = dom.window, d = w.document, T = w.__seasonTest;
  T.inject(season, rosters, exclusions, trades, proj);
  const me = rosters.teams[rosters.me].map(T.info);
  const L = T.optimalLineup(me, "mu");
  const out = {
    week: season.week,
    team: rosters.me,
    generated: proj.generated,
    starters: L.slots.map(s => ({ slot: s.slot, player: s.p ? s.p.name : null, proj: s.p ? s.p.mu : null })),
    bench: L.bench.map(b => ({ player: b.name, proj: b.mu })),
  };
  console.log(JSON.stringify(out, null, 2));
})();
