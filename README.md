# Settlers of the Gridiron

A single-file, no-login, no-server draft-day tool for fantasy football.

## Use it on draft day

Just double-click `index.html` (or drag it into a browser tab). Everything runs
client-side — nothing to install, nothing to deploy.

1. **Setup screen**: set # of teams, # of rounds, seconds per pick, team names,
   draft type (snake or auction), and paste your rankings (`Name, POS, Team`
   per line — order = your rank order). The player pool ships pre-filled with
   the top 250 players by **FantasyPros PPR Expert Consensus Ranking (ECR)**
   for the 2026 season — a live aggregate of 100+ expert rankings, pulled
   directly from FantasyPros' public cheat sheet. Overwrite it if you want
   your own board or a different scoring format (standard/half-PPR).
2. Click **Start Draft**.
3. As players get picked (by you or anyone else), click **Draft** next to
   their name in the queue. The board auto-fills in the correct snake slot
   and the clock advances to the next team.
4. **Undo** reverses the last pick if you misclick. **Export CSV** downloads
   the full draft results. **Reset draft** clears everything and starts over.
5. State autosaves to your browser's localStorage, so a refresh won't lose
   your draft — "Load saved draft" on the setup screen picks it back up.

Auction mode swaps the snake logic for a $-budget bid dialog per pick and
tracks each team's remaining budget.

## Testing

`test.js` is a headless smoke test (via jsdom) that drives the real
`index.html`/JS exactly like a user would — no mocked logic. It covers:

- Setup parsing (teams, rounds, player list)
- Snake draft math across rounds (forward/reverse alternation)
- Drafting a player: board cell fill, queue removal, clock advance
- Undo
- Position filtering
- Full draft completion
- CSV export
- localStorage persistence
- Auction mode budget tracking

Run it:

```bash
npm install jsdom --no-save   # one-time, ~26MB, only needed to run tests
node test.js
```

All 26 assertions currently pass.
