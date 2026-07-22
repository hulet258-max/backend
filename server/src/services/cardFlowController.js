const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const TARGET_SIZES = [4, 3, 3, 1];

const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";

const rankCounts = (cards = [], includeJokers = false) => cards.reduce((counts, card) => {
  const rank = String(card?.rank || "");
  if (!rank || (!includeJokers && isJoker(card))) return counts;
  counts[rank] = (counts[rank] || 0) + 1;
  return counts;
}, {});

const randomIndex = (length, random = Math.random) => (
  Math.max(0, Math.min(length - 1, Math.floor(random() * length)))
);

const shuffled = (values, random = Math.random) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const picked = randomIndex(index + 1, random);
    [result[index], result[picked]] = [result[picked], result[index]];
  }
  return result;
};

const countRequiredSeparators = (neededRanks = [], previousRank = null) => {
  const counts = rankCounts(neededRanks.map((rank) => ({ rank })), true);
  let lastRank = previousRank ? String(previousRank) : null;
  let separators = 0;
  let remaining = neededRanks.length;
  while (remaining > 0) {
    const candidates = Object.entries(counts)
      .filter(([rank, count]) => count > 0 && rank !== lastRank)
      .sort((left, right) => right[1] - left[1]);
    if (!candidates.length) {
      separators += 1;
      lastRank = null;
      continue;
    }
    const rank = candidates[0][0];
    counts[rank] -= 1;
    remaining -= 1;
    lastRank = rank;
  }
  return separators;
};

const enumerateTargets = () => {
  const targets = [];
  for (const fourRank of RANKS) {
    const afterFour = RANKS.filter((rank) => rank !== fourRank);
    for (let left = 0; left < afterFour.length; left += 1) {
      for (let right = left + 1; right < afterFour.length; right += 1) {
        const threeRanks = [afterFour[left], afterFour[right]];
        for (const oneRank of afterFour) {
          if (threeRanks.includes(oneRank)) continue;
          targets.push({
            [fourRank]: 4,
            [threeRanks[0]]: 3,
            [threeRanks[1]]: 3,
            [oneRank]: 1,
          });
        }
      }
    }
  }
  return targets;
};

const COMPLETION_TARGETS = enumerateTargets();

const buildRoute = (targetGroups, handCounts, handJokers, availableCounts, options = {}) => {
  const deficits = Object.entries(targetGroups).map(([rank, target]) => ({
    rank,
    count: Math.max(0, target - Number(handCounts[rank] || 0)),
  }));
  let wildcardBudget = Math.max(0, handJokers + Math.floor(Number(options.futureJokers) || 0));
  const futureJokers = Math.min(
    Math.max(0, Math.floor(Number(options.futureJokers) || 0)),
    Number(availableCounts.JOKER || 0)
  );
  const jokerUsedFromHand = Math.min(handJokers, deficits.reduce((sum, item) => sum + item.count, 0));
  wildcardBudget -= jokerUsedFromHand;

  // Spend held jokers against the least available deficits first so the route stays reachable.
  let heldToAssign = jokerUsedFromHand;
  deficits.sort((left, right) => (
    Number(availableCounts[left.rank] || 0) - Number(availableCounts[right.rank] || 0)
  ));
  deficits.forEach((deficit) => {
    const used = Math.min(deficit.count, heldToAssign);
    deficit.count -= used;
    heldToAssign -= used;
  });

  let futureToAssign = Math.min(futureJokers, deficits.reduce((sum, item) => sum + item.count, 0));
  deficits.forEach((deficit) => {
    const used = Math.min(deficit.count, futureToAssign);
    deficit.count -= used;
    futureToAssign -= used;
  });

  const neededRanks = deficits.flatMap(({ rank, count }) => Array(count).fill(rank));
  const plannedJokers = Math.min(futureJokers, 11 - (
    Object.entries(targetGroups).reduce(
      (sum, [rank, target]) => sum + Math.min(target, Number(handCounts[rank] || 0)),
      0
    ) + handJokers
  ));
  neededRanks.push(...Array(Math.max(0, plannedJokers)).fill("JOKER"));

  const unavailable = Object.entries(rankCounts(neededRanks.map((rank) => ({ rank })), true))
    .reduce((sum, [rank, count]) => sum + Math.max(0, count - Number(availableCounts[rank] || 0)), 0);
  const structuralDistance = neededRanks.length;
  const separators = countRequiredSeparators(neededRanks, options.previousRank);
  return {
    targetGroups,
    neededRanks,
    helpfulRanks: [...new Set(neededRanks)],
    structuralDistance,
    predictedRemainingPicks: structuralDistance + separators,
    separators,
    reachable: unavailable === 0,
    unavailable,
  };
};

