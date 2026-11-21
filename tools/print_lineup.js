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
// Team override (2026-11-20): FFL_TEAM="SACK OF WHEAT" targets Jose's second team; default is rosters.me ("ur done").
if (process.env.FFL_TEAM) { if (!rosters.teams[process.env.FFL_TEAM]) throw new Error("FFL_TEAM not in league: "+process.env.FFL_TEAM); rosters.me = process.env.FFL_TEAM; }
let matchups = null; try { matchups = J("matchups.json"); } catch (e) {} // optional — page degrades to consensus-only
// Same inputs as the browser (Jose 2026-10-20: the dashboard is the source of truth): the league's ESPN pool
// restricts streamers to players actually in this league, and the history feeds win odds / title stakes.
let pool = null; try { pool = J("espn_pool.json"); } catch (e) {}
let history = null; try { history = J("league_history.json"); } catch (e) {}
let settings = null; try { settings = J("settings.json"); } catch (e) {}
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) { w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 50));
  const w = dom.window, d = w.document, T = w.__seasonTest;
  if (settings && T.setSettings) T.setSettings(settings);
  T.inject(season, rosters, exclusions, trades, proj, pool, matchups, history);
  const me = rosters.teams[rosters.me].map(T.info);
  // Next week (2026-11-20): FFL_NEXT=1 prints next week's lineup from the page's nextWeekLineup() — ranked by next-week
  // projections (ESPN/Sleeper W+1, muNext) when the feed carries them for every available man, else by rest-of-season rank.
  // Used to pre-set a future week on ESPN (FUTURE_ROSTER) when Jose is away; the in-week runs still use the lock-aware blend.
  if (process.env.FFL_NEXT) {
    const r = T.nextWeekLineup(me);
    if (!r) { console.error("no next week (season week unknown)"); process.exit(2); }
    const rowN = p => p ? ({ player: p.name, pos: p.pos, team: p.team, projNext: p.muNext, espnNext: p.espnNext, sleeperNext: p.sleeperNext, ros: p.ros, rosEff: p.rosEff, espnSlot: p.slot || null,
      inj: p.injLive && p.injLive !== "ACT" ? p.injLive : null, byeNext: p.bye === r.week }) : null;
    const outN = {
      week: r.week, team: rosters.me, generated: proj.generated,
      basis: r.key === "muNext" ? "next-week projections (ESPN" + (me.some(p => typeof p.sleeperNext === "number") ? "+Sleeper" : "") + ")" : "rest-of-season rank (next-week projections not available for every player)",
      onByeNext: r.out.map(p => p.name),
      starters: r.L.slots.map(s => ({ slot: s.slot, ...(rowN(s.p) || { player: null, projNext: null }) })),
      bench: me.filter(p => !r.L.used.has(p.n)).map(rowN),
    };
    console.log(JSON.stringify(outN, null, 2));
    return;
  }
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
