const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getHousePressure,
  chooseDiscardIndex,
  shouldBotTakeLaid,
  biasDeckForBotDraw,
  biasBotOpeningHand,
  estimateHandDistance,
  analyzeWinningHand,
  buildHouseControlProfile,
  parseLedger,
  recordHouseBotOutcome,
  planManagedBotLeave,
  recordManagedBotLeave,
  decideScriptedOutcome,
  computeScriptedBotWinRate,
  pressureForScriptedOutcome,
  clampPressureAfterSixGames,
  generateGuaranteedWinSchedule,
  getGameBlockContext,
  evaluateGameBlockForce,
  isValidGuaranteedWinSchedule,
  weakenHumanOpeningHand,
  biasDeckAgainstPlayer,
  getRankCounts,
  cardKey,
  getMinPicksBeforeWin,
  getHumanLikeTurnDelayMs,
  getManagedBonusIntroOutcome,
  hasMetMinPlayBeforeWin,
  hasMetSoftHelpPlayThreshold,
  BOT_WIN_BLOCK_SIZE,
  GUARANTEED_BOT_WINS_PER_BLOCK,
  GUARANTEED_HUMAN_WINS_PER_BLOCK,
  VARIABLE_SCHEDULE_VERSION,
  VARIABLE_BLOCK_SIZES,
  MIN_PICKS_BEFORE_WIN,
  MAX_PICKS_BEFORE_WIN,
  MANAGED_BOT_SLOW_TURN_MIN_MS,
  MANAGED_BOT_SLOW_TURN_MAX_MS,
} = require("../src/services/houseBotController");

const card = (rank, suit = "♠") => ({
  rank,
  suit,
  color: suit === "♥" || suit === "♦" ? "#e74c3c" : "#111",
});

const assertValidVariableSchedule = (schedule) => {
  assert.equal(schedule.scheduleVersion, VARIABLE_SCHEDULE_VERSION);
  assert.deepEqual(
    [...schedule.scheduleBlockSizes].sort((left, right) => left - right),
    VARIABLE_BLOCK_SIZES
  );
  assert.equal(schedule.guaranteedBotWinSlots.length, 9);
  assert.equal(schedule.guaranteedHumanWinSlots.length, 3);
  assert.equal(
    new Set([...schedule.guaranteedBotWinSlots, ...schedule.guaranteedHumanWinSlots]).size,
    12
  );
  assert.equal(isValidGuaranteedWinSchedule(schedule), true);
};

test("getHousePressure softens new players and reacts to rolling WR", () => {
  assert.equal(
    getHousePressure({ games: 0, botWins: 0, outcomes: [] }, { gamesPlayed: 1 }),
    "give"
  );
  assert.equal(
    getHousePressure({ outcomes: [true, true] }, { gamesPlayed: 10, targetWinRate: 0.7 }),
    "fair"
  );
  // Bot only won 2/10 → well below 70% → take
  assert.equal(
    getHousePressure(
      { outcomes: [true, true, false, false, false, false, false, false, false, false] },
      { gamesPlayed: 50, targetWinRate: 0.7 }
    ),
    "take"
  );
  // Bot won 9/10 → above target → give
  assert.equal(
    getHousePressure(
      { outcomes: [true, true, true, true, true, true, true, true, true, false] },
      { gamesPlayed: 50, targetWinRate: 0.7 }
    ),
    "give"
  );
});

test("perfect-info discard avoids feeding human triple when alternative exists", () => {
  const botHand = [
    card("2"), card("2"), card("2"),
    card("5"), card("5"),
    card("9"),
    card("K"), card("K"),
    card("3"), card("7"),
  ];
  // Human collecting 9s
  const humanHand = [
    card("9"), card("9"), card("9"),
    card("A"), card("A"),
    card("4"), card("4"),
    card("6"), card("8"), card("J"),
  ];

  const dumpIndex = chooseDiscardIndex(botHand, humanHand, "take");
  assert.notEqual(botHand[dumpIndex].rank, "9");
  // Should dump a cold singleton (3 or 7), not a pair/triple
  assert.ok(["3", "7"].includes(botHand[dumpIndex].rank));
});

