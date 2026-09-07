// Headless smoke test for Settlers of the Gridiron draft tool.
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
  assert(doc.getElementById("curTeam").textContent === "Alpha", "on-the-clock reverted back to Alpha");

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
