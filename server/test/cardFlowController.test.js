const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeCompletionRoutes,
  calibrateOpeningHand,
  canFollowWithoutRepeats,
  getPairRanks,
  reserveJokersInDeck,
  selectHumanDeckCard,
} = require("../src/services/cardFlowController");

const suits = ["S", "H", "D", "C"];
const card = (rank, suit = "S", color = "black") => ({ rank, suit, color });
const cards = (rank, count) => Array.from({ length: count }, (_, index) => (
  card(rank, suits[index % suits.length], index % 2 ? "red" : "black")
));

test("completion routes report zero for an exact natural 4-3-3-1 hand", () => {
  const hand = [
    ...cards("A", 4), ...cards("K", 3), ...cards("Q", 3), card("2"),
  ];
  const result = analyzeCompletionRoutes(hand, []);
  assert.equal(result.structuralDistance, 0);
  assert.equal(result.predictedRemainingPicks, 0);
  assert.equal(result.reachable, true);
});

test("future jokers are included in the predicted completion route", () => {
  const hand = [...cards("A", 3), ...cards("K", 2), ...cards("Q", 2), card("2"), card("7"), card("8")];
  const available = [...cards("A", 1), ...cards("K", 1), ...cards("Q", 1), card("JOKER", "JR", "red")];
  const natural = analyzeCompletionRoutes(hand, available);
  const assisted = analyzeCompletionRoutes(hand, available, { futureJokers: 1 });
  assert.ok(assisted.structuralDistance <= natural.structuralDistance);
  assert.ok(assisted.neededRanks.includes("JOKER"));
});

test("opening calibration creates exactly one or two natural pairs", () => {
  for (const pairTarget of [1, 2]) {
    const humanId = "human";
    const hand = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
      .map((rank, index) => card(rank, suits[index % 4]));
    const deck = [
      card("A", "H"), card("2", "H"), card("3", "H"), card("4", "H"),
      card("J", "S"), card("Q", "S"), card("K", "S"), card("JOKER", "JR", "red"),
    ];
    const state = { playerCards: { [humanId]: hand }, deck };
    const before = [...hand, ...deck].map((item) => `${item.rank}|${item.suit}|${item.color}`).sort();
    calibrateOpeningHand(state, humanId, { pairTarget, random: () => 0 });
    const after = [...state.playerCards[humanId], ...state.deck]
      .map((item) => `${item.rank}|${item.suit}|${item.color}`).sort();
    assert.equal(getPairRanks(state.playerCards[humanId]).length, pairTarget);
    assert.deepEqual(after, before);
    assert.equal(state.playerCards[humanId].some((item) => item.rank === "JOKER"), false);
  }
});

test("controlled deck selection avoids the previous rank and moves one physical card", () => {
  const deck = [card("A", "S"), card("K", "S"), card("A", "H"), card("Q", "S")];
  const before = deck.map((item) => `${item.rank}|${item.suit}`).sort();
  const selected = selectHumanDeckCard(deck, { helpfulRanks: ["A", "K"] }, {
    wantsHelp: true,
    lastRank: "A",
    random: () => 0,
  });
  assert.equal(selected.rank, "K");
  assert.equal(deck[deck.length - 1], selected);
  assert.deepEqual(deck.map((item) => `${item.rank}|${item.suit}`).sort(), before);
});

test("joker-assisted rounds reserve the requested physical jokers in the deck", () => {
  const state = {
    playerCards: {
      human: [...cards("A", 2)],
      bot: [card("JOKER", "JR", "red"), card("JOKER", "JB", "black"), card("K")],
    },
    deck: [card("2"), card("3")],
  };
  const before = [...state.playerCards.human, ...state.playerCards.bot, ...state.deck]
    .map((item) => `${item.rank}|${item.suit}|${item.color}`).sort();
  assert.equal(reserveJokersInDeck(state, "human", 2), 2);
  assert.equal(state.deck.filter((item) => item.rank === "JOKER").length, 2);
  const after = [...state.playerCards.human, ...state.playerCards.bot, ...state.deck]
    .map((item) => `${item.rank}|${item.suit}|${item.color}`).sort();
  assert.deepEqual(after, before);
});

test("rank-sequence feasibility accounts for the previously delivered rank", () => {
  assert.equal(canFollowWithoutRepeats([card("A"), card("K"), card("A", "H")], "K"), true);
  assert.equal(canFollowWithoutRepeats([card("A"), card("A", "H")], "A"), false);
});