test("shouldBotTakeLaid never picks a cold rank (avoids pick→re-lay)", () => {
  const botHand = [
    card("2"), card("5"), card("7"), card("8"), card("10"),
    card("J"), card("Q"), card("K"), card("A"), card("3"),
  ];
  const humanHand = [
    card("9"), card("9"), card("9"),
    card("4"), card("4"),
    card("6"), card("6"),
    card("2"), card("5"), card("7"),
  ];
  const top = card("9", "♥");
  // Bot has zero 9s — must not pick even under take
  assert.equal(shouldBotTakeLaid(botHand, humanHand, top, "take", () => 0), false);
  assert.equal(shouldBotTakeLaid(botHand, humanHand, top, "give", () => 0.99), false);
});

test("shouldBotTakeLaid can take when bot already holds the rank", () => {
  const botHand = [
    card("9"), card("5"), card("7"), card("8"), card("10"),
    card("J"), card("Q"), card("K"), card("A"), card("3"),
  ];
  const humanHand = [
    card("9"), card("9"),
    card("4"), card("4"),
    card("6"), card("6"),
    card("2"), card("5"), card("7"), card("8"),
  ];
  assert.equal(shouldBotTakeLaid(botHand, humanHand, card("9", "♥"), "take", () => 0), true);
});

test("chooseDiscardIndex never discards the just-picked card when alternatives exist", () => {
  const botHand = [
    card("9", "♥"), // just picked
    card("2"), card("2"), card("2"),
    card("5"), card("5"),
    card("K"), card("K"),
    card("3"), card("7"), card("8"),
  ];
  const idx = chooseDiscardIndex(botHand, [], "fair", {
    excludeCardKeys: [cardKey(card("9", "♥"))],
  });
  assert.notEqual(botHand[idx].rank, "9");
});

test("decideScriptedOutcome respects legacy numeric target rate", () => {
  assert.equal(decideScriptedOutcome(0.7, () => 0.69).botWins, true);
  assert.equal(decideScriptedOutcome(0.7, () => 0.71).botWins, false);
  assert.equal(decideScriptedOutcome(0.7, () => 0.69).scriptedWinner, "bot");
  assert.equal(decideScriptedOutcome(0.7, () => 0.71).scriptedWinner, "human");
});

test("computeScriptedBotWinRate uses games, wins, balance, and fee", () => {
  const newbieLow = computeScriptedBotWinRate({
    gamesPlayed: 2,
    wins: 0,
    balance: 10,
    entryFee: 10,
  });
  const veteranWhale = computeScriptedBotWinRate({
    gamesPlayed: 80,
    wins: 45,
    balance: 800,
    entryFee: 100,
  });
  const brokeSkilled = computeScriptedBotWinRate({
    gamesPlayed: 40,
    wins: 22,
    balance: 5,
    entryFee: 10,
  });

  // New low-balance player should see softer house than rich high-fee veteran
  assert.ok(newbieLow < veteranWhale, `expected ${newbieLow} < ${veteranWhale}`);
  // Higher games+wins raises rate vs pure newbie
  const mid = computeScriptedBotWinRate({
    gamesPlayed: 40,
    wins: 20,
    balance: 100,
    entryFee: 10,
  });
  assert.ok(mid > newbieLow, `expected mid ${mid} > newbie ${newbieLow}`);
  // Low bankroll softens vs same skill with deep stack
  const deepStack = computeScriptedBotWinRate({
    gamesPlayed: 40,
    wins: 22,
    balance: 400,
    entryFee: 10,
  });
  assert.ok(brokeSkilled < deepStack, `expected broke ${brokeSkilled} < deep ${deepStack}`);
  // Higher fee raises house edge (use mid profiles so neither hits the 0.92 cap)
  const lowFee = computeScriptedBotWinRate({
    gamesPlayed: 5,
    wins: 1,
    balance: 100,
    entryFee: 10,
  });
  const highFee = computeScriptedBotWinRate({
    gamesPlayed: 5,
    wins: 1,
    balance: 100,
    entryFee: 100,
  });
  assert.ok(highFee > lowFee, `expected fee boost ${highFee} > ${lowFee}`);
  assert.ok(highFee < 0.92, `highFee should be under cap for this case, got ${highFee}`);

  // High fee with thin bankroll still softens vs deep stack same fee
  const allInHighFee = computeScriptedBotWinRate({
    gamesPlayed: 5,
    wins: 1,
    balance: 50,
    entryFee: 100,
  });
  const deepHighFee = computeScriptedBotWinRate({
    gamesPlayed: 5,
    wins: 1,
    balance: 2000,
    entryFee: 100,
  });
  assert.ok(allInHighFee < deepHighFee, `expected thin ${allInHighFee} < deep ${deepHighFee}`);
});