const analyzeCompletionRoutes = (hand = [], availableCards = [], options = {}) => {
  const handCounts = rankCounts(hand);
  const handJokers = hand.filter(isJoker).length;
  const availableCounts = rankCounts(availableCards, true);
  const futureJokers = Math.min(
    Math.max(0, Math.floor(Number(options.futureJokers) || 0)),
    Number(availableCounts.JOKER || 0)
  );
  let bestTuple = null;
  let candidateTargets = [];
  for (const target of COMPLETION_TARGETS) {
    let naturalDeficit = 0;
    let naturalShortage = 0;
    for (const [rank, size] of Object.entries(target)) {
      const deficit = Math.max(0, size - Number(handCounts[rank] || 0));
      naturalDeficit += deficit;
      naturalShortage += Math.max(0, deficit - Number(availableCounts[rank] || 0));
    }
    const structuralDistance = Math.max(0, naturalDeficit - handJokers);
    const unavailable = Math.max(0, naturalShortage - handJokers - futureJokers);
    const tuple = [unavailable === 0 ? 0 : 1, structuralDistance, unavailable];
    const differenceIndex = bestTuple == null
      ? -2
      : tuple.findIndex((value, index) => value !== bestTuple[index]);
    const comparison = differenceIndex === -2
      ? -1
      : (differenceIndex === -1 ? 0 : tuple[differenceIndex] - bestTuple[differenceIndex]);
    if (comparison < 0) {
      bestTuple = tuple;
      candidateTargets = [target];
    } else if (comparison === 0) {
      candidateTargets.push(target);
    }
  }
  const routes = candidateTargets.map((target) => (
    buildRoute(target, handCounts, handJokers, availableCounts, options)
  )).sort((left, right) => (
    left.predictedRemainingPicks - right.predictedRemainingPicks
    || left.unavailable - right.unavailable
  ));
  const best = routes[0] || {
    targetGroups: {}, neededRanks: [], helpfulRanks: [], structuralDistance: 11,
    predictedRemainingPicks: 11, reachable: false, unavailable: 11, separators: 0,
  };
  const picksTaken = Math.max(0, Math.floor(Number(options.picksTaken) || 0));
  return {
    ...best,
    predictedTotalPicks: picksTaken + best.predictedRemainingPicks,
    confidence: best.reachable ? (best.separators ? "medium" : "high") : "low",
  };
};

const getPairRanks = (hand = []) => Object.entries(rankCounts(hand))
  .filter(([, count]) => count === 2)
  .map(([rank]) => rank);

