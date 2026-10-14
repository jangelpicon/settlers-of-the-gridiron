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
let matchups = null; try { matchups = J("matchups.json"); } catch (e) {} // optional — page degrades to consensus-only
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) { w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 50));
  const w = dom.window, d = w.document, T = w.__seasonTest;
  T.inject(season, rosters, exclusions, trades, proj, null, matchups);
  const me = rosters.teams[rosters.me].map(T.info);
  // Lock-aware (2026-10-13): once games have kicked off, players in them are pinned to the slot ESPN has them in
  // (a locked starter stays started, a locked bench player can't come in). Before any kickoff this equals optimalLineup.
  // The Sunday re-check runs (11:10 / 14:10 CT) rely on this so a scratched noon starter is replaced only by someone unlocked.
  const L = T.lockAwareLineup(me, "mu");
  const row = p => p ? ({ player: p.name, pos: p.pos, team: p.team, proj: p.mu, locked: !!p.locked, espnSlot: p.slot || null,
    inj: p.injLive && p.injLive !== "ACT" ? p.injLive : null, pPlay: p.pPlay, onBye: !!p.onBye,
    game: p.game ? { opp: p.game.opp, home: !!p.game.home, state: p.game.state || "pre", status: p.game.status || null } : null }) : null;
  const out = {
    week: season.week,
    team: rosters.me,
    generated: proj.generated,
    lockedCount: L.pinned || 0,
    starters: L.slots.map(s => ({ slot: s.slot, ...(row(s.p) || { player: null, proj: null }) })),
    bench: L.bench.map(row),
  };
  console.log(JSON.stringify(out, null, 2));
})();