test("decideScriptedOutcome context records factors", () => {
  const result = decideScriptedOutcome({
    gamesPlayed: 25,
    wins: 10,
    balance: 120,
    entryFee: 20,
  }, () => 0.99);
  assert.equal(result.botWins, false);
  assert.equal(result.scriptedWinner, "human");
  assert.ok(result.botWinProbability >= 0.68 && result.botWinProbability <= 0.92);
  assert.equal(result.factors.gamesPlayed, 25);
  assert.equal(result.factors.wins, 10);
  assert.equal(result.factors.balance, 120);
  assert.equal(result.factors.entryFee, 20);
});

test("pressureForScriptedOutcome maps bot/human scripts (take/give/fair types)", () => {
  assert.equal(pressureForScriptedOutcome(true, "give"), "take");
  assert.equal(pressureForScriptedOutcome(true, "take"), "take");
  assert.equal(pressureForScriptedOutcome(true, "fair"), "take");
  assert.equal(pressureForScriptedOutcome(false, "take"), "give");
  assert.equal(pressureForScriptedOutcome(false, "fair"), "give");
});

test("after 6 room games pressure is only fair or take (never give)", () => {
  assert.equal(clampPressureAfterSixGames("give", 6, true), "fair");
  assert.equal(clampPressureAfterSixGames("give", 6, false), "fair");
  assert.equal(clampPressureAfterSixGames("fair", 6, true), "fair");
  assert.equal(clampPressureAfterSixGames("take", 6, true), "take");
  assert.equal(clampPressureAfterSixGames("give", 5, true), "give");

  assert.equal(pressureForScriptedOutcome(true, "fair", 6), "take");
  assert.equal(pressureForScriptedOutcome(false, "fair", 6), "fair");
  assert.equal(pressureForScriptedOutcome(false, "fair", 2), "give");

  const lateAhead = getHousePressure(
    { outcomes: [true, true, true, true, true, true] },
    { gamesPlayed: 20, roomGamesPlayed: 6, targetWinRate: 0.5 }
  );
  assert.notEqual(lateAhead, "give");
  assert.ok(lateAhead === "fair" || lateAhead === "take");
});

test("variable cycles contain shuffled 3/4/5 blocks with nine bot and three human slots", () => {
  assert.equal(BOT_WIN_BLOCK_SIZE, 12);
  assert.equal(GUARANTEED_BOT_WINS_PER_BLOCK, 9);
  assert.equal(GUARANTEED_HUMAN_WINS_PER_BLOCK, 3);
  for (let i = 0; i < 40; i += 1) {
    const schedule = generateGuaranteedWinSchedule();
    assertValidVariableSchedule(schedule);
    let offset = 0;
    schedule.scheduleBlockSizes.forEach((size) => {
      assert.equal(
        schedule.guaranteedHumanWinSlots.filter((slot) => slot > offset && slot <= offset + size).length,
        1
      );
      offset += size;
    });
    assert.ok(schedule.guaranteedHumanWinSlots.every((slot, index, slots) => (
      index === 0 || slot - slots[index - 1] > 1
    )));
  }
});