const calibrateOpeningHand = (gameState, humanId, options = {}) => {
  const hand = gameState?.playerCards?.[humanId];
  const deck = gameState?.deck;
  if (!Array.isArray(hand) || !Array.isArray(deck)) return null;
  const random = options.random || Math.random;
  const pairTarget = Math.max(1, Math.min(2, Math.floor(Number(options.pairTarget) || 1)));

  // Joker assistance is delivered later from the deck, not hidden in the opening hand.
  for (let index = 0; index < hand.length; index += 1) {
    if (!isJoker(hand[index])) continue;
    const replacement = deck.findIndex((card) => !isJoker(card));
    if (replacement < 0) break;
    [hand[index], deck[replacement]] = [deck[replacement], hand[index]];
  }

  const totalCounts = rankCounts([...hand, ...deck]);
  const existingPairs = getPairRanks(hand);
  const candidates = shuffled(
    RANKS.filter((rank) => Number(totalCounts[rank] || 0) >= 2),
    random
  ).sort((left, right) => Number(existingPairs.includes(right)) - Number(existingPairs.includes(left)));
  const selected = candidates.slice(0, pairTarget);

  const swapInRank = (rank) => {
    while (hand.filter((card) => !isJoker(card) && card.rank === rank).length < 2) {
      const deckIndex = deck.findIndex((card) => !isJoker(card) && card.rank === rank);
      const counts = rankCounts(hand);
      const handIndex = hand.findIndex((card) => (
        !isJoker(card)
        && !selected.includes(card.rank)
        && Number(counts[card.rank] || 0) <= 1
      ));
      if (deckIndex < 0 || handIndex < 0) break;
      [hand[handIndex], deck[deckIndex]] = [deck[deckIndex], hand[handIndex]];
    }
  };
  selected.forEach(swapInRank);

  // Break accidental extra pairs/sets while keeping the chosen natural pairs intact.
  for (let pass = 0; pass < hand.length * 2; pass += 1) {
    const counts = rankCounts(hand);
    const unwanted = Object.entries(counts).find(([rank, count]) => (
      (!selected.includes(rank) && count >= 2) || (selected.includes(rank) && count > 2)
    ));
    if (!unwanted) break;
    const [rank] = unwanted;
    const handIndex = hand.findIndex((card) => !isJoker(card) && card.rank === rank);
    const currentCounts = rankCounts(hand);
    const deckIndex = deck.findIndex((card) => (
      !isJoker(card)
      && !selected.includes(card.rank)
      && Number(currentCounts[card.rank] || 0) === 0
    ));
    if (handIndex < 0 || deckIndex < 0) break;
    [hand[handIndex], deck[deckIndex]] = [deck[deckIndex], hand[handIndex]];
  }

  return { pairTarget, pairRanks: getPairRanks(hand) };
};

const reserveJokersInDeck = (gameState, humanId, desiredCount = 0) => {
  const deck = gameState?.deck;
  if (!Array.isArray(deck)) return 0;
  const target = Math.max(0, Math.min(2, Math.floor(Number(desiredCount) || 0)));
  let inDeck = deck.filter(isJoker).length;
  if (inDeck >= target) return inDeck;
  const otherHands = Object.entries(gameState.playerCards || {})
    .filter(([playerId]) => String(playerId) !== String(humanId));
  for (const [, hand] of otherHands) {
    while (inDeck < target) {
      const handIndex = (hand || []).findIndex(isJoker);
      const deckIndex = deck.findIndex((card) => !isJoker(card));
      if (handIndex < 0 || deckIndex < 0) break;
      [hand[handIndex], deck[deckIndex]] = [deck[deckIndex], hand[handIndex]];
      inDeck += 1;
    }
    if (inDeck >= target) break;
  }
  return inDeck;
};

const canFollowWithoutRepeats = (cards = [], previousRank = null) => {
  const counts = rankCounts(cards, true);
  const total = cards.length;
  if (total <= 1) return !total || String(cards[0]?.rank) !== String(previousRank || "");
  return Object.entries(counts).every(([rank, count]) => {
    const allowance = rank === String(previousRank || "")
      ? Math.floor(total / 2)
      : Math.ceil(total / 2);
    return count <= allowance;
  });
};

const moveDeckCardToTop = (deck, index) => {
  if (!Array.isArray(deck) || index < 0 || index >= deck.length) return null;
  const [card] = deck.splice(index, 1);
  deck.push(card);
  return card;
};

