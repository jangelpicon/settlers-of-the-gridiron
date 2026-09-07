# I got sheep FF — Draft Day Tool

A single-file, no-login, no-server draft-day tool for fantasy football.

## Use it on draft day

Just double-click `index.html` (or drag it into a browser tab). Everything runs
client-side — nothing to install, nothing to deploy.

1. **Setup screen**: the 9 "I got sheep FF" teams are fixed (names come from
   ESPN and aren't editable) — drag them, or use the ▲/▼ arrows, into round-1
   draft order. Then set # of rounds, seconds per pick,
   draft type (snake or auction), your starting lineup (QB/RB/WR/TE/FLEX/DST/K
   counts), which team is yours, and paste your rankings (`Name, POS, Team, ADP,
   Tier, Bye` per line — everything but Name is optional, order = your rank
   order). The pool ships pre-filled with the top 250 players blending **three
   independent FantasyPros PPR data feeds** for the 2026 season, pulled
   directly from FantasyPros' public cheat sheet:
   - **Expert Consensus Ranking (ECR)** — the aggregate of 100+ individual
     expert rankings (list order = ECR rank).
   - **ADP (Average Draft Position)** — from ESPN's public player feed, i.e.
     the same ADP the ESPN draft room shows (this league drafts on ESPN), as
     the optional 4th field.
   - **Tier** — FantasyPros' expert-consensus talent clusters, as the
     optional 5th field. Bye week is the 6th.

   When a player's ADP diverges meaningfully from their ECR rank, the queue
   flags it: green "value" (market is letting them slide past their expert
   rank — no need to reach) or red "going early" (market is drafting them
   ahead of consensus — grab them now if you want them). When a player is the
   last one left in their tier at their position, the Recommended Pick calls
   out the coming cliff so you know when reaching is actually correct.
   Overwrite the pool if you want your own board, a different scoring format,
   or don't have this data — everything still works with just `Name, POS, Team`.
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
   CSV** downloads the full draft results. **Export Waiver Board** downloads
   everyone still undrafted when the draft ends — that's your free-agent pool,
   ranked by consensus with tier/ADP/bye, ready to reference for waiver claims
   after the draft (no ESPN login involved, it's just the leftover pool from
   the same data). **Reset draft** clears everything and starts over.
5. State autosaves to your browser's localStorage, so a refresh won't lose
   your draft — "Load saved draft" on the setup screen picks it back up.

Auction mode swaps the snake logic for a $-budget bid dialog per pick and
tracks each team's remaining budget.

### Why one data provider, not four

FantasyPros ECR is already a blend of 100+ individual expert rankings, not one
analyst's opinion — that's most of the value of "multiple sources" already
baked in. ADP and Tier add two more genuinely different signals (real
draft-market behavior, and expert-consensus talent clustering) for the price
of two extra CSV columns we were already fetching. Scraping additional sites
(ESPN, Yahoo, Sleeper) on top of that would mean more scrapers to maintain
and more ways for the tool to silently break right before a live draft, for
marginal signal gain — not worth it for a draft-day helper. If you want to go
further later, drop in your own board using the same field format.

### Draft-day brain (what the recommendation actually does)

1. **Before the need round** (default 5): pure best-player-available, K/DST
   excluded. Shallow leagues fill bench needs on waivers; early picks are for
   talent.
2. **From the need round on**: best-ranked player who fills one of your open
   starting slots. **K and DST are never recommended before the reserved
   final rounds** (default: last 2). The gap between the best and 10th-best
   kicker/defense is noise, so an early K/DST pick costs you a real bench
   player. Before then, once your skill starters are full, it falls back to
   best bench player (never a K/DST, never a 3rd QB/TE, and never a 3rd
   bench RB/WR while the other has no backup — RBs are scarce on the wire and
   both positions get hurt).
3. **Snake timing (the wait/take call)**: the rec panel always shows your
   next pick number and how many picks stand between you and it. Every player
   with ADP gets a tag — "should last to #N" or "likely gone by #N" — based on
   whether the market's average draft slot lands comfortably after or before
   your next turn. When you're on the clock and the top recommendation should
   still be there next time around while a **same-tier** alternative won't be,
   it recommends the one that won't last and tells you why, keeping the other
   as the first alternate. It stays quiet when the margin is thin (ADP within
   a few picks of your slot, or fewer than 3 picks between turns), because ADP
   is an average with real spread and a false "he'll be there" is worse than
   no call.
4. **Tier cliff** and **bye-week clash** warnings ride along on the
   recommendation: last player of their tier at the position, or same bye week
   as a player you already hold at that position.
5. The pick clock rolls straight into the next pick once it's been started —
   no re-clicking Start every pick.

### Known gaps (2026-09-07 audit)

- **League settings confirmed from ESPN** (9 teams, full PPR, 14 rounds,
  QB1/RB2/WR2/TE1/FLEX1/DST1/K1) and baked in as defaults. Draft slot (which
  team is yours) still has to be picked on the setup screen once the order is
  known.
- **ADP is a cross-platform average, mostly 12-team drafts.** In a 9-team
  league the wait/take tags compare ADP against your actual pick numbers,
  which works because both are "how many players go before this one", but a
  room full of homers or one person drafting off a different list will
  deviate. Treat the tags as a strong prior, not a guarantee.
- **No projected points, so no true value-over-replacement.** Rankings and
  tiers are the proxy. A projections feed would let the tool compute how much
  a QB/TE is actually worth over the waiver-wire replacement in a 9-team
  league (less than ECR implies); not built.
- **Injury status comes from ESPN's public injury report**, merged into the
  pool as the optional 7th field (status) and 8th field (body part + ESPN's
  estimated return date) by `tools/merge_injuries.py` (re-run it any
  time; it stamps "Injuries refreshed" in the header). IR / OUT / SUSPENDED
  players get a red badge and are never recommended or offered as alternates
  (still draftable by hand). QUESTIONABLE / DOUBTFUL get a yellow badge and a
  heads-up on the recommendation; only designations reported in the last 10
  days are kept, because preseason "questionable" tags linger for weeks.
  It's still a snapshot — news after the last refresh won't show.
- **The pool is a snapshot**, refreshed by `tools/refresh_rankings.py`
  (FantasyPros ECR/tier/bye joined to ESPN ADP; dry-run with `--dry-run`)
  followed by `tools/merge_injuries.py`. Both stamp the header. Re-run
  before a draft or a weekly waiver check; the page itself can't re-fetch.
- **Strength-of-schedule/matchup data exists in the feed but isn't wired in.**
  Deprioritized — it matters more for in-season streaming/trade decisions
  than for a single draft-night snake/auction pick.
- Mobile layout was broken (3 columns forced a hidden horizontal scroll on
  phone-width screens) and has been fixed with a responsive breakpoint that
  stacks the board, recommendation, and queue vertically under 900px — tested
  at 390×844 (iPhone-class viewport).

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
- Optional 4th/5th/6th CSV fields (ADP, Tier, Bye) parsing and the resulting
  value/reach badge and tier-cliff warning
- Waiver board export (undrafted players only, excludes anyone already picked)
- K/DST late-round guard (never recommended or offered as an alternate before
  the reserved final rounds, then recommended as a need fill)
- Snake timing: next-pick math, should-last/likely-gone tags, the same-tier
  wait/take swap when on the clock, no swap when not on the clock, and no swap
  when the only "gone" option is a real tier drop
- Bye-week clash warning
- Injury field parsing, badges, and IR/OUT exclusion from recommendations
- Bench balance (no 3rd bench WR while there's no backup RB, and back to BPA
  once there is)

Run it:

```bash
npm install jsdom --no-save   # one-time, ~26MB, only needed to run tests
node test.js
```

All 123 assertions currently pass.