test("each variable cycle designates one persisted human slot for one or two joker assists", () => {
  for (let index = 0; index < 20; index += 1) {
    const schedule = generateGuaranteedWinSchedule();
    assert.ok(schedule.guaranteedHumanWinSlots.includes(schedule.jokerHumanWinSlot));
    assert.ok([1, 2].includes(schedule.jokerAssistCount));
    const outcome = decideScriptedOutcome({
      gamesPlayed: 12,
      totalGames: schedule.jokerHumanWinSlot - 1,
      blockPosition: schedule.jokerHumanWinSlot,
      ...schedule,
    });
    assert.equal(outcome.scriptedWinner, "human");
    assert.equal(outcome.jokerAssisted, true);
    assert.equal(outcome.jokerAssistCount, schedule.jokerAssistCount);
  }
});

test("cycle generation prevents a human slot at a human-ended cycle boundary", () => {
  const schedule = generateGuaranteedWinSchedule(() => 0, { previousCycleEndedWithHuman: true });
  assertValidVariableSchedule(schedule);
  assert.equal(schedule.guaranteedHumanWinSlots.includes(1), false);
});

test("all variable-cycle positions force nine bot scripts and three human scripts", () => {
  const schedule = generateGuaranteedWinSchedule(() => 0.4);
  const context = {
    gamesPlayed: 10,
    wins: 3,
    balance: 50,
    entryFee: 10,
    blockNumber: 1,
    ...schedule,
  };

  for (const position of context.guaranteedBotWinSlots) {
    const botRound = decideScriptedOutcome({ ...context, blockPosition: position }, () => 0.99);
    assert.equal(botRound.botWins, true);
    assert.equal(botRound.forced, true);
    assert.equal(botRound.forceReason, "scheduled-bot-variable-3-5");
  }

  for (const position of context.guaranteedHumanWinSlots) {
    const humanRound = decideScriptedOutcome({ ...context, blockPosition: position }, () => 0);
    assert.equal(humanRound.botWins, false);
    assert.equal(humanRound.scriptedWinner, "human");
    assert.equal(humanRound.forced, true);
    assert.equal(humanRound.forceReason, "scheduled-human-variable-3-5");
  }
});

test("game block context advances through 12-game variable cycles", () => {
  const schedule = generateGuaranteedWinSchedule(() => 0.4);
  assert.deepEqual(getGameBlockContext(0), { blockNumber: 1, blockPosition: 1 });
  assert.deepEqual(getGameBlockContext(11), { blockNumber: 1, blockPosition: 12 });
  assert.deepEqual(getGameBlockContext(12), { blockNumber: 2, blockPosition: 1 });
  assert.deepEqual(getGameBlockContext(17), { blockNumber: 2, blockPosition: 6 });
  assert.equal(evaluateGameBlockForce({
    ...schedule,
    blockPosition: schedule.guaranteedHumanWinSlots[0],
  }).forceReason, "scheduled-human-variable-3-5");
  assert.equal(evaluateGameBlockForce({
    ...schedule,
    blockPosition: schedule.guaranteedBotWinSlots[0],
  }).forceReason, "scheduled-bot-variable-3-5");
});

test("new and low-balance players still face high bot script rate", () => {
  const rate = computeScriptedBotWinRate({
    gamesPlayed: 0,
    wins: 0,
    balance: 20,
    entryFee: 10,
  });
  assert.ok(rate >= 0.68, `expected >= 0.68, got ${rate}`);
  assert.ok(rate <= 0.92);
});