const selectHumanDeckCard = (deck = [], analysis = {}, options = {}) => {
  if (!Array.isArray(deck) || !deck.length) return null;
  const random = options.random || Math.random;
  const lastRank = String(options.lastRank || "");
  const helpful = new Set(analysis.helpfulRanks || []);
  const wantsHelp = Boolean(options.wantsHelp);
  const allowJoker = Boolean(options.allowJoker);
  const eligible = deck.map((card, index) => ({ card, index })).filter(({ card, index }) => {
    const rank = String(card?.rank || "");
    if (!rank || rank === lastRank) return false;
    if (isJoker(card) && !allowJoker) return false;
    const remaining = deck.filter((_, deckIndex) => deckIndex !== index);
    return canFollowWithoutRepeats(remaining, rank);
  });
  const relaxed = deck.map((card, index) => ({ card, index })).filter(({ card }) => (
    String(card?.rank || "") !== lastRank && (allowJoker || !isJoker(card))
  ));
  const pool = eligible.length ? eligible : relaxed;
  if (!pool.length) return null;
  let preferred = options.preferJoker
    ? pool.filter(({ card }) => isJoker(card))
    : [];
  if (!preferred.length) {
    preferred = pool.filter(({ card }) => helpful.has(String(card.rank)));
  }
  if (!wantsHelp) preferred = pool.filter(({ card }) => !helpful.has(String(card.rank)));
  const choices = preferred.length ? preferred : pool;
  const selected = choices[randomIndex(choices.length, random)];
  return moveDeckCardToTop(deck, selected.index);
};

const createCardFlowPlan = (redisData, humanId, options = {}) => {
  const pairTarget = Math.max(1, Math.min(2, Math.floor(Number(options.pairTarget) || 1)));
  const plan = {
    version: "completion-routes-v1",
    scheduledWinner: redisData.scriptedWinner,
    blockPosition: Number(redisData.scriptedFactors?.blockPosition || 0) || null,
    openingPairTarget: pairTarget,
    openingPairRanks: options.pairRanks || [],
    nearMissTarget: Math.max(1, Math.min(3, Math.floor(Number(options.nearMissTarget) || 1))),
    jokerAssisted: Boolean(options.jokerAssisted),
    jokerAssistCount: Math.max(0, Math.min(2, Math.floor(Number(options.jokerAssistCount) || 0))),
    jokersDelivered: 0,
    lastHumanAcquiredRank: null,
    lastControlledDeckRank: null,
    lastBotLaidRank: null,
    predictionRevision: 0,
    deviationCount: 0,
    createdAt: new Date().toISOString(),
  };
  redisData.cardFlowPlan = plan;
  return refreshCardFlowPlan(redisData, humanId, { initial: true });
};

const refreshCardFlowPlan = (redisData, humanId, options = {}) => {
  const plan = redisData?.cardFlowPlan;
  const hand = redisData?.playerCards?.[humanId] || [];
  if (!plan || !humanId || !Array.isArray(hand)) return null;
  const botCards = Object.entries(redisData.playerCards || {})
    .filter(([playerId]) => String(playerId) !== String(humanId))
    .flatMap(([, cards]) => cards || []);
  const available = [...(redisData.deck || []), ...botCards];
  const remainingJokers = plan.jokerAssisted
    ? Math.max(0, plan.jokerAssistCount - plan.jokersDelivered)
    : 0;
  const analysis = analyzeCompletionRoutes(hand, available, {
    picksTaken: Number(redisData.humanActionCounts?.picks || 0),
    previousRank: plan.lastHumanAcquiredRank,
    futureJokers: remainingJokers,
  });
  plan.structuralDistance = analysis.structuralDistance;
  plan.currentPredictedPicks = analysis.predictedTotalPicks;
  plan.predictedRemainingPicks = analysis.predictedRemainingPicks;
  plan.bestTargetGroups = analysis.targetGroups;
  plan.helpfulRanks = analysis.helpfulRanks;
  plan.reachable = analysis.reachable;
  plan.confidence = analysis.confidence;
  plan.predictionRevision += options.initial ? 0 : 1;
  plan.updatedAt = new Date().toISOString();
  if (options.initial) plan.initialPredictedPicks = analysis.predictedTotalPicks;
  return analysis;
};

module.exports = {
  RANKS,
  TARGET_SIZES,
  analyzeCompletionRoutes,
  calibrateOpeningHand,
  canFollowWithoutRepeats,
  countRequiredSeparators,
  createCardFlowPlan,
  getPairRanks,
  isJoker,
  rankCounts,
  refreshCardFlowPlan,
  reserveJokersInDeck,
  selectHumanDeckCard,
};
