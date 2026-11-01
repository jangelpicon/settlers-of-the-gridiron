// Log every live matchup's win probability (home side) to data/winprob_log.json — one point per run.
// Runs the real season.html headlessly (same lineups, same winProbAt as the Matchup tab) against the
// data/ files just refreshed by tools/winprob_log.sh. Jose 2026-11-01: "make these broken down more on
// game days, by quarter or every hour" — the page can only re-figure the past from kickoff times, so the
// in-game path has to be recorded as it happens. Shape:
//   { "generated": ISO, "weeks": { "8": { "<home>|<away>": [ { "t": ms, "p": P(home wins), "hp": homePts, "ap": awayPts, "live": nGamesInProgress } ] } } }
// Usage: NODE_PATH=./node_modules node tools/winprob_log.js [--dry-run] [--force]
//   exit 0 = logged (or dry-run printed) · 3 = nothing live, nothing logged · 1 = error
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const dir = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry-run"), FORCE = process.argv.includes("--force");
const J = f => JSON.parse(fs.readFileSync(path.join(dir, "data", f), "utf8"));
const opt = f => { try { return J(f); } catch (e) { return null; } };
const html = fs.readFileSync(path.join(dir, "season.html"), "utf8");
const season = J("season.json"), rosters = J("rosters.json"), exclusions = J("exclusions.json"), trades = J("trades.json"), proj = J("projections.json");
const matchups = opt("matchups.json"), pool = opt("espn_pool.json"), history = opt("league_history.json"), settings = opt("settings.json");
const LOG = path.join(dir, "data", "winprob_log.json");
(async () => {
  // Gate: something must be in progress, or have gone final in the last 5 hours (so the final settle is captured).
  const now = Date.now(), games = Object.values(proj.games || {});
  const live = Math.round(games.filter(g => g.state === "in").length / 2); // P.games has one entry per TEAM
  const recentFinal = games.some(g => g.state === "post" && g.kick && now - Date.parse(g.kick) < 5 * 3600e3);
  if (!live && !recentFinal && !FORCE) { console.log("no game live or recently final — nothing to log"); process.exit(3); }
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) { w.__seasonNoAutoLoad = true; } });
  await new Promise(r => setTimeout(r, 50));
  const w = dom.window, T = w.__seasonTest;
  if (settings && T.setSettings) T.setSettings(settings);
  T.inject(season, rosters, exclusions, trades, proj, pool, matchups, history);
  if (!history || history.currentWeek == null) { console.error("no league schedule — cannot log"); process.exit(1); }
  const wk = String(history.currentWeek), R = T.getRosters();
  const rows = history.schedule.filter(r => r.w === history.currentWeek && r.home && r.away && R.teams[r.home] && R.teams[r.away]);
  const team = n => R.teams[n].map(T.info);
  const pts = L => L.slots.reduce((a, s) => a + T.effPts(s.p), 0);
  const log = (fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : { weeks: {} });
  log.weeks = log.weeks || {}; log.weeks[wk] = log.weeks[wk] || {};
  const out = [];
  rows.forEach(r => {
    const LA = T.setLineup(team(r.home), "mu"), LB = T.setLineup(team(r.away), "mu");
    const pt = { t: now, p: Math.round(T.winProbAt(LA, LB, now) * 1000) / 1000, hp: Math.round(pts(LA) * 10) / 10, ap: Math.round(pts(LB) * 10) / 10, live };
    const key = r.home + "|" + r.away, arr = log.weeks[wk][key] = log.weeks[wk][key] || [];
    arr.push(pt); out.push({ matchup: key, ...pt });
  });
  log.generated = new Date(now).toISOString();
  if (DRY) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  fs.writeFileSync(LOG, JSON.stringify(log));
  console.log("logged " + out.length + " matchups at " + new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago" }) + " (" + live + " games live): " + out.map(o => o.matchup + " " + Math.round(o.p * 100) + "%").join(" · "));
})().catch(e => { console.error(e); process.exit(1); });