test("higher lifetime withdrawals raise bot win probability", () => {
  const base = {
    gamesPlayed: 20,
    wins: 8,
    balance: 100,
    entryFee: 20,
    totalWithdrawn: 0,
  };
  const lowCash = computeScriptedBotWinRate(base);
  const highCash = computeScriptedBotWinRate({ ...base, totalWithdrawn: 400 });
  assert.ok(
    highCash > lowCash,
    `expected high withdrawer ${highCash} > low ${lowCash}`
  );
});

test("weakenHumanOpeningHand breaks pairs into cold singletons", () => {
  const humanId = "human-1";
  const hand = [
    card("9"), card("9"), card("9"),
    card("K"), card("K"),
    card("2"), card("3"), card("4"), card("5"), card("6"),
  ];
  const deck = [
    card("A"), card("7"), card("8"), card("10"), card("J"), card("Q"),
    card("2", "♥"), card("3", "♥"),
  ];
  const state = { playerCards: { [humanId]: hand }, deck };
  weakenHumanOpeningHand(state, humanId, { maxSwaps: 6 });
  const counts = getRankCounts(state.playerCards[humanId], false);
  const multi = Object.values(counts).filter((n) => n >= 2).length;
  assert.ok(multi <= 1, `expected mostly singletons, multi-groups=${multi}`);
  assert.equal(analyzeWinningHand(state.playerCards[humanId]).isWinning, false);
});

test("biasDeckAgainstPlayer prefers cold ranks for the human", () => {
  const hand = [card("9"), card("9"), card("K"), card("2")];
  const deck = [card("9", "♥"), card("A"), card("K", "♥"), card("7")];
  assert.equal(biasDeckAgainstPlayer(deck, hand), true);
  assert.ok(["A", "7"].includes(deck[deck.length - 1].rank));
});

test("shouldBotTakeLaid always takes self double upgrades", () => {
  const botHand = [
    card("9"), card("9"),
    card("2"), card("3"), card("4"), card("5"), card("6"), card("7"), card("8"), card("10"),
  ];
  assert.equal(
    shouldBotTakeLaid(botHand, [], card("9", "♦"), "give", () => 0),
    true
  );
});

test("biasDeckForBotDraw only reorders under take (or rare fair)", () => {
  const botHand = [card("9"), card("9"), card("2"), card("3"), card("4"), card("5"), card("6"), card("7"), card("8"), card("10")];
  const humanHand = [card("A"), card("K"), card("Q"), card("J"), card("2"), card("3"), card("4"), card("5"), card("6"), card("7")];
  const deck = [card("A"), card("K"), card("Q"), card("9", "♥"), card("2")];

  const giveDeck = deck.map((c) => ({ ...c }));
  assert.equal(biasDeckForBotDraw(giveDeck, botHand, humanHand, "give"), false);

  const takeDeck = deck.map((c) => ({ ...c }));
  const applied = biasDeckForBotDraw(takeDeck, botHand, humanHand, "take");
  assert.equal(applied, true);
  assert.equal(takeDeck[takeDeck.length - 1].rank, "9");
});

test("biasBotOpeningHand under take builds toward pairs without finishing win", () => {
  const botId = "botgamer:managed:1";
  const humanId = "human-1";
  // Bot: mostly singletons + one pair of 5s; deck has more 5s
  const hand = [
    card("5"), card("5"),
    card("2"), card("3"), card("4"), card("6"), card("7"), card("8"), card("9"), card("10"),
  ];
  const deck = [
    card("5", "♥"), card("5", "♦"),
    card("A"), card("K"), card("Q"), card("J"),
  ];
  const state = {
    playerCards: {
      [botId]: hand,
      [humanId]: [card("2"), card("2"), card("3"), card("3"), card("4"), card("4"), card("6"), card("7"), card("8"), card("9")],
    },
    deck,
  };

  biasBotOpeningHand(state, botId, { pressure: "take", humanId, random: () => 0 });
  const counts = state.playerCards[botId].reduce((acc, c) => {
    if (c.rank !== "JOKER") acc[c.rank] = (acc[c.rank] || 0) + 1;
    return acc;
  }, {});
  assert.ok(counts["5"] >= 3);
  assert.equal(analyzeWinningHand(state.playerCards[botId]).isWinning, false);
});

