# Settlers of the Gridiron

A single-file, no-login, no-server draft-day tool for fantasy football.

## Use it on draft day

Just double-click `index.html` (or drag it into a browser tab). Everything runs
client-side — nothing to install, nothing to deploy.

1. **Setup screen**: set # of teams, # of rounds, seconds per pick, team names,
   draft type (snake or auction), your starting lineup (QB/RB/WR/TE/FLEX/DST/K
   counts), which team is yours, and paste your rankings (`Name, POS, Team, ADP`
   per line — POS/Team/ADP all optional, order = your rank order). The pool
   ships pre-filled with the top 250 players blending **two independent
   FantasyPros PPR data feeds** for the 2026 season, pulled directly from
   FantasyPros' public cheat sheet:
   - **Expert Consensus Ranking (ECR)** — the aggregate of 100+ individual
     expert rankings (list order = ECR rank).
   - **ADP (Average Draft Position)** — real draft-market behavior across
     actual platforms, as the optional 4th field.

   When a player's ADP diverges meaningfully from their ECR rank, the queue
   flags it: green "value" (market is letting them slide past their expert
   rank — no need to reach) or red "going early" (market is drafting them
   ahead of consensus — grab them now if you want them). Overwrite the pool
   if you want your own board, a different scoring format, or don't have ADP
   data — everything still works with just `Name, POS, Team`.
2. Click **Start Draft**.
3. As players get picked (by you or anyone else), click **Draft** next to
   their name in the queue — or just take the **Recommended Pick**, which
   combines your open roster needs with best-available value (need ∩ value:
   the best-ranked player among everyone who'd fill one of your open starting
   slots; once your lineup is full, it falls back to true best-player-available
   for bench/upside). The **Your Roster** panel shows exactly which starting
   slots are filled and which are still open, live.
4. The board auto-fills in the correct snake slot and the clock advances to
   the next team. **Undo** reverses the last pick if you misclick. **Export
   CSV** downloads the full draft results. **Reset draft** clears everything
   and starts over.
5. State autosaves to your browser's localStorage, so a refresh won't lose
   your draft — "Load saved draft" on the setup screen picks it back up.

Auction mode swaps the snake logic for a $-budget bid dialog per pick and
tracks each team's remaining budget.

### Why one data provider, not four

FantasyPros ECR is already a blend of 100+ individual expert rankings, not one
analyst's opinion — that's most of the value of "multiple sources" already
baked in. ADP adds a second, genuinely different signal (real draft-market
behavior instead of expert opinion) for the price of one extra CSV column
we were already fetching. Scraping additional sites (ESPN, Yahoo, Sleeper)
on top of that would mean more scrapers to maintain and more ways for the
tool to silently break right before a live draft, for marginal signal gain —
not worth it for a draft-day helper. If you want to go further later, drop
in your own board using the same 4-field format.

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
- Roster tracking + need-aware pick recommendation (best-available, need-fill,
  and bench-fallback cases, hand-traced through a scripted mini-draft)
- Optional 4th CSV field (ADP) parsing and the resulting value/reach badge

Run it:

```bash
npm install jsdom --no-save   # one-time, ~26MB, only needed to run tests
node test.js
```

All 40 assertions currently pass.
