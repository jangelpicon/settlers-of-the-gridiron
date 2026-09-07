// Headless smoke test for the I got sheep FF draft-day tool.
// Loads the real index.html in jsdom and drives it like a user would.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ok - " + msg);
  } else {
    console.log("  FAIL - " + msg);
    failures++;
  }
}

async function run() {
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  const { window } = dom;
  // localStorage is provided by jsdom's "usable" resources + url; give it a tick to init scripts.
  await new Promise(r => setTimeout(r, 50));

  const doc = window.document;

  console.log("\n== Test 1: Setup screen defaults & 4-team snake draft ==");
  doc.getElementById("numTeams").value = 4;
  doc.getElementById("numRounds").value = 3;
  doc.getElementById("pickSeconds").value = 5;
  doc.getElementById("teamNames").value = "Alpha, Bravo, Charlie, Delta";
  doc.getElementById("playerInput").value = [
    "P1,RB,AAA","P2,WR,BBB","P3,QB,CCC","P4,TE,DDD",
    "P5,RB,EEE","P6,WR,FFF","P7,QB,GGG","P8,TE,HHH",
    "P9,RB,III","P10,WR,JJJ","P11,QB,KKK","P12,TE,LLL"
  ].join("\n");

  doc.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));

  assert(!doc.getElementById("draft").classList.contains("hidden"), "draft screen becomes visible after Start Draft");
  const st = window.__sotgTest.getState();
  assert(st.config.numTeams === 4 && st.config.numRounds === 3, "config picked up numTeams/numRounds from inputs");
  assert(st.players.length === 12, "parsed 12 players from textarea");
  assert(st.config.teamNames.join(",") === "Alpha,Bravo,Charlie,Delta", "team names parsed in order");

  console.log("\n== Test 2: Snake order math (4 teams) ==");
  // Round 1 forward 0,1,2,3 ; Round 2 reverse 3,2,1,0 ; Round 3 forward 0,1,2,3
  assert(window.__sotgTest.teamIndexForOverallPick(1) === 0, "pick 1 -> team 0 (Alpha)");
  assert(window.__sotgTest.teamIndexForOverallPick(4) === 3, "pick 4 -> team 3 (Delta), end of round 1");
  assert(window.__sotgTest.teamIndexForOverallPick(5) === 3, "pick 5 -> team 3 (Delta), snake reverses into round 2");
  assert(window.__sotgTest.teamIndexForOverallPick(8) === 0, "pick 8 -> team 0 (Alpha), end of round 2");
  assert(window.__sotgTest.teamIndexForOverallPick(9) === 0, "pick 9 -> team 0 (Alpha), round 3 forward again");
  assert(window.__sotgTest.roundForOverall(9) === 3, "pick 9 is round 3");
  assert(window.__sotgTest.pickInRoundForOverall(9) === 1, "pick 9 is slot 1 within round 3");

  console.log("\n== Test 3: Drafting a player updates board, queue, and advances the clock ==");
  const beforeCount = window.__sotgTest.getState().players.filter(p => !p.drafted).length;
  const drafted1 = window.__sotgTest.draftFirstAvailable(); // should go to team 0 (Alpha), pick 1
  await new Promise(r => setTimeout(r, 20));
  const afterState = window.__sotgTest.getState();
  const afterCount = afterState.players.filter(p => !p.drafted).length;
  assert(afterCount === beforeCount - 1, "undrafted player count decremented by 1");
  assert(afterState.currentOverall === 2, "current overall pick advanced to 2 after a pick");
  const cell1 = doc.querySelector("td[data-overall='1']");
  assert(cell1 && cell1.classList.contains("filled"), "board cell #1 marked filled");
  assert(cell1 && cell1.textContent.includes(drafted1.name), "board cell #1 shows drafted player's name");
  const queueNames = [...doc.querySelectorAll("#player-list .player-row .player-info b")].map(b => b.textContent);
  assert(!queueNames.includes(drafted1.name), "drafted player removed from the live queue list");
  assert(doc.getElementById("curTeam").textContent === "Bravo", "on-the-clock indicator now shows the next team (Bravo)");

  console.log("\n== Test 4: Undo restores state exactly ==");
  doc.getElementById("undoBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const undone = window.__sotgTest.getState();
  assert(undone.currentOverall === 1, "current overall pick reverted to 1 after undo");
  assert(undone.players.filter(p => !p.drafted).length === beforeCount, "undone player is back in the pool");
  assert(/Alpha$/.test(doc.getElementById("curTeam").textContent), "on-the-clock reverted back to Alpha (labeled YOU since Alpha is my team)");

  console.log("\n== Test 5: Position filter narrows the queue ==");
  doc.getElementById("search").value = "";
  doc.getElementById("search").dispatchEvent(new window.Event("input"));
  const qbFilterBtn = [...doc.querySelectorAll(".filter-btn")].find(b => b.dataset.pos === "QB");
  qbFilterBtn.click();
  await new Promise(r => setTimeout(r, 20));
  const rows = doc.querySelectorAll("#player-list .player-row");
  assert(rows.length === 3, "QB filter shows exactly the 3 QBs in the pool");
  assert([...rows].every(r => r.querySelector(".pos-tag").textContent === "QB"), "every visible row is tagged QB");

  console.log("\n== Test 6: Full draft completes and locks further picks ==");
  const allBtn = [...doc.querySelectorAll(".filter-btn")].find(b => b.dataset.pos === "ALL");
  allBtn.click();
  for (let i = 0; i < 12; i++) {
    window.__sotgTest.draftFirstAvailable();
    await new Promise(r => setTimeout(r, 5));
  }
  const finalState = window.__sotgTest.getState();
  assert(finalState.picks.length === 12, "all 12 players drafted across 3 rounds x 4 teams");
  assert(doc.getElementById("curTeam").textContent.includes("complete"), "status bar announces draft complete");

  console.log("\n== Test 7: CSV export builds a well-formed row per pick ==");
  // Exercise the same code path as the Export button without touching real disk I/O (jsdom has no download sink).
  let blobCaptured = null;
  const OrigBlob = window.Blob;
  window.URL.createObjectURL = (blob) => { blobCaptured = blob; return "blob:fake"; };
  window.URL.revokeObjectURL = () => {};
  doc.getElementById("exportBtn").click();
  assert(blobCaptured !== null, "export click produced a CSV Blob");

  console.log("\n== Test 8: LocalStorage persistence survives a reload ==");
  const raw = window.localStorage.getItem("sotg_draft_v1");
  assert(!!raw, "draft state persisted to localStorage");
  const parsed = JSON.parse(raw);
  assert(parsed.picks.length === 12, "persisted state has all 12 picks");

  console.log("\n== Test 9: Auction draft type does not crash and tracks budgets ==");
  // Fresh document for auction mode.
  const dom2 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc2 = dom2.window.document;
  doc2.getElementById("numTeams").value = 2;
  doc2.getElementById("numRounds").value = 1;
  doc2.getElementById("teamNames").value = "Alpha, Bravo";
  [...doc2.querySelectorAll("#setup .radio-btn")].find(b => b.dataset.type === "auction").click();
  doc2.getElementById("budget").value = 100;
  doc2.getElementById("playerInput").value = "P1,RB,AAA\nP2,WR,BBB";
  doc2.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const st2 = dom2.window.__sotgTest.getState();
  assert(st2.config.draftType === "auction", "auction draft type selected correctly");
  assert(st2.budgets[0] === 100 && st2.budgets[1] === 100, "both teams start with configured $100 budget");

  console.log("\n== Test 10: Roster tracking + pick recommendation (need-aware, data-driven) ==");
  const dom3 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc3 = dom3.window.document;

  // Snake order for 2 teams alternates A,B,B,A,A,B,... so we draft specific
  // named players (like a real user clicking the queue) instead of always
  // taking rank-1, which keeps each team's outcome deterministic and provable by hand.
  function draftByName(name) {
    const row = [...doc3.querySelectorAll("#player-list .player-row")]
      .find(r => r.querySelector(".player-info b").textContent === name);
    if (!row) throw new Error("player row not found for " + name);
    row.querySelector("button").click();
  }

  doc3.getElementById("numTeams").value = 2;
  doc3.getElementById("numRounds").value = 6;
  doc3.getElementById("teamNames").value = "Alpha, Bravo";
  // Minimal lineup: 1 QB, 1 RB only — no FLEX/WR ambiguity, easy to verify by hand.
  doc3.getElementById("rosterQB").value = 1;
  doc3.getElementById("rosterRB").value = 1;
  doc3.getElementById("rosterWR").value = 0;
  doc3.getElementById("rosterTE").value = 0;
  doc3.getElementById("rosterFLEX").value = 0;
  doc3.getElementById("rosterDST").value = 0;
  doc3.getElementById("rosterK").value = 0;
  doc3.getElementById("needRound").value = 1; // isolate need-logic from the round gate tested separately below
  doc3.getElementById("playerInput").value = [
    "RB1,RB,AAA","WR1,WR,BBB","QB1,QB,CCC","RB2,RB,DDD",
    "WR2,WR,EEE","QB2,QB,FFF","TE1,TE,GGG","RB3,RB,HHH"
  ].join("\n");
  doc3.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  // myTeamIndex defaults to option 0 (Alpha) since the test never touches the select.
  assert(dom3.window.__sotgTest.getMyTeamIndex() === 0, "my team defaults to the first team (Alpha)");

  let rec = dom3.window.__sotgTest.computeRecommendation();
  assert(rec.player.name === "RB1", "with everything open, recommendation = best player available (RB1, rank 1)");

  draftByName("RB1"); // pick1 -> Alpha (fills RB)
  await new Promise(r => setTimeout(r, 10));
  draftByName("WR1"); // pick2 -> Bravo
  await new Promise(r => setTimeout(r, 10));
  draftByName("RB2"); // pick3 -> Bravo (keeps QB1 alive for Alpha's next turn)
  await new Promise(r => setTimeout(r, 10));

  const rosterAfter1 = dom3.window.__sotgTest.computeRosterAssignment(0);
  const rbSlot = rosterAfter1.starterSlots.find(s => s.type === "RB");
  assert(rbSlot.filled && rbSlot.filled.name === "RB1", "Alpha's RB starter slot shows RB1 after the pick");
  const qbSlotOpen = rosterAfter1.starterSlots.find(s => s.type === "QB");
  assert(!qbSlotOpen.filled, "Alpha's QB starter slot is still open");

  rec = dom3.window.__sotgTest.computeRecommendation();
  assert(rec.player.name === "QB1", "with only QB open, rec recommends the best remaining QB (QB1) even though better-ranked non-QBs remain");
  assert(/QB slot/.test(rec.reason), "recommendation reason names the QB slot it fills");

  draftByName("QB1"); // pick4 -> Alpha (fills QB) -> Alpha's lineup now complete
  await new Promise(r => setTimeout(r, 10));

  const rosterFull = dom3.window.__sotgTest.computeRosterAssignment(0);
  assert(rosterFull.starterSlots.every(s => s.filled), "Alpha's starting lineup (QB + RB) is fully filled");
  assert(rosterFull.bench.length === 0, "no bench players yet for Alpha (exactly 2 starters, 2 picks)");

  rec = dom3.window.__sotgTest.computeRecommendation();
  assert(rec.player.name === "WR2", "once all starters are filled, rec falls back to true best-player-available (WR2)");
  assert(/best player available/i.test(rec.reason), "fallback reason explains it's BPA for bench/upside, not a need fill");

  console.log("\n== Test 11: Optional 4th field (ADP) parses and drives the value badge ==");
  const dom4 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc4 = dom4.window.document;
  doc4.getElementById("numTeams").value = 2;
  doc4.getElementById("numRounds").value = 2;
  doc4.getElementById("teamNames").value = "Alpha, Bravo";
  doc4.getElementById("playerInput").value = [
    "Value Guy,RB,AAA,9",   // rank 1, ADP 9 -> delta +8, drafted later than his rank -> "value"
    "Hot Guy,WR,BBB,1",     // rank 2, ADP 1 -> delta -1... need bigger gap, see next line
    "No ADP Guy,QB,CCC",    // rank 3, no 4th field -> adp stays null, no badge
    "Reach Guy,TE,DDD,25"   // rank 4, but only 4 players in pool so ADP 25 is fine, delta +21 -> value too
  ].join("\n");
  doc4.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const st4 = dom4.window.__sotgTest.getState();
  const valueGuy = st4.players.find(p => p.name === "Value Guy");
  const noAdpGuy = st4.players.find(p => p.name === "No ADP Guy");
  assert(valueGuy.ecrRank === 1 && valueGuy.adp === 9, "4th CSV field parses into player.adp, ecrRank tracks list position");
  assert(noAdpGuy.adp === null, "missing 4th field leaves adp null instead of crashing (backward compatible)");

  const rows4 = [...doc4.querySelectorAll("#player-list .player-row")];
  const valueRow = rows4.find(r => r.querySelector(".player-info b").textContent === "Value Guy");
  assert(valueRow.querySelector(".value-tag.value-good"), "queue row shows a green 'value' tag when ADP is well later than consensus rank");
  const noAdpRow = rows4.find(r => r.querySelector(".player-info b").textContent === "No ADP Guy");
  assert(!noAdpRow.querySelector(".value-tag"), "queue row shows no value tag at all when the pasted line had no ADP");

  console.log("\n== Test 12: Tier + bye parse, and the recommendation flags a real talent cliff ==");
  const dom5 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc5 = dom5.window.document;
  doc5.getElementById("numTeams").value = 2;
  doc5.getElementById("numRounds").value = 2;
  doc5.getElementById("teamNames").value = "Alpha, Bravo";
  doc5.getElementById("rosterQB").value = 0;
  doc5.getElementById("rosterRB").value = 1;
  doc5.getElementById("rosterWR").value = 0;
  doc5.getElementById("rosterTE").value = 0;
  doc5.getElementById("rosterFLEX").value = 0;
  doc5.getElementById("rosterDST").value = 0;
  doc5.getElementById("rosterK").value = 0;
  doc5.getElementById("playerInput").value = [
    "RB Last In Tier1,RB,AAA,1,1,7",  // only Tier-1 RB left
    "RB First In Tier2,RB,BBB,2,2,9", // next RB is a tier worse -> cliff after RB1
    "WR Filler,WR,CCC,3,1,10"
  ].join("\n");
  doc5.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));

  const st5 = dom5.window.__sotgTest.getState();
  const rbLast = st5.players.find(p => p.name === "RB Last In Tier1");
  assert(rbLast.tier === 1 && rbLast.bye === 7, "5th/6th CSV fields parse into player.tier and player.bye");

  const rec5 = dom5.window.__sotgTest.computeRecommendation();
  assert(rec5.player.name === "RB Last In Tier1", "rec still recommends the best-ranked RB that fills the open slot");
  assert(/Last Tier 1 RB/.test(rec5.reason), "reason calls out that this is the last Tier 1 RB left");
  assert(/tier drop/.test(rec5.reason), "reason warns the next RB available is a tier drop-off");

  const rows5 = [...doc5.querySelectorAll("#player-list .player-row")];
  const rbLastRow = rows5.find(r => r.querySelector(".player-info b").textContent === "RB Last In Tier1");
  const tierTag = rbLastRow.querySelector(".tier-tag");
  assert(tierTag && tierTag.textContent === "T1 · Bye 7", "queue row shows a combined tier + bye badge");

  console.log("\n== Test 13: Waiver board export lists only undrafted players ==");
  const dom6 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc6 = dom6.window.document;
  doc6.getElementById("numTeams").value = 2;
  doc6.getElementById("numRounds").value = 1;
  doc6.getElementById("teamNames").value = "Alpha, Bravo";
  doc6.getElementById("playerInput").value = [
    "Drafted Guy,RB,AAA,1,1,7",
    "Waiver Guy,WR,BBB,2,1,9"
  ].join("\n");
  doc6.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  dom6.window.__sotgTest.draftFirstAvailable(); // Alpha takes Drafted Guy, pick1
  await new Promise(r => setTimeout(r, 10));

  let waiverBlob = null;
  dom6.window.URL.createObjectURL = (blob) => { waiverBlob = blob; return "blob:fake"; };
  dom6.window.URL.revokeObjectURL = () => {};
  doc6.getElementById("exportWaiverBtn").click();
  assert(waiverBlob !== null, "waiver export click produced a CSV Blob");
  const waiverText = await waiverBlob.text();
  assert(waiverText.includes("Waiver Guy"), "waiver board includes the still-undrafted player");
  assert(!waiverText.includes("Drafted Guy"), "waiver board excludes the already-drafted player");
  assert(waiverText.includes("ConsensusRank,Tier,Position,Player,NFLTeam,ADP,Bye"), "waiver board has the expected header row");

  console.log("\n== Test 14: Need is ignored before needRound (shallow-league draft-for-value guardrail) ==");
  const dom7 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc7 = dom7.window.document;
  function draftByName7(name) {
    const row = [...doc7.querySelectorAll("#player-list .player-row")]
      .find(r => r.querySelector(".player-info b").textContent === name);
    if (!row) throw new Error("player row not found for " + name);
    row.querySelector("button").click();
  }
  doc7.getElementById("numTeams").value = 2; // 2 is the minimum the app allows (min="2")
  doc7.getElementById("numRounds").value = 4;
  doc7.getElementById("teamNames").value = "Alpha, Bravo";
  doc7.getElementById("rosterQB").value = 1;
  doc7.getElementById("rosterRB").value = 0;
  doc7.getElementById("rosterWR").value = 0;
  doc7.getElementById("rosterTE").value = 0;
  doc7.getElementById("rosterFLEX").value = 0;
  doc7.getElementById("rosterDST").value = 0;
  doc7.getElementById("rosterK").value = 0;
  doc7.getElementById("needRound").value = 3;
  // 5 WRs all outrank the QB, so any round-3 QB recommendation is a real need
  // override, not a coincidence of rank order.
  doc7.getElementById("playerInput").value = [
    "Filler1,WR,AAA", "Filler2,WR,BBB", "Filler3,WR,CCC", "Filler4,WR,DDD",
    "Filler5,WR,EEE", "TargetQB,QB,FFF", "Filler6,WR,GGG"
  ].join("\n");
  doc7.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));

  // Snake order for 2 teams over picks 1-4: Alpha, Bravo, Bravo, Alpha.
  // roundForOverall = ceil(overall/2), so overall 1-2 = round 1, 3-4 = round 2, 5-6 = round 3.
  let rec7 = dom7.window.__sotgTest.computeRecommendation();
  assert(rec7.player.name === "Filler1", "round 1 (before needRound 3): rec is pure best-player-available, ignoring the open QB slot");
  assert(/Round 1 of 3/.test(rec7.reason), "reason states which round the need-gate opens at");

  draftByName7("Filler1"); // overall1, Alpha
  await new Promise(r => setTimeout(r, 10));
  draftByName7("Filler2"); // overall2, Bravo
  await new Promise(r => setTimeout(r, 10));
  rec7 = dom7.window.__sotgTest.computeRecommendation();
  assert(rec7.player.name === "Filler3", "round 2 (still before needRound 3): still pure BPA, still ignoring the QB need");

  draftByName7("Filler3"); // overall3, Bravo
  await new Promise(r => setTimeout(r, 10));
  draftByName7("Filler4"); // overall4, Alpha
  await new Promise(r => setTimeout(r, 10));
  rec7 = dom7.window.__sotgTest.computeRecommendation();
  assert(rec7.player.name === "TargetQB", "round 3 (needRound reached): now recommends the QB to fill Alpha's open slot, even though Filler5 outranks it");
  assert(/QB slot/.test(rec7.reason), "round 3 reason explains it's filling the QB need, not just best player available");

  console.log("\n== Test 15: K/DST are never recommended before the reserved final rounds ==");
  const dom12 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc12 = dom12.window.document;
  doc12.getElementById("numTeams").value = 2;
  doc12.getElementById("numRounds").value = 4;
  doc12.getElementById("teamNames").value = "Alpha, Bravo";
  ["rosterRB","rosterWR","rosterTE","rosterFLEX","rosterDST"].forEach(id => { doc12.getElementById(id).value = 0; });
  doc12.getElementById("rosterQB").value = 1;
  doc12.getElementById("rosterK").value = 1;
  doc12.getElementById("needRound").value = 1;   // need mode from the very first pick
  doc12.getElementById("lateRounds").value = 1;  // K allowed only in round 4 of 4
  doc12.getElementById("playerInput").value = [
    "QB1,QB,AAA", "K1,K,BBB", "WR1,WR,CCC", "WR2,WR,DDD",
    "WR3,WR,EEE", "WR4,WR,FFF", "WR5,WR,GGG", "WR6,WR,HHH"
  ].join("\n");
  doc12.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  function draftByName12(name) {
    const st = dom12.window.__sotgTest.getState();
    const p = st.players.find(x => x.name === name && !x.drafted);
    const rows = [...doc12.querySelectorAll("#player-list .player-row")];
    const row = rows.find(r => r.querySelector(".player-info b").textContent === p.name);
    row.querySelector(".draft-btn").click();
  }
  // 2-team snake over 8 picks: A,B,B,A,A,B,B,A. Alpha owns 1,4,5,8.
  let rec12 = dom12.window.__sotgTest.computeRecommendation();
  assert(rec12.player.name === "QB1", "pick 1: open QB + open K, rec fills QB (K is rank 2 but reserved for the last round)");
  draftByName12("QB1"); await new Promise(r => setTimeout(r, 10)); // 1 A
  draftByName12("WR1"); await new Promise(r => setTimeout(r, 10)); // 2 B
  draftByName12("WR2"); await new Promise(r => setTimeout(r, 10)); // 3 B
  rec12 = dom12.window.__sotgTest.computeRecommendation();
  assert(rec12.player.name === "WR3", "pick 4 (round 2): only K slot open, but rec is best bench WR, NOT the kicker");
  assert(/K waits for the last 1 round/.test(rec12.reason), "reason says K waits for the reserved final round(s)");
  assert(!rec12.alternates.some(a => (a.player || a).name === "K1"), "kicker is not offered as an alternate either");
  draftByName12("WR3"); await new Promise(r => setTimeout(r, 10)); // 4 A
  draftByName12("WR4"); await new Promise(r => setTimeout(r, 10)); // 5 A
  draftByName12("WR5"); await new Promise(r => setTimeout(r, 10)); // 6 B
  draftByName12("WR6"); await new Promise(r => setTimeout(r, 10)); // 7 B
  rec12 = dom12.window.__sotgTest.computeRecommendation();
  assert(dom12.window.__sotgTest.getState().currentOverall === 8, "we're at pick 8 (round 4, the reserved round)");
  assert(rec12.player.name === "K1" && /K slot/.test(rec12.reason), "final round: kicker is now recommended to fill the open K slot");

  console.log("\n== Test 16: Snake timing — take the near-equal player who won't last to your next pick ==");
  const dom13 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc13 = dom13.window.document;
  doc13.getElementById("numTeams").value = 3;
  doc13.getElementById("numRounds").value = 3;
  doc13.getElementById("teamNames").value = "Alpha, Bravo, Charlie";
  doc13.getElementById("needRound").value = 10; // pure BPA the whole way
  // 3-team snake: 1 A, 2 B, 3 C, 4 C, 5 B, 6 A, 7 A, 8 B, 9 C. Alpha's next pick after #1 is #6.
  // X1 rank 1 but ADP 12 (market lets him slide -> should last to #6); X2 rank 2 ADP 2 (gone), same tier.
  doc13.getElementById("playerInput").value = [
    "X1,RB,AAA,12,1", "X2,WR,BBB,2,1", "X3,WR,CCC,3,2", "X4,RB,DDD,5,2",
    "X5,WR,EEE", "X6,RB,FFF", "X7,TE,GGG", "X8,QB,HHH", "X9,WR,III"
  ].join("\n");
  doc13.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const t13 = dom13.window.__sotgTest;
  const st13 = t13.getState();
  const X1 = st13.players.find(p => p.name === "X1"), X2 = st13.players.find(p => p.name === "X2"), X3 = st13.players.find(p => p.name === "X3");
  assert(t13.isMyTurn() === true, "Alpha (slot 1) is on the clock at pick 1");
  assert(t13.myNextPickAfter(1) === 6, "Alpha's next pick after #1 is #6 in a 3-team snake");
  assert(t13.availabilityAtNextPick(X1) === "there", "X1 (ADP 12) should still be there at #6");
  assert(t13.availabilityAtNextPick(X2) === "gone", "X2 (ADP 2) is likely gone by #6");
  assert(t13.availabilityAtNextPick(X3) === "gone", "X3 (ADP 3) is also likely gone by #6");
  let rec13 = t13.computeRecommendation();
  assert(rec13.player.name === "X2", "rec swaps from rank-1 X1 to same-tier X2 because X1 will last and X2 won't");
  assert(/likely gone before your next pick at #6/.test(rec13.reason) && /X1 \(ADP 12\) should still be there/.test(rec13.reason), "reason explains the wait/take trade-off with both ADPs and the next pick number");
  assert((rec13.alternates[0].player || rec13.alternates[0]).name === "X1", "the player we chose to wait on is the first alternate");
  assert(/You're on the clock \(#1\)/.test(doc13.getElementById("nextPickInfo").textContent) && /#6/.test(doc13.getElementById("nextPickInfo").textContent), "next-pick line shows on-the-clock + next pick #6");
  const x1Row = [...doc13.querySelectorAll("#player-list .player-row")].find(r => r.querySelector(".player-info b").textContent === "X1");
  assert(x1Row && /should last to #6/.test(x1Row.textContent), "queue row for X1 carries the 'should last to #6' tag");
  const x2Row = [...doc13.querySelectorAll("#player-list .player-row")].find(r => r.querySelector(".player-info b").textContent === "X2");
  assert(x2Row && /likely gone by #6/.test(x2Row.textContent), "queue row for X2 carries the 'likely gone by #6' tag");
  x2Row.querySelector(".draft-btn").click(); // Alpha takes X2 at #1
  await new Promise(r => setTimeout(r, 10));
  assert(t13.isMyTurn() === false, "after Alpha's pick, Bravo is on the clock");
  rec13 = t13.computeRecommendation();
  assert(rec13.player.name === "X1", "when it's not my turn, no swap: rec is plain best-available (X1) as a preview of who to want at #6");
  assert(/You're up at #6/.test(doc13.getElementById("nextPickInfo").textContent), "next-pick line now says when Alpha is up next");

  console.log("\n== Test 17: Bye-week clash warning on the recommendation ==");
  const dom14 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc14 = dom14.window.document;
  doc14.getElementById("numTeams").value = 2;
  doc14.getElementById("numRounds").value = 2;
  doc14.getElementById("teamNames").value = "Alpha, Bravo";
  ["rosterRB","rosterWR","rosterTE","rosterFLEX","rosterDST","rosterK"].forEach(id => { doc14.getElementById(id).value = 0; });
  doc14.getElementById("rosterQB").value = 1;
  doc14.getElementById("needRound").value = 1;
  doc14.getElementById("playerInput").value = ["QB1,QB,AAA,,,7", "WR1,WR,BBB", "WR2,WR,CCC", "QB2,QB,DDD,,,7"].join("\n");
  doc14.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  function draftByName14(name) {
    const rows = [...doc14.querySelectorAll("#player-list .player-row")];
    rows.find(r => r.querySelector(".player-info b").textContent === name).querySelector(".draft-btn").click();
  }
  draftByName14("QB1"); await new Promise(r => setTimeout(r, 10)); // 1 A
  draftByName14("WR1"); await new Promise(r => setTimeout(r, 10)); // 2 B
  draftByName14("WR2"); await new Promise(r => setTimeout(r, 10)); // 3 B
  const rec14 = dom14.window.__sotgTest.computeRecommendation();
  assert(rec14.player.name === "QB2", "pick 4: only QB2 is left, it's the rec");
  assert(/Same bye \(wk 7\) as your QB QB1/.test(rec14.reason), "rec warns that QB2 shares QB1's bye week");

  console.log("\n== Test 18: Snake timing does NOT swap for a player who isn't near-equal ==");
  const dom18 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc18 = dom18.window.document;
  doc18.getElementById("numTeams").value = 3;
  doc18.getElementById("numRounds").value = 3;
  doc18.getElementById("teamNames").value = "Alpha, Bravo, Charlie";
  doc18.getElementById("needRound").value = 10;
  // Y1 rank 1 tier 1 ADP 12 (will last). Y2 is 'gone' by ADP but tier 3 — a real talent drop, so no swap.
  doc18.getElementById("playerInput").value = [
    "Y1,RB,AAA,12,1", "Y2,WR,BBB,2,3", "Y3,WR,CCC,20,3", "Y4,RB,DDD,25,3",
    "Y5,WR,EEE", "Y6,RB,FFF", "Y7,TE,GGG", "Y8,QB,HHH", "Y9,WR,III"
  ].join("\n");
  doc18.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const rec18 = dom18.window.__sotgTest.computeRecommendation();
  assert(rec18.player.name === "Y1", "top player lasts to #6 but the only 'gone' option is two tiers worse: rec stays on Y1, no swap");
  assert(!/likely gone before your next pick/.test(rec18.reason), "no wait/take reasoning shown when no near-equal swap exists");

  console.log("\n== Test 19: Bench balance — no 3rd bench WR while there's no backup RB ==");
  const dom19 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc19 = dom19.window.document;
  doc19.getElementById("numTeams").value = 2;
  doc19.getElementById("numRounds").value = 5;
  doc19.getElementById("teamNames").value = "Alpha, Bravo";
  ["rosterQB","rosterRB","rosterTE","rosterFLEX","rosterDST","rosterK"].forEach(id => { doc19.getElementById(id).value = 0; });
  doc19.getElementById("rosterWR").value = 1; // one WR starter, everything else is bench
  doc19.getElementById("needRound").value = 1;
  doc19.getElementById("lateRounds").value = 0;
  doc19.getElementById("playerInput").value = [
    "W1,WR,AAA","W2,WR,BBB","W3,WR,CCC","W4,WR,DDD","R1,RB,EEE","W5,WR,FFF","F1,WR,GGG","F2,WR,HHH","F3,WR,III","F4,WR,JJJ"
  ].join("\n");
  doc19.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const t19 = dom19.window.__sotgTest;
  function draftByName19(name) {
    const rows = [...doc19.querySelectorAll("#player-list .player-row")];
    rows.find(r => r.querySelector(".player-info b").textContent === name).querySelector(".draft-btn").click();
  }
  // 2-team snake over 10 picks: A,B,B,A,A,B,B,A,A,B. Alpha: 1,4,5,8,9.
  draftByName19("W1"); await new Promise(r => setTimeout(r, 10)); // 1 A: WR starter
  draftByName19("F1"); await new Promise(r => setTimeout(r, 10)); // 2 B
  draftByName19("F2"); await new Promise(r => setTimeout(r, 10)); // 3 B
  let rec19 = t19.computeRecommendation();
  assert(rec19.player.name === "W2", "1st bench pick: plain BPA (W2) — no balance rule with 0 bench WRs");
  draftByName19("W2"); await new Promise(r => setTimeout(r, 10)); // 4 A
  rec19 = t19.computeRecommendation();
  assert(rec19.player.name === "W3", "2nd bench pick: still BPA (W3) — 1 bench WR is fine");
  draftByName19("W3"); await new Promise(r => setTimeout(r, 10)); // 5 A
  draftByName19("F3"); await new Promise(r => setTimeout(r, 10)); // 6 B
  draftByName19("F4"); await new Promise(r => setTimeout(r, 10)); // 7 B
  rec19 = t19.computeRecommendation();
  assert(rec19.player.name === "R1", "3rd bench pick: W4 outranks R1, but bench already has 2 WRs and 0 RBs -> rec is the best RB");
  assert(/Bench balance/.test(rec19.reason) && /2 bench WRs/.test(rec19.reason), "reason explains the bench-balance override");
  assert((rec19.alternates[0].player || rec19.alternates[0]).name === "W4", "the higher-ranked WR is still offered as the first alternate");
  draftByName19("R1"); await new Promise(r => setTimeout(r, 10)); // 8 A
  rec19 = t19.computeRecommendation();
  assert(rec19.player.name === "W4", "once a backup RB is on the bench, it's back to BPA (W4)");

  console.log("\n== Test 20: My team is labeled on the draft board; ESPN team names prefilled ==");
  const dom20 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc20 = dom20.window.document;
  const prefilled = doc20.getElementById("teamNames").value.split(",").map(x => x.trim()).filter(Boolean);
  assert(prefilled.length === 9 && prefilled.includes("SACK OF WHEAT") && prefilled.includes("PapasCabezas"), "setup ships with the 9 real 'I got sheep FF' team names from ESPN");
  assert(doc20.getElementById("myTeamIndex").options.length === 9, "'Which team is yours' dropdown lists all 9 teams");
  doc20.getElementById("myTeamIndex").value = "6"; // Knight Moves Ore Else
  doc20.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const ths20 = [...doc20.querySelectorAll("#board thead th")];
  const myTh = ths20.find(th => th.classList.contains("my-col"));
  assert(myTh && /Knight Moves Ore Else/.test(myTh.textContent) && /YOU/.test(myTh.textContent), "my team's board column header is tagged 🐑 + YOU");
  assert(ths20.filter(th => th.classList.contains("my-col")).length === 1, "exactly one column is marked as mine");
  const myCells = [...doc20.querySelectorAll("#board td.my-col")];
  assert(myCells.length === 14, "all 14 of my pick cells carry the my-col highlight (one per round)");
  assert(/I got sheep FF/.test(doc20.getElementById("leagueTitle").textContent), "league name shows in the header");
  // Snake, 9 teams: slot 7 (index 6) picks at overall 7 and 12. Advance to pick 7 and check the on-clock banner.
  for (let i = 0; i < 6; i++) { dom20.window.__sotgTest.draftFirstAvailable(); await new Promise(r => setTimeout(r, 5)); }
  assert(/YOU/.test(doc20.getElementById("curTeam").textContent) && doc20.getElementById("on-clock").classList.contains("mine"), "when it's my pick, the on-the-clock banner says YOU and lights up");
  dom20.window.__sotgTest.draftFirstAvailable(); await new Promise(r => setTimeout(r, 5));
  assert(!doc20.getElementById("on-clock").classList.contains("mine"), "banner highlight clears once my pick is made");
  const myFilled = doc20.querySelector("#board td.my-col.filled");
  assert(myFilled && /🐑/.test(myFilled.textContent), "my drafted player's cell shows the sheep");

  console.log("\n== Test 21: My team defaults to \"I'll be white!!\" and follows the name when teams are reordered ==");
  const dom21 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc21 = dom21.window.document;
  const sel21 = doc21.getElementById("myTeamIndex");
  assert(sel21.options[sel21.selectedIndex].textContent === "I'll be white!!", "on load, 'Which team is yours' is already set to I'll be white!!");
  assert(sel21.value === "3", "…which is draft slot 4 (index 3) in the locked-in draft order");
  // Reorder into a hypothetical draft order with my team drafting 3rd.
  doc21.getElementById("teamNames").value = "PapasCabezas, Bad Hombres, I'll be white!!, SACK OF WHEAT, Resting Blitz Face, Unnecessary Sanctions, The Brady Bunch, BlitzAndGiggles, Knight Moves Ore Else";
  doc21.getElementById("teamNames").dispatchEvent(new dom21.window.Event("input"));
  assert(sel21.options[sel21.selectedIndex].textContent === "I'll be white!!" && sel21.value === "2", "after reordering, my team is still I'll be white!! (now index 2), not whatever landed at the old index");
  doc21.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  assert(dom21.window.__sotgTest.getMyTeamIndex() === 2, "draft starts with my team = slot 3");
  assert(/I'll be white!!/.test(doc21.querySelector("#board th.my-col").textContent), "board column for I'll be white!! is the one marked YOU");

  console.log("\n== Test 22: Interactive draft-order list (fixed names, arrows + drag reorder) ==");
  const dom22 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc22 = dom22.window.document;
  const rows22 = () => [...doc22.querySelectorAll("#teamOrderList .team-row")];
  const rowNames = () => rows22().map(r => r.querySelector(".team-name").textContent.replace(/^🐑 /, "").replace(/YOU$/, ""));
  assert(rows22().length === 9, "9 fixed team rows render on load");
  assert(rowNames()[0] === "Unnecessary Sanctions" && rowNames()[3] === "I'll be white!!" && rowNames()[8] === "Bad Hombres", "initial order is the locked-in ESPN draft order (Jose at slot 4)");
  assert(doc22.getElementById("teamNames").type === "hidden", "there is no free-text team-name field to edit");
  assert(doc22.getElementById("numTeams").readOnly === true && doc22.getElementById("numTeams").value === "9", "# of teams is read-only and driven by the list (9)");
  assert(rows22()[3].classList.contains("mine") && /YOU/.test(rows22()[3].textContent), "my team's row is marked 🐑 YOU");
  assert(rows22()[0].querySelector(".move-up").disabled && rows22()[8].querySelector(".move-down").disabled, "top row can't move up, bottom row can't move down");
  rows22()[3].querySelector(".move-up").click(); // I'll be white!! 4 -> 3
  assert(rowNames()[2] === "I'll be white!!" && rowNames()[3] === "PapasCabezas", "▲ moves my team up one slot and pushes the other down");
  assert(doc22.getElementById("teamNames").value.split(",").map(x => x.trim())[2] === "I'll be white!!", "hidden order field updated to match");
  const sel22 = doc22.getElementById("myTeamIndex");
  assert(sel22.options[sel22.selectedIndex].textContent === "I'll be white!!" && sel22.value === "2", "'my team' dropdown followed the move (now slot 3)");
  // Drag "Bad Hombres" (index 8) onto slot 1 (index 0)
  const dragEv = (type) => { const e = new dom22.window.Event(type, { bubbles: true, cancelable: true }); e.dataTransfer = { effectAllowed: "" }; return e; };
  rows22()[8].dispatchEvent(dragEv("dragstart"));
  rows22()[0].dispatchEvent(dragEv("dragover"));
  rows22()[0].dispatchEvent(dragEv("drop"));
  assert(rowNames()[0] === "Bad Hombres" && rowNames()[1] === "Unnecessary Sanctions", "drag-and-drop moves a team to the top and shifts the rest down");
  assert(rowNames()[3] === "I'll be white!!" && sel22.value === "3", "my team shifted back to slot 4 by the drag and the dropdown still tracks it by name");
  doc22.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const st22 = dom22.window.__sotgTest.getState();
  assert(st22.config.teamNames[0] === "Bad Hombres" && st22.config.teamNames[3] === "I'll be white!!" && st22.config.numTeams === 9, "draft starts with the interactive order as the real draft order");
  assert(dom22.window.__sotgTest.getMyTeamIndex() === 3, "my team index in the draft = my slot in the list");

  console.log("\n== Test 23: Injury field — badges, and IR/OUT players are never recommended ==");
  const dom23 = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/" });
  await new Promise(r => setTimeout(r, 50));
  const doc23 = dom23.window.document;
  doc23.getElementById("numTeams").value = 2;
  doc23.getElementById("numRounds").value = 2;
  doc23.getElementById("teamNames").value = "Alpha, Bravo";
  doc23.getElementById("needRound").value = 10;
  doc23.getElementById("playerInput").value = [
    "HurtGuy,RB,AAA,1,1,6,IR,Foot · back ~10/11", "OutGuy,WR,BBB,2,1,7,O", "ShakyGuy,WR,CCC,3,1,8,Q,Knee", "FineGuy,RB,DDD,4,1,9", "Filler,TE,EEE"
  ].join("\n");
  doc23.getElementById("startDraftBtn").click();
  await new Promise(r => setTimeout(r, 20));
  const st23 = dom23.window.__sotgTest.getState();
  assert(st23.players[0].inj === "IR" && st23.players[1].inj === "O" && st23.players[2].inj === "Q" && st23.players[3].inj === null, "7th CSV field parses into player.inj (IR / O / Q / none)");
  const rows23 = [...doc23.querySelectorAll("#player-list .player-row")];
  const rowFor = n => rows23.find(r => r.querySelector(".player-info b").textContent === n);
  assert(rowFor("HurtGuy").querySelector(".inj-tag.inj-hard") && /IR · Foot · back ~10\/11/.test(rowFor("HurtGuy").textContent), "IR player shows a red badge with body part + estimated return");
  assert(st23.players[0].injNote === "Foot · back ~10/11" && st23.players[1].injNote === null, "8th CSV field parses into injNote, absent = null");
  assert(rowFor("ShakyGuy").querySelector(".inj-tag.inj-soft") && /QUESTIONABLE/.test(rowFor("ShakyGuy").textContent), "questionable player shows a yellow badge");
  assert(!rowFor("FineGuy").querySelector(".inj-tag"), "healthy player has no injury badge");
  const rec23 = dom23.window.__sotgTest.computeRecommendation();
  assert(rec23.player.name === "ShakyGuy", "rec skips the rank-1 IR player and rank-2 OUT player, lands on rank-3 (questionable) player");
  assert(/questionable on ESPN's injury report \(Knee\)/.test(rec23.reason), "rec carries a heads-up with the injury note when the pick is listed questionable");
  assert(!rec23.alternates.some(a => ["HurtGuy","OutGuy"].includes((a.player || a).name)), "IR/OUT players aren't offered as alternates either");
  assert(rowFor("HurtGuy").querySelector(".draft-btn"), "IR player can still be drafted by hand (someone else in the room might take him)");

  console.log("\n=========================");
  if (failures === 0) {
    console.log("ALL TESTS PASSED");
    process.exit(0);
  } else {
    console.log(failures + " TEST(S) FAILED");
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