test("estimateHandDistance is zero for a winning pattern", () => {
  const winning = [
    card("A"), card("A"), card("A"), card("A"),
    card("K"), card("K"), card("K"),
    card("Q"), card("Q"), card("Q"),
    card("2"),
  ];
  assert.equal(estimateHandDistance(winning), 0);
  assert.equal(analyzeWinningHand(winning).isWinning, true);
});

test("buildHouseControlProfile embeds pressure", () => {
  const profile = buildHouseControlProfile({
    difficulty: { targetBotWinRate: 0.7, strength: 0.5, gamesPlayed: 20 },
    ledger: { outcomes: [false, false, false, false, false, true] },
    gamesPlayed: 20,
  });
  assert.equal(profile.targetWinRate, 0.7);
  assert.equal(profile.pressure, "take");
});

test("parseLedger is resilient", () => {
  assert.deepEqual(parseLedger(null).outcomes, []);
  assert.equal(parseLedger("{not-json").games, 0);
  const parsed = parseLedger(JSON.stringify({ outcomes: [true, false, true] }));
  assert.equal(parsed.botWins, 2);
  assert.equal(parsed.botLosses, 1);
  assert.equal(parsed.totalGames, 3);
  assert.equal(parsed.blockNumber, 1);
  assert.equal(parsed.blockPosition, 4);
  assertValidVariableSchedule(parsed);
});

test("legacy fixed ledgers migrate their game count into the variable 12-game cycle", () => {
  const parsed = parseLedger(JSON.stringify({
    games: 17,
    botWins: 12,
    botLosses: 5,
    outcomes: Array(17).fill(true),
    blockNumber: 4,
    blockPosition: 3,
    guaranteedBotWinSlots: [1, 2, 3, 5],
    guaranteedHumanWinSlots: [4],
    consecutiveHumanWins: 3,
    allowedHumanStreak: 5,
  }));
  assert.equal(parsed.totalGames, 17);
  assert.equal(parsed.blockNumber, 2);
  assert.equal(parsed.blockPosition, 6);
  assertValidVariableSchedule(parsed);
  assert.equal(parsed.guaranteedHumanWinSlots.includes(1), false);
  assert.equal(parsed.consecutiveHumanWins, undefined);
});

test("overlapping bot and human slots are invalidated and regenerated", () => {
  const parsed = parseLedger(JSON.stringify({
    totalGames: 2,
    blockNumber: 1,
    scheduleVersion: VARIABLE_SCHEDULE_VERSION,
    scheduleBlockSizes: [3, 4, 5],
    guaranteedBotWinSlots: [2, 2, 2, 2],
    guaranteedHumanWinSlots: [2],
  }));
  assert.equal(parsed.blockPosition, 3);
  assertValidVariableSchedule(parsed);
});

test("recordHouseBotOutcome advances cycles and rolls a fresh variable schedule", async () => {
  const currentSchedule = generateGuaranteedWinSchedule(() => 0.4);
  let stored = JSON.stringify({
    games: 11,
    totalGames: 11,
    botWins: 8,
    botLosses: 3,
    outcomes: [true, true, false, true, true, false, true, true, true, false, true],
    blockNumber: 1,
    blockPosition: 12,
    ...currentSchedule,
  });
  const redisClient = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
  };

  const next = await recordHouseBotOutcome(redisClient, "user-1", true);
  assert.equal(next.totalGames, 12);
  assert.equal(next.blockNumber, 2);
  assert.equal(next.blockPosition, 1);
  assertValidVariableSchedule(next);
  if (currentSchedule.guaranteedHumanWinSlots.includes(12)) {
    assert.equal(next.guaranteedHumanWinSlots.includes(1), false);
  }
});

test("managed turn delay has an eight-percent 10-15 second branch", () => {
  const slow = getHumanLikeTurnDelayMs(() => 0.079999);
  assert.ok(slow >= MANAGED_BOT_SLOW_TURN_MIN_MS);
  assert.ok(slow <= MANAGED_BOT_SLOW_TURN_MAX_MS);
  assert.ok(getHumanLikeTurnDelayMs(() => 0.08) < MANAGED_BOT_SLOW_TURN_MIN_MS);
});

test("managed bonus introduction scripts human, human, bot before normal scheduling", () => {
  assert.deepEqual(getManagedBonusIntroOutcome(true, 0), {
    stage: 1, botWins: false, scriptedWinner: "human",
  });
  assert.deepEqual(getManagedBonusIntroOutcome(true, 1), {
    stage: 2, botWins: false, scriptedWinner: "human",
  });
  assert.deepEqual(getManagedBonusIntroOutcome(true, 2), {
    stage: 3, botWins: true, scriptedWinner: "bot",
  });
  assert.equal(getManagedBonusIntroOutcome(true, 3), null);
  assert.equal(getManagedBonusIntroOutcome(false, 0), null);
});

test("managed leave planning persists one target and one use per 12-game cycle", async () => {
  let stored = null;
  const redisClient = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
  };
  const ledger = parseLedger(null);
  const planned = await planManagedBotLeave(redisClient, "leave-user", ledger, true, () => 0);
  assert.equal(planned.ledger.leaveTargetPosition, 1);
  assert.equal(planned.shouldLeaveThisRound, true);

  await recordManagedBotLeave(redisClient, "leave-user");
  const used = await planManagedBotLeave(redisClient, "leave-user", JSON.parse(stored), true, () => 0);
  assert.equal(used.shouldLeaveThisRound, false);
  assert.equal(used.ledger.leaveUsedBlockNumber, 1);
});

test("getMinPicksBeforeWin stays in the configured managed-play window", () => {
  for (let i = 0; i < 20; i += 1) {
    const value = getMinPicksBeforeWin();
    assert.ok(value >= MIN_PICKS_BEFORE_WIN);
    assert.ok(value <= MAX_PICKS_BEFORE_WIN);
  }
  assert.equal(getMinPicksBeforeWin(() => MIN_PICKS_BEFORE_WIN), MIN_PICKS_BEFORE_WIN);
  assert.equal(getMinPicksBeforeWin(() => MAX_PICKS_BEFORE_WIN), MAX_PICKS_BEFORE_WIN);
});

test("hasMetMinPlayBeforeWin blocks early finishes and allows after enough picks", () => {
  assert.equal(hasMetMinPlayBeforeWin({ picks: 0, lays: 0 }, 5), false);
  assert.equal(hasMetMinPlayBeforeWin({ picks: 4, lays: 4 }, 5), false);
  // Declare-win replaces the final lay, so lays may trail picks by one.
  assert.equal(hasMetMinPlayBeforeWin({ picks: 5, lays: 4 }, 5), true);
  assert.equal(hasMetMinPlayBeforeWin({ picks: 5, lays: 5 }, 5), true);
  assert.equal(hasMetMinPlayBeforeWin({ picks: 6, lays: 3 }, 5), false);
});

test("hasMetSoftHelpPlayThreshold starts help mid-window, not on the first draws", () => {
  assert.equal(hasMetSoftHelpPlayThreshold({ picks: 0 }, 6), false);
  assert.equal(hasMetSoftHelpPlayThreshold({ picks: 1 }, 6), false);
  assert.equal(hasMetSoftHelpPlayThreshold({ picks: 3 }, 6), true);
  assert.equal(hasMetSoftHelpPlayThreshold({ picks: 2 }, 4), true);
});

test("managed bot min-play window is 5–8 picks", () => {
  assert.equal(MIN_PICKS_BEFORE_WIN, 5);
  assert.equal(MAX_PICKS_BEFORE_WIN, 8);
});
