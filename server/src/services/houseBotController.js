/**
 * House-edge controller for managed bot rooms.
 * Layer 0: scripted win/loss decided before deal
 * Layer 1: outcome pressure (give / fair / take)
 * Layer 2: perfect-info play (see human hand)
 * Layer 3: selective deck / opening card manipulation
 * Natural play: human-like timing, never pick→immediate re-lay
 */

const HOUSE_BOT_TARGET_WIN_RATE = 0.82;
const HOUSE_BOT_NEW_USER_GRACE_GAMES = 2;
const HOUSE_BOT_DECK_PEEK_DEPTH = 5;
const HOUSE_BOT_LEDGER_WINDOW = 20;
const HOUSE_BOT_LEDGER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MANAGED_BOT_SLOW_TURN_RATE = 0.08;
const MANAGED_BOT_SLOW_TURN_MIN_MS = 10000;
const MANAGED_BOT_SLOW_TURN_MAX_MS = 15000;
const MIN_OPENING_SWAPS_BY_PRESSURE = { give: 0, fair: 2, take: 4 };
const MAX_OPENING_SWAPS_BY_PRESSURE = { give: 1, fair: 3, take: 6 };

/** One shuffled 3/4/5 cycle totals nine bot slots and three human slots. */
const BOT_WIN_BLOCK_SIZE = 12;
const GUARANTEED_BOT_WINS_PER_BLOCK = 9;
const GUARANTEED_HUMAN_WINS_PER_BLOCK = 3;
const VARIABLE_SCHEDULE_VERSION = "variable-3-5-v2-joker";
const VARIABLE_BLOCK_SIZES = [3, 4, 5];

/** Managed room: bot "getting ready" before deal (ms). */
const MANAGED_BOT_READY_DELAY_MIN_MS = 2500;
const MANAGED_BOT_READY_DELAY_MAX_MS = 8000;

/**
 * Bot-side finish gate for managed rounds: hold a legal win until the bot has
 * taken this many picks (inclusive range). Outcome odds are shaped at deal /
 * draw time; humans are never hard-blocked from declaring.
 */
const MIN_PICKS_BEFORE_WIN = 5;
const MAX_PICKS_BEFORE_WIN = 8;

const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/** Stable identity so we never discard the same physical card we just picked. */
const cardKey = (card) => {
  if (!card) return "";
  return `${String(card.rank || "")}|${String(card.suit || "")}|${String(card.color || "")}`;
};

/**
 * Compute P(bot wins) from full player/room context before the deal.
 *
 * Inputs (all used):
 * - gamesPlayed: lifetime games (experience → harder house)
 * - wins: lifetime wins (skill / threat → harder house)
 * - balance: current Birr (low = retention; high = extraction)
 * - entryFee: room stake (higher fee → stronger house edge)
 * - totalWithdrawn: lifetime cash-out Birr (high withdrawers → harder bots)
 *
 * Optional:
 * - baseTargetWinRate: blend with legacy difficulty profile
 *
 * @returns {number} probability in [0.68, 0.92]
 */
const computeScriptedBotWinRate = (ctx = {}) => {
  const gamesPlayed = Math.max(0, Math.floor(Number(ctx.gamesPlayed) || 0));
  const wins = Math.max(0, Math.floor(Number(ctx.wins) || 0));
  const balance = Math.max(0, Number(ctx.balance) || 0);
  const entryFee = Math.max(0, Number(ctx.entryFee) || 0);
  const totalWithdrawn = Math.max(0, Number(ctx.totalWithdrawn) || 0);

  // Higher house floor — bot is scripted to win more often
  let rate = 0.72;

  // --- 1) Total games played (smooth experience curve, no cliffs) ---
  const experience = 1 - Math.exp(-gamesPlayed / 28);
  rate += 0.1 * experience; // +0 … +10%

  // --- 2) Total wins + win rate (skill signal) ---
  const priorA = 2;
  const priorB = 2;
  const humanWR = (wins + priorA) / (Math.max(gamesPlayed, 0) + priorA + priorB);
  const sampleWeight = Math.min(1, gamesPlayed / 20);
  rate += (humanWR - 0.45) * 0.22 * sampleWeight;
  rate += 0.04 * Math.min(1, wins / 40) * sampleWeight;

  // --- 3) Balance (lighter retention softener so bot still wins most games) ---
  const bankroll = balance + (entryFee > 0 ? entryFee : 0);
  if (entryFee > 0) {
    const handsLeft = bankroll / entryFee;
    if (handsLeft <= 1.5) rate -= 0.06;
    else if (handsLeft <= 3) rate -= 0.04;
    else if (handsLeft <= 6) rate -= 0.02;
    else if (handsLeft >= 30) rate += 0.06;
    else if (handsLeft >= 15) rate += 0.04;
  } else if (balance > 0) {
    if (balance < 20) rate -= 0.03;
    if (balance > 200) rate += 0.03;
  }
  if (balance >= 500) rate += 0.05;
  else if (balance >= 200) rate += 0.03;
  else if (balance > 0 && balance < 15) rate -= 0.02;

  // --- 4) Room entry fee (all paid tiers boost house edge) ---
  if (entryFee >= 100) rate += 0.08;
  else if (entryFee >= 50) rate += 0.06;
  else if (entryFee >= 25) rate += 0.04;
  else if (entryFee >= 15) rate += 0.03;
  else if (entryFee >= 10) rate += 0.03;

  // --- 5) Lifetime withdrawals — big cashers face harder bots ---
  // Smooth curve: 0 Birr → +0, ~150 Birr → +5%, 300+ Birr → +10%
  const withdrawPressure = Math.min(1, totalWithdrawn / 300);
  rate += 0.1 * withdrawPressure;
  // Extra step for very high lifetime cash-out
  if (totalWithdrawn >= 500) rate += 0.03;
  else if (totalWithdrawn >= 200) rate += 0.015;

  // Optional blend with precomputed difficulty target
  const baseTarget = Number(ctx.baseTargetWinRate);
  if (Number.isFinite(baseTarget) && baseTarget > 0) {
    rate = rate * 0.75 + clamp(baseTarget, 0.65, 0.92) * 0.25;
  }

  return clamp(Number(rate.toFixed(4)), 0.68, 0.92);
};

const randomInteger = (minimum, maximum) => (
  Math.floor(Math.random() * (maximum - minimum + 1)) + minimum
);

const normalizeGuaranteedWinSlots = (slots = []) => (
  [...new Set((Array.isArray(slots) ? slots : [])
    .map((slot) => Math.floor(Number(slot)))
    .filter((slot) => slot >= 1 && slot <= BOT_WIN_BLOCK_SIZE))]
    .sort((left, right) => left - right)
);

const normalizeGuaranteedBotWinSlots = normalizeGuaranteedWinSlots;
const normalizeGuaranteedHumanWinSlots = normalizeGuaranteedWinSlots;

const shuffleValues = (values, random = Math.random) => {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const picked = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[picked]] = [shuffled[picked], shuffled[index]];
  }
  return shuffled;
};

const normalizeScheduleBlockSizes = (sizes = []) => (
  (Array.isArray(sizes) ? sizes : []).map((size) => Math.floor(Number(size)))
);

const hasValidScheduleBlockSizes = (sizes = []) => {
  const normalized = normalizeScheduleBlockSizes(sizes);
  return normalized.length === VARIABLE_BLOCK_SIZES.length
    && normalized.reduce((sum, size) => sum + size, 0) === BOT_WIN_BLOCK_SIZE
    && [...normalized].sort((left, right) => left - right)
      .every((size, index) => size === VARIABLE_BLOCK_SIZES[index]);
};

const generateGuaranteedWinSchedule = (
  random = Math.random,
  { previousCycleEndedWithHuman = false } = {}
) => {
  const scheduleBlockSizes = shuffleValues(VARIABLE_BLOCK_SIZES, random);
  const guaranteedHumanWinSlots = [];
  let offset = 0;

  scheduleBlockSizes.forEach((size, blockIndex) => {
    const previousHumanSlot = guaranteedHumanWinSlots[guaranteedHumanWinSlots.length - 1] || null;
    const preventFirstSlot = (
      (blockIndex === 0 && previousCycleEndedWithHuman)
      || previousHumanSlot === offset
    );
    const candidates = Array.from({ length: size }, (_, index) => index + 1)
      .filter((localPosition) => !(preventFirstSlot && localPosition === 1));
    const pickedIndex = Math.min(
      candidates.length - 1,
      Math.floor(random() * candidates.length)
    );
    guaranteedHumanWinSlots.push(offset + candidates[Math.max(0, pickedIndex)]);
    offset += size;
  });

  const humanSet = new Set(guaranteedHumanWinSlots);
  const guaranteedBotWinSlots = Array.from(
    { length: BOT_WIN_BLOCK_SIZE },
    (_, index) => index + 1
  ).filter((slot) => !humanSet.has(slot));

  const jokerHumanWinSlot = guaranteedHumanWinSlots[Math.min(
    guaranteedHumanWinSlots.length - 1,
    Math.floor(random() * guaranteedHumanWinSlots.length)
  )];
  const jokerAssistCount = random() < 0.5 ? 1 : 2;

  return {
    scheduleVersion: VARIABLE_SCHEDULE_VERSION,
    scheduleBlockSizes,
    guaranteedBotWinSlots,
    guaranteedHumanWinSlots,
    jokerHumanWinSlot,
    jokerAssistCount,
  };
};

const generateGuaranteedBotWinSlots = (random = Math.random) => (
  generateGuaranteedWinSchedule(random).guaranteedBotWinSlots
);

const generateGuaranteedHumanWinSlots = (random = Math.random) => (
  generateGuaranteedWinSchedule(random).guaranteedHumanWinSlots
);

const getGameBlockContext = (totalGames = 0) => {
  const completedGames = Math.max(0, Math.floor(Number(totalGames) || 0));
  return {
    blockNumber: Math.floor(completedGames / BOT_WIN_BLOCK_SIZE) + 1,
    blockPosition: (completedGames % BOT_WIN_BLOCK_SIZE) + 1,
  };
};

const getVariableScheduleContext = (blockPosition = 1, scheduleBlockSizes = []) => {
  const sizes = hasValidScheduleBlockSizes(scheduleBlockSizes)
    ? normalizeScheduleBlockSizes(scheduleBlockSizes)
    : VARIABLE_BLOCK_SIZES;
  const position = Math.max(1, Math.min(BOT_WIN_BLOCK_SIZE, Math.floor(Number(blockPosition) || 1)));
  let offset = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    if (position <= offset + size) {
      return {
        scheduleSegmentIndex: index + 1,
        scheduleSegmentSize: size,
        scheduleSegmentPosition: position - offset,
      };
    }
    offset += size;
  }
  return null;
};

const isValidGuaranteedWinSchedule = ({
  scheduleVersion,
  scheduleBlockSizes,
  guaranteedBotWinSlots,
  guaranteedHumanWinSlots,
  jokerHumanWinSlot,
  jokerAssistCount,
} = {}) => {
  const botSlots = normalizeGuaranteedBotWinSlots(guaranteedBotWinSlots);
  const humanSlots = normalizeGuaranteedHumanWinSlots(guaranteedHumanWinSlots);
  if (
    scheduleVersion !== VARIABLE_SCHEDULE_VERSION
    || !hasValidScheduleBlockSizes(scheduleBlockSizes)
    || botSlots.length !== GUARANTEED_BOT_WINS_PER_BLOCK
    || humanSlots.length !== GUARANTEED_HUMAN_WINS_PER_BLOCK
    || botSlots.some((slot) => humanSlots.includes(slot))
    || new Set([...botSlots, ...humanSlots]).size !== BOT_WIN_BLOCK_SIZE
    || humanSlots.some((slot, index) => index > 0 && slot - humanSlots[index - 1] === 1)
    || !humanSlots.includes(Math.floor(Number(jokerHumanWinSlot)))
    || ![1, 2].includes(Math.floor(Number(jokerAssistCount)))
  ) {
    return false;
  }

  let offset = 0;
  return normalizeScheduleBlockSizes(scheduleBlockSizes).every((size) => {
    const humansInBlock = humanSlots.filter((slot) => slot > offset && slot <= offset + size).length;
    offset += size;
    return humansInBlock === 1;
  });
};

const evaluateGameBlockForce = ({
  blockPosition = 1,
  scheduleVersion = null,
  scheduleBlockSizes = [],
  guaranteedBotWinSlots = [],
  guaranteedHumanWinSlots = [],
  jokerHumanWinSlot = null,
  jokerAssistCount = null,
} = {}) => {
  const position = Math.max(1, Math.min(BOT_WIN_BLOCK_SIZE, Math.floor(Number(blockPosition) || 1)));
  const botSlots = normalizeGuaranteedBotWinSlots(guaranteedBotWinSlots);
  const humanSlots = normalizeGuaranteedHumanWinSlots(guaranteedHumanWinSlots);
  const scheduleIsValid = isValidGuaranteedWinSchedule({
    scheduleVersion,
    scheduleBlockSizes,
    guaranteedBotWinSlots: botSlots,
    guaranteedHumanWinSlots: humanSlots,
    jokerHumanWinSlot,
    jokerAssistCount,
  });
  const botForced = scheduleIsValid && botSlots.includes(position);
  const humanForced = scheduleIsValid && humanSlots.includes(position);
  const forced = botForced || humanForced;
  return {
    forced,
    botWins: forced ? botForced : null,
    scriptedWinner: forced ? (botForced ? "bot" : "human") : null,
    forceReason: botForced
      ? "scheduled-bot-variable-3-5"
      : (humanForced ? "scheduled-human-variable-3-5" : null),
    blockPosition: position,
    scheduleVersion,
    scheduleBlockSizes: normalizeScheduleBlockSizes(scheduleBlockSizes),
    ...getVariableScheduleContext(position, scheduleBlockSizes),
    guaranteedBotWinSlots: botSlots,
    guaranteedHumanWinSlots: humanSlots,
    jokerHumanWinSlot: Math.floor(Number(jokerHumanWinSlot)) || null,
    jokerAssistCount: [1, 2].includes(Math.floor(Number(jokerAssistCount)))
      ? Math.floor(Number(jokerAssistCount))
      : null,
    jokerAssisted: humanForced && position === Math.floor(Number(jokerHumanWinSlot)),
  };
};

/**
 * Decide who wins this round BEFORE cards are dealt.
 *
 * Layers:
 *  A) Variable 3/4/5 force (nine bot and three human positions per 12 managed games)
 *  B) Probability from games/wins/balance/fee for unscheduled callers (for example practice)
 *  C) Play type via pressureForScriptedOutcome (take / give / fair mapping)
 *
 * @param {number|object} input - legacy P(bot) number, OR context object
 * @param {function} [random]
 */
const decideScriptedOutcome = (input = HOUSE_BOT_TARGET_WIN_RATE, random = Math.random) => {
  let botWinProbability;
  let factors = null;
  let blockNumber = null;
  let blockPosition = null;
  let scheduleVersion = null;
  let scheduleBlockSizes = [];
  let guaranteedBotWinSlots = [];
  let guaranteedHumanWinSlots = [];
  let jokerHumanWinSlot = null;
  let jokerAssistCount = null;

  if (input != null && typeof input === "object" && !Array.isArray(input)) {
    const gamesPlayed = Math.max(0, Math.floor(Number(input.gamesPlayed) || 0));
    const wins = Math.max(0, Math.floor(Number(input.wins) || 0));
    const balance = Math.max(0, Number(input.balance) || 0);
    const entryFee = Math.max(0, Number(input.entryFee) || 0);
    const totalWithdrawn = Math.max(0, Number(input.totalWithdrawn) || 0);
    botWinProbability = computeScriptedBotWinRate(input);

    const ledger = input.ledger && typeof input.ledger === "object" ? input.ledger : null;
    const derivedBlock = getGameBlockContext(input.totalGames ?? ledger?.totalGames ?? 0);
    blockNumber = Math.max(
      1,
      Math.floor(Number(input.blockNumber ?? ledger?.blockNumber) || derivedBlock.blockNumber)
    );
    blockPosition = Math.max(1, Math.min(
      BOT_WIN_BLOCK_SIZE,
      Math.floor(Number(input.blockPosition ?? ledger?.blockPosition) || derivedBlock.blockPosition)
    ));
    scheduleVersion = input.scheduleVersion ?? ledger?.scheduleVersion ?? null;
    scheduleBlockSizes = normalizeScheduleBlockSizes(
      input.scheduleBlockSizes ?? ledger?.scheduleBlockSizes
    );
    guaranteedBotWinSlots = normalizeGuaranteedBotWinSlots(
      input.guaranteedBotWinSlots ?? ledger?.guaranteedBotWinSlots
    );
    guaranteedHumanWinSlots = normalizeGuaranteedHumanWinSlots(
      input.guaranteedHumanWinSlots ?? ledger?.guaranteedHumanWinSlots
    );
    jokerHumanWinSlot = Math.floor(Number(
      input.jokerHumanWinSlot ?? ledger?.jokerHumanWinSlot
    )) || null;
    jokerAssistCount = Math.floor(Number(
      input.jokerAssistCount ?? ledger?.jokerAssistCount
    )) || null;

    factors = {
      gamesPlayed,
      wins,
      balance,
      entryFee,
      totalWithdrawn,
      humanWinRate: gamesPlayed > 0 ? Number((wins / gamesPlayed).toFixed(4)) : 0,
      botWinProbability,
      blockNumber,
      blockPosition,
      scheduleVersion,
      scheduleBlockSizes,
      guaranteedBotWinSlots,
      guaranteedHumanWinSlots,
      jokerHumanWinSlot,
      jokerAssistCount,
    };
  } else {
    botWinProbability = clamp(
      Number(input) || HOUSE_BOT_TARGET_WIN_RATE,
      0.68,
      0.92
    );
  }

  const blockForce = evaluateGameBlockForce({
    blockPosition,
    scheduleVersion,
    scheduleBlockSizes,
    guaranteedBotWinSlots,
    guaranteedHumanWinSlots,
    jokerHumanWinSlot,
    jokerAssistCount,
  });
  let botWins;
  let forced = false;
  let forceReason = null;

  if (blockForce.forced) {
    botWins = blockForce.botWins;
    forced = true;
    forceReason = blockForce.forceReason;
  } else {
    botWins = random() < botWinProbability;
  }

  if (factors) {
    factors.forced = forced;
    factors.forceReason = forceReason;
    factors.botWinProbability = botWinProbability;
  }

  return {
    botWins,
    scriptedWinner: botWins ? "bot" : "human",
    botWinProbability,
    forced,
    forceReason,
    factors,
    blockNumber,
    blockPosition: blockForce.blockPosition,
    scheduleVersion: blockForce.scheduleVersion,
    scheduleBlockSizes: blockForce.scheduleBlockSizes,
    scheduleSegmentIndex: blockForce.scheduleSegmentIndex,
    scheduleSegmentSize: blockForce.scheduleSegmentSize,
    scheduleSegmentPosition: blockForce.scheduleSegmentPosition,
    guaranteedBotWinSlots: blockForce.guaranteedBotWinSlots,
    guaranteedHumanWinSlots: blockForce.guaranteedHumanWinSlots,
    jokerHumanWinSlot: blockForce.jokerHumanWinSlot,
    jokerAssistCount: blockForce.jokerAssistCount,
    jokerAssisted: blockForce.jokerAssisted,
  };
};

/**
 * Map scripted outcome to play pressure (the three types):
 * - take: bot is meant to win (strong)
 * - give: human is meant to win (soft) — only before 6 room games
 * - fair: neutral play — after 6 room games, human scripts use fair (not give)
 */
const pressureForScriptedOutcome = (botWins, housePressure = "fair", roomGamesPlayed = 0) => {
  if (botWins) {
    return "take";
  }
  // After 6 games in this room: only fair or take (no soft give)
  if (Number(roomGamesPlayed) >= 6) {
    return "fair";
  }
  return "give";
};

/**
 * After 6 completed games in a room: pressure is only fair or take (never give).
 * - give → fair (human-leaning without full soft mode)
 * - fair / take unchanged
 */
const clampPressureAfterSixGames = (pressure, roomGamesPlayed = 0, botWins = true) => {
  if (Number(roomGamesPlayed) < 6) return pressure;
  if (pressure === "give") return "fair";
  if (pressure !== "fair" && pressure !== "take") {
    return botWins ? "take" : "fair";
  }
  return pressure;
};

/**
 * Human-like turn start delay: mostly 1.2–3s, sometimes quick, sometimes long think.
 */
const getHumanLikeTurnDelayMs = (random = Math.random) => {
  const roll = random();
  if (roll < MANAGED_BOT_SLOW_TURN_RATE) {
    return randomInteger(MANAGED_BOT_SLOW_TURN_MIN_MS, MANAGED_BOT_SLOW_TURN_MAX_MS);
  }
  if (roll < 0.19) return randomInteger(600, 1100); // snappy
  if (roll < 0.80) return randomInteger(1200, 2800); // normal
  if (roll < 0.94) return randomInteger(2800, 4500); // thinking
  return randomInteger(4500, 7000); // long think / "distracted"
};

/**
 * Delay between pick and lay — never instant; sometimes slow arrange.
 */
const getHumanLikePickToLayDelayMs = (random = Math.random) => {
  const roll = random();
  if (roll < 0.15) return randomInteger(700, 1100);
  if (roll < 0.75) return randomInteger(1100, 2200);
  return randomInteger(2200, 4000);
};

const getManagedBotReadyDelayMs = (random = Math.random) => (
  randomInteger(MANAGED_BOT_READY_DELAY_MIN_MS, MANAGED_BOT_READY_DELAY_MAX_MS)
);

const getManagedBonusIntroOutcome = (started, completedGames = 0) => {
  if (!started) return null;
  const stage = Math.max(0, Math.floor(Number(completedGames) || 0)) + 1;
  if (stage > 3) return null;
  return {
    stage,
    botWins: stage === 3,
    scriptedWinner: stage === 3 ? "bot" : "human",
  };
};

/**
 * How many pick actions (per side) must complete before a managed round may end.
 * Keeps wins from feeling instant while still finishing in a normal length game.
 */
const getMinPicksBeforeWin = (randomInt = randomInteger) => (
  randomInt(MIN_PICKS_BEFORE_WIN, MAX_PICKS_BEFORE_WIN)
);

/**
 * True once the actor has taken enough picks for a natural-looking finish.
 * Lays may be one behind picks when the finish is declare-win instead of lay.
 *
 * @param {{ picks?: number, lays?: number } | null} actionCounts
 * @param {number} minPicks
 */
const hasMetMinPlayBeforeWin = (actionCounts = {}, minPicks = MIN_PICKS_BEFORE_WIN) => {
  const required = Math.max(
    MIN_PICKS_BEFORE_WIN,
    Math.floor(Number(minPicks) || MIN_PICKS_BEFORE_WIN)
  );
  const picks = Math.max(0, Math.floor(Number(actionCounts?.picks) || 0));
  const lays = Math.max(0, Math.floor(Number(actionCounts?.lays) || 0));
  return picks >= required && lays >= Math.max(0, required - 1);
};

/**
 * Soft human deck help only after the player has already taken some turns,
 * so a scripted human win still requires real play.
 */
const hasMetSoftHelpPlayThreshold = (actionCounts = {}, minPicks = MIN_PICKS_BEFORE_WIN) => {
  const required = Math.max(
    MIN_PICKS_BEFORE_WIN,
    Math.floor(Number(minPicks) || MIN_PICKS_BEFORE_WIN)
  );
  const picks = Math.max(0, Math.floor(Number(actionCounts?.picks) || 0));
  // Start helping around half-way through the min-play window.
  return picks >= Math.max(2, Math.floor(required / 2));
};

const getRankCounts = (cards = [], includeJokers = false) => cards.reduce((acc, card) => {
  const rank = card?.rank;
  if (!rank) return acc;
  if (!includeJokers && isJoker(card)) return acc;
  acc[rank] = (acc[rank] || 0) + 1;
  return acc;
}, {});

const matchesWinningPattern = (counts = []) => {
  const pattern = counts.slice().sort((a, b) => b - a);
  return pattern.length === 4 &&
    pattern[0] === 4 &&
    pattern[1] === 3 &&
    pattern[2] === 3 &&
    pattern[3] === 1;
};

const canCompletePatternWithJokers = (counts = [], jokerCount = 0) => {
  const search = (currentCounts, remainingJokers) => {
    if (remainingJokers === 0) return matchesWinningPattern(currentCounts);
    for (let index = 0; index < currentCounts.length; index += 1) {
      if (currentCounts[index] >= 4) continue;
      const nextCounts = [...currentCounts];
      nextCounts[index] += 1;
      if (search(nextCounts, remainingJokers - 1)) return true;
    }
    return false;
  };
  return search(counts.slice(), jokerCount);
};

const analyzeWinningHand = (cards = []) => {
  const jokerCount = cards.filter(isJoker).length;
  const naturalCounts = Object.values(getRankCounts(cards, false)).sort((a, b) => b - a);
  return {
    isWinning: matchesWinningPattern(naturalCounts) || canCompletePatternWithJokers(naturalCounts, jokerCount),
    jokerCount,
  };
};

/**
 * Lower is closer to a legal win. 0 = already winning.
 * Rough heuristic: missing ranks + cards short of 4-3-3-1 skeleton.
 */
const estimateHandDistance = (cards = []) => {
  if (analyzeWinningHand(cards).isWinning) return 0;
  const counts = Object.values(getRankCounts(cards, false)).sort((a, b) => b - a);
  const jokerCount = cards.filter(isJoker).length;
  const top = [0, 0, 0, 0].map((_, i) => counts[i] || 0);
  const target = [4, 3, 3, 1];
  let shortfall = 0;
  for (let i = 0; i < 4; i += 1) {
    shortfall += Math.max(0, target[i] - top[i]);
  }
  const rankDeficit = Math.max(0, 4 - counts.length);
  return Math.max(0, shortfall + rankDeficit - jokerCount);
};

const rankHelpsHand = (hand = [], rank) => {
  if (!rank || String(rank).toUpperCase() === "JOKER") return false;
  const count = hand.filter((card) => card.rank === rank && !isJoker(card)).length;
  return count >= 1 && count < 4;
};

const rankIsCriticalForHand = (hand = [], rank) => {
  if (!rank || String(rank).toUpperCase() === "JOKER") return false;
  const count = hand.filter((card) => card.rank === rank && !isJoker(card)).length;
  // 2–3 of a rank: feeding or denying matters a lot for 4-3-3-1
  return count >= 2 && count < 4;
};

/**
 * @param {{ gamesPlayed?: number, botWins?: number, botLosses?: number, outcomes?: boolean[] }} ledger
 * @param {{ gamesPlayed?: number, targetWinRate?: number, roomGamesPlayed?: number }} options
 * @returns {"give"|"fair"|"take"}
 */
const getHousePressure = (ledger = {}, options = {}) => {
  const targetWinRate = clamp(
    Number(options.targetWinRate ?? HOUSE_BOT_TARGET_WIN_RATE),
    0.5,
    0.9
  );
  const lifetimeGames = Math.max(0, Math.floor(Number(options.gamesPlayed || 0)));
  const roomGamesPlayed = Math.max(0, Math.floor(Number(options.roomGamesPlayed || 0)));
  const outcomes = Array.isArray(ledger.outcomes)
    ? ledger.outcomes.map(Boolean).slice(-HOUSE_BOT_LEDGER_WINDOW)
    : [];

  let botWins = Number(ledger.botWins);
  let games = Number(ledger.games);
  if (outcomes.length > 0) {
    botWins = outcomes.filter(Boolean).length;
    games = outcomes.length;
  } else {
    botWins = Number.isFinite(botWins) ? Math.max(0, botWins) : 0;
    games = Number.isFinite(games) ? Math.max(0, games) : botWins + Math.max(0, Number(ledger.botLosses || 0));
  }

  // After 6 games in this room: only fair or take (never give)
  const onlyFairOrTake = roomGamesPlayed >= 6;

  // Soft first paid bot games for retention
  if (games < HOUSE_BOT_NEW_USER_GRACE_GAMES && lifetimeGames < 5) {
    return onlyFairOrTake ? "fair" : "give";
  }

  if (games < 3) {
    return "fair";
  }

  const botWinRate = botWins / games;
  const delta = botWinRate - targetWinRate;

  // Behind target → take harder; ahead → softer (give early, fair after 6 games)
  if (delta < -0.08) return "take";
  if (delta > 0.08) return onlyFairOrTake ? "fair" : "give";
  if (delta < -0.03) return "take";
  if (delta > 0.05) return onlyFairOrTake ? "fair" : "give";
  return "fair";
};

const getOpeningSwapCountForPressure = (pressure = "fair", random = Math.random) => {
  const key = ["give", "fair", "take"].includes(pressure) ? pressure : "fair";
  const min = MIN_OPENING_SWAPS_BY_PRESSURE[key];
  const max = MAX_OPENING_SWAPS_BY_PRESSURE[key];
  if (max <= min) return min;
  const expected = min + (max - min) * 0.55;
  const whole = Math.floor(expected);
  const frac = expected - whole;
  return Math.min(max, whole + (frac > 0 && random() < frac ? 1 : 0));
};

/**
 * Score a discard candidate: lower is better to throw away.
 * Self-cost high → keep. Feed-cost high → keep (don't give to human).
 */
const scoreDiscardCandidate = (botHand, humanHand, card, pressure = "fair") => {
  if (!card) return Number.POSITIVE_INFINITY;
  if (isJoker(card)) return Number.POSITIVE_INFINITY; // never dump jokers

  const botCounts = getRankCounts(botHand, false);
  const humanCounts = getRankCounts(humanHand, false);
  const groupCount = Number(botCounts[card.rank] || 0);
  const humanCount = Number(humanCounts[card.rank] || 0);

  // Prefer dumping true singletons
  let score = groupCount * 40;

  // Face ranks slightly less dump-priority among equals
  if (["A", "K", "Q", "J"].includes(card.rank)) score += 6;
  else score += Number(card.rank) || 2;

  // Perfect info: don't feed human
  const feedWeight = pressure === "give" ? 8 : pressure === "take" ? 55 : 30;
  if (humanCount >= 3) score += feedWeight * 4; // almost never feed their triple
  else if (humanCount === 2) score += feedWeight * 2.5;
  else if (humanCount === 1) score += feedWeight * 0.8;

  // Under take, keep cards that advance bot more aggressively
  if (pressure === "take" && groupCount >= 2) score += 25;

  return score;
};

/**
 * @param {object[]} botHand
 * @param {object[]} humanHand
 * @param {string} pressure
 * @param {{ excludeCardKeys?: string[] }} options — never discard just-picked cards
 */
const chooseDiscardIndex = (botHand = [], humanHand = [], pressure = "fair", options = {}) => {
  if (!botHand.length) return 0;
  const exclude = new Set((options.excludeCardKeys || []).filter(Boolean));
  const excludeRanks = new Set((options.excludeRanks || []).map(String).filter(Boolean));
  const neverRepeatRank = String(options.neverRepeatRank || "");

  const nonRepeatingCandidates = botHand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => (
      !exclude.has(cardKey(card))
      && String(card?.rank || "") !== neverRepeatRank
    ));
  const candidates = nonRepeatingCandidates.filter(({ card }) => (
    !excludeRanks.has(String(card?.rank || ""))
  ));

  const pool = candidates.length
    ? candidates
    : (nonRepeatingCandidates.length
      ? nonRepeatingCandidates
      : botHand.map((card, index) => ({ card, index })));

  // give: mostly selfish singleton dump (ignore human somewhat)
  if (pressure === "give") {
    const counts = getRankCounts(botHand, false);
    let bestIndex = pool[0].index;
    let bestScore = Number.POSITIVE_INFINITY;
    pool.forEach(({ card, index }) => {
      const groupCount = isJoker(card) ? 99 : Number(counts[card.rank] || 0);
      const rankScore = ["A", "K", "Q", "J"].includes(card.rank) ? 8 : Number(card.rank || 2);
      const score = groupCount * 20 + rankScore;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  let bestIndex = pool[0].index;
  let bestScore = Number.POSITIVE_INFINITY;
  pool.forEach(({ card, index }) => {
    const score = scoreDiscardCandidate(botHand, humanHand, card, pressure);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
};

/**
 * Whether bot should take the top laid card.
 * Natural rule: only pick if it already improves the bot hand (has ≥1 of rank).
 * Never pick a cold rank just to dump it back — that looks robotic.
 */
const shouldBotTakeLaid = (botHand = [], humanHand = [], card, pressure = "fair", random = Math.random) => {
  if (!card || isJoker(card)) return false;

  const botCount = botHand.filter((item) => item.rank === card.rank && !isJoker(item)).length;
  const humanCount = humanHand.filter((item) => item.rank === card.rank && !isJoker(item)).length;

  // Never pick a rank we don't already have — would often re-lay immediately
  if (botCount < 1) return false;

  // Strong self-improve: already have a pair/triple building
  if (botCount >= 2 && botCount < 4) {
    // Occasional human miss so it doesn't look perfect
    if (pressure === "give") return random() < 0.85;
    if (pressure === "fair" && random() < 0.08) return false;
    return true;
  }

  // botCount === 1: building a pair
  if (pressure === "give") {
    return random() < 0.22;
  }

  // Deny only when we also keep the card (we already have ≥1)
  if (humanCount >= 2 && humanCount < 4) {
    if (pressure === "take") return random() < 0.92;
    if (humanCount >= 3) return random() < 0.9;
    return random() < 0.75;
  }

  if (pressure === "take") return random() < 0.9;
  return random() < 0.7;
};

/**
 * Reorder deck so a helpful card is drawn next (array end is top — callers use pop()).
 * Only under take (and rarely fair). Mutates deck in place.
 * @returns {boolean} whether a bias was applied
 */
const biasDeckForBotDraw = (deck = [], botHand = [], humanHand = [], pressure = "fair") => {
  if (!Array.isArray(deck) || deck.length === 0) return false;
  // When human is scripted to win, do not help bot draws
  if (pressure === "give") return false;
  if (pressure === "fair" && Math.random() > 0.2) return false;

  const peekDepth = Math.min(HOUSE_BOT_DECK_PEEK_DEPTH, deck.length);
  // Candidates are near the draw end (top of deck)
  const start = deck.length - peekDepth;
  let bestOffset = -1;
  let bestScore = -Infinity;

  for (let i = start; i < deck.length; i += 1) {
    const card = deck[i];
    if (!card) continue;
    let score = 0;
    if (isJoker(card)) {
      score = pressure === "take" ? 50 : 20;
    } else {
      const botCount = botHand.filter((c) => c.rank === card.rank && !isJoker(c)).length;
      const humanCount = humanHand.filter((c) => c.rank === card.rank && !isJoker(c)).length;
      if (botCount >= 1 && botCount < 4) score += 30 + botCount * 10;
      if (botCount >= 2) score += 25;
      // Prefer cards human doesn't need so we don't "waste" a deny-by-holding later
      if (humanCount >= 2) score -= 5;
      if (botCount === 0) score -= 10;
    }
    // Prefer closer to top slightly to reduce shuffle drama
    score += (i - start) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestOffset = i;
    }
  }

  if (bestOffset < 0 || bestScore < 15) return false;
  if (bestOffset === deck.length - 1) return true;

  const [chosen] = deck.splice(bestOffset, 1);
  deck.push(chosen);
  return true;
};

/**
 * Guaranteed bot-win open: break human pairs/sets and jokers into the deck
 * so the human starts with mostly cold singletons (hard to reach 4-3-3-1).
 */
const weakenHumanOpeningHand = (gameState, humanId, options = {}) => {
  const maxSwaps = Math.max(1, Math.min(8, Number(options.maxSwaps) || 6));
  const hand = gameState.playerCards?.[humanId];
  const deck = gameState.deck;
  if (!Array.isArray(hand) || !Array.isArray(deck) || !humanId) return gameState;

  for (let swap = 0; swap < maxSwaps; swap += 1) {
    const counts = getRankCounts(hand, false);
    // Prefer removing jokers first, then pairs/triples/quads
    let dumpIndex = hand.findIndex((card) => isJoker(card));
    if (dumpIndex === -1) {
      dumpIndex = hand.findIndex((card) => (
        !isJoker(card) && Number(counts[card.rank] || 0) >= 2
      ));
    }
    if (dumpIndex === -1) break;

    // Pull a deck card that is a cold singleton for human (new rank, not joker)
    const deckIndex = deck.findIndex((card) => {
      if (!card || isJoker(card)) return false;
      const already = Number(counts[card.rank] || 0);
      // Prefer ranks human doesn't hold; never feed into their pair
      return already === 0;
    });
    if (deckIndex === -1) {
      // Fall back: any non-joker that doesn't add to a triple+
      const alt = deck.findIndex((card) => (
        card && !isJoker(card) && Number(counts[card.rank] || 0) < 2
      ));
      if (alt === -1) break;
      const prev = hand[dumpIndex];
      hand[dumpIndex] = deck[alt];
      deck[alt] = prev;
      continue;
    }

    const previousCard = hand[dumpIndex];
    hand[dumpIndex] = deck[deckIndex];
    deck[deckIndex] = previousCard;
  }

  return gameState;
};

/**
 * Strong bot open for guaranteed rounds (max constructive swaps).
 */
const strengthenBotOpeningHandGuaranteed = (gameState, botId, humanId = null) => (
  biasBotOpeningHand(gameState, botId, {
    pressure: "take",
    humanId,
    maxSwaps: MAX_OPENING_SWAPS_BY_PRESSURE.take,
  })
);

/**
 * When human draws mid-game on a guaranteed bot round, surface a dead card
 * (does not build their sets) so they stay far from a legal win.
 */
const biasDeckAgainstPlayer = (deck = [], hand = []) => {
  if (!Array.isArray(deck) || deck.length === 0) return false;
  const counts = getRankCounts(hand, false);
  const peekDepth = Math.min(HOUSE_BOT_DECK_PEEK_DEPTH + 3, deck.length);
  const start = deck.length - peekDepth;
  let bestOffset = -1;
  let bestScore = -Infinity;

  for (let i = start; i < deck.length; i += 1) {
    const card = deck[i];
    if (!card) continue;
    let score = 0;
    if (isJoker(card)) {
      score = -100; // never hand them a joker when sabotaging
    } else {
      const have = Number(counts[card.rank] || 0);
      if (have === 0) score = 50; // cold rank — ideal dead card
      else if (have === 1) score = 5; // builds a pair (worse for us)
      else score = -40; // feeds their set
    }
    score += (i - start) * 0.05;
    if (score > bestScore) {
      bestScore = score;
      bestOffset = i;
    }
  }

  if (bestOffset < 0 || bestScore < 10) return false;
  if (bestOffset === deck.length - 1) return true;
  const [chosen] = deck.splice(bestOffset, 1);
  deck.push(chosen);
  return true;
};

/**
 * Opening hand swaps toward sets; more aggressive under take.
 * Does not leave a finished winning hand on the table.
 */
const biasBotOpeningHand = (gameState, botId, options = {}) => {
  const {
    humanId = null,
    pressure = "fair",
    random = Math.random,
    maxSwaps = null,
  } = options;

  const hand = gameState.playerCards?.[botId];
  const deck = gameState.deck;
  if (!Array.isArray(hand) || !Array.isArray(deck)) return gameState;

  const maximumSwaps = maxSwaps != null
    ? Math.max(0, Math.floor(Number(maxSwaps) || 0))
    : getOpeningSwapCountForPressure(pressure, random);

  for (let swap = 0; swap < maximumSwaps; swap += 1) {
    const counts = getRankCounts(hand, false);
    const targetRanks = Object.entries(counts)
      .filter(([, count]) => count >= 2 && count < 4)
      .sort(([, left], [, right]) => right - left)
      .map(([rank]) => rank);

    // Under take, also start pairs from high singletons if no doubles yet
    if (pressure === "take" && !targetRanks.length) {
      const singletons = Object.entries(counts)
        .filter(([, count]) => count === 1)
        .map(([rank]) => rank);
      for (const rank of singletons) {
        if (deck.some((card) => card.rank === rank && !isJoker(card))) {
          targetRanks.push(rank);
          break;
        }
      }
    }

    const targetRank = targetRanks.find((rank) => (
      deck.some((card) => card.rank === rank && !isJoker(card))
    ));
    if (!targetRank) break;

    // Prefer discarding a singleton that is useful to human (take pressure)
    const humanHand = humanId ? (gameState.playerCards?.[humanId] || []) : [];
    const humanCounts = getRankCounts(humanHand, false);
    let discardIndex = -1;
    if (pressure === "take" && humanHand.length) {
      discardIndex = hand.findIndex((card) => (
        !isJoker(card) &&
        Number(counts[card.rank] || 0) === 1 &&
        Number(humanCounts[card.rank] || 0) >= 1
      ));
    }
    if (discardIndex === -1) {
      discardIndex = hand.findIndex((card) => (
        !isJoker(card) && Number(counts[card.rank] || 0) === 1
      ));
    }
    const deckIndex = deck.findIndex((card) => card.rank === targetRank && !isJoker(card));
    if (discardIndex === -1 || deckIndex === -1) break;

    const previousCard = hand[discardIndex];
    hand[discardIndex] = deck[deckIndex];
    deck[deckIndex] = previousCard;

    if (analyzeWinningHand(hand).isWinning) {
      deck[deckIndex] = hand[discardIndex];
      hand[discardIndex] = previousCard;
      break;
    }
  }

  return gameState;
};

const emptyLedger = (random = Math.random) => {
  const schedule = generateGuaranteedWinSchedule(random);
  return {
    games: 0,
    totalGames: 0,
    botWins: 0,
    botLosses: 0,
    outcomes: [],
    blockNumber: 1,
    blockPosition: 1,
    leaveTargetBlockNumber: null,
    leaveTargetPosition: null,
    leaveUsedBlockNumber: null,
    ...schedule,
  };
};

const parseLedger = (raw) => {
  if (!raw) {
    return emptyLedger();
  }
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const outcomes = Array.isArray(data.outcomes)
      ? data.outcomes.map(Boolean).slice(-HOUSE_BOT_LEDGER_WINDOW)
      : [];
    const legacyGames = Number.isFinite(Number(data.games))
      ? Math.max(0, Math.floor(Number(data.games)))
      : outcomes.length;
    const totalGames = Number.isFinite(Number(data.totalGames))
      ? Math.max(0, Math.floor(Number(data.totalGames)))
      : legacyGames;
    const block = getGameBlockContext(totalGames);
    let scheduleVersion = data.scheduleVersion || null;
    let scheduleBlockSizes = normalizeScheduleBlockSizes(data.scheduleBlockSizes);
    let guaranteedBotWinSlots = normalizeGuaranteedBotWinSlots(data.guaranteedBotWinSlots);
    let guaranteedHumanWinSlots = normalizeGuaranteedHumanWinSlots(data.guaranteedHumanWinSlots);
    let jokerHumanWinSlot = Math.floor(Number(data.jokerHumanWinSlot)) || null;
    let jokerAssistCount = Math.floor(Number(data.jokerAssistCount)) || null;
    if (
      !isValidGuaranteedWinSchedule({
        scheduleVersion,
        scheduleBlockSizes,
        guaranteedBotWinSlots,
        guaranteedHumanWinSlots,
        jokerHumanWinSlot,
        jokerAssistCount,
      })
      || Number(data.blockNumber) !== block.blockNumber
    ) {
      const schedule = generateGuaranteedWinSchedule(Math.random, {
        // A migrated/unknown preceding schedule must not create adjacent human slots.
        previousCycleEndedWithHuman: true,
      });
      scheduleVersion = schedule.scheduleVersion;
      scheduleBlockSizes = schedule.scheduleBlockSizes;
      guaranteedBotWinSlots = schedule.guaranteedBotWinSlots;
      guaranteedHumanWinSlots = schedule.guaranteedHumanWinSlots;
      jokerHumanWinSlot = schedule.jokerHumanWinSlot;
      jokerAssistCount = schedule.jokerAssistCount;
    }
    return {
      games: outcomes.length || legacyGames,
      totalGames,
      botWins: Number(data.botWins || outcomes.filter(Boolean).length || 0),
      botLosses: Number(data.botLosses || outcomes.filter((o) => !o).length || 0),
      outcomes,
      blockNumber: block.blockNumber,
      blockPosition: block.blockPosition,
      leaveTargetBlockNumber: data.leaveTargetBlockNumber != null
        && Number.isFinite(Number(data.leaveTargetBlockNumber))
        ? Math.max(1, Math.floor(Number(data.leaveTargetBlockNumber)))
        : null,
      leaveTargetPosition: data.leaveTargetPosition != null
        && Number.isFinite(Number(data.leaveTargetPosition))
        ? Math.max(1, Math.min(BOT_WIN_BLOCK_SIZE, Math.floor(Number(data.leaveTargetPosition))))
        : null,
      leaveUsedBlockNumber: data.leaveUsedBlockNumber != null
        && Number.isFinite(Number(data.leaveUsedBlockNumber))
        ? Math.max(1, Math.floor(Number(data.leaveUsedBlockNumber)))
        : null,
      scheduleVersion,
      scheduleBlockSizes,
      guaranteedBotWinSlots,
      guaranteedHumanWinSlots,
      jokerHumanWinSlot,
      jokerAssistCount,
    };
  } catch {
    return emptyLedger();
  }
};

const houseBotLedgerKey = (userId) => `house:user:${String(userId)}:bot-ledger`;

const saveHouseBotLedger = async (redisClient, userId, ledger) => {
  if (!redisClient || !userId) return null;
  await redisClient.set(
    houseBotLedgerKey(userId),
    JSON.stringify(ledger),
    { EX: HOUSE_BOT_LEDGER_TTL_SECONDS }
  );
  return ledger;
};

const planManagedBotLeave = async (
  redisClient,
  userId,
  ledgerInput,
  eligible,
  random = Math.random
) => {
  const ledger = parseLedger(ledgerInput);
  const blockNumber = ledger.blockNumber;
  const blockPosition = ledger.blockPosition;
  if (!eligible || ledger.leaveUsedBlockNumber === blockNumber) {
    return { ledger, shouldLeaveThisRound: false };
  }

  const targetIsUsable = ledger.leaveTargetBlockNumber === blockNumber
    && Number(ledger.leaveTargetPosition) >= blockPosition;
  if (!targetIsUsable) {
    const remaining = BOT_WIN_BLOCK_SIZE - blockPosition + 1;
    ledger.leaveTargetBlockNumber = blockNumber;
    ledger.leaveTargetPosition = blockPosition + Math.floor(random() * remaining);
    await saveHouseBotLedger(redisClient, userId, ledger);
  }

  return {
    ledger,
    shouldLeaveThisRound: ledger.leaveTargetBlockNumber === blockNumber
      && ledger.leaveTargetPosition === blockPosition,
  };
};

const recordManagedBotLeave = async (redisClient, userId) => {
  if (!redisClient || !userId) return null;
  const ledger = parseLedger(await redisClient.get(houseBotLedgerKey(userId)));
  ledger.leaveUsedBlockNumber = ledger.blockNumber;
  ledger.leaveTargetBlockNumber = null;
  ledger.leaveTargetPosition = null;
  return saveHouseBotLedger(redisClient, userId, ledger);
};

/**
 * Record managed-bot round outcome for pressure tracking.
 * @param {import('redis').RedisClientType | { get: Function, set: Function }} redisClient
 * @param {string} userId
 * @param {boolean} botWon
 */
const recordHouseBotOutcome = async (redisClient, userId, botWon) => {
  if (!redisClient || !userId) return null;
  const key = houseBotLedgerKey(userId);
  const existing = parseLedger(await redisClient.get(key));
  const wonByBot = Boolean(botWon);
  const outcomes = [...existing.outcomes, wonByBot].slice(-HOUSE_BOT_LEDGER_WINDOW);

  const totalGames = existing.totalGames + 1;
  const block = getGameBlockContext(totalGames);
  const crossedBlockBoundary = block.blockNumber !== existing.blockNumber;
  const nextSchedule = crossedBlockBoundary
    ? generateGuaranteedWinSchedule(Math.random, {
      previousCycleEndedWithHuman: existing.guaranteedHumanWinSlots.includes(BOT_WIN_BLOCK_SIZE),
    })
    : null;

  const ledger = {
    games: outcomes.length,
    totalGames,
    botWins: outcomes.filter(Boolean).length,
    botLosses: outcomes.filter((won) => !won).length,
    outcomes,
    blockNumber: block.blockNumber,
    blockPosition: block.blockPosition,
    leaveTargetBlockNumber: crossedBlockBoundary ? null : existing.leaveTargetBlockNumber,
    leaveTargetPosition: crossedBlockBoundary ? null : existing.leaveTargetPosition,
    leaveUsedBlockNumber: existing.leaveUsedBlockNumber,
    scheduleVersion: crossedBlockBoundary
      ? nextSchedule.scheduleVersion
      : existing.scheduleVersion,
    scheduleBlockSizes: crossedBlockBoundary
      ? nextSchedule.scheduleBlockSizes
      : existing.scheduleBlockSizes,
    guaranteedBotWinSlots: crossedBlockBoundary
      ? nextSchedule.guaranteedBotWinSlots
      : existing.guaranteedBotWinSlots,
    guaranteedHumanWinSlots: crossedBlockBoundary
      ? nextSchedule.guaranteedHumanWinSlots
      : existing.guaranteedHumanWinSlots,
    jokerHumanWinSlot: crossedBlockBoundary
      ? nextSchedule.jokerHumanWinSlot
      : existing.jokerHumanWinSlot,
    jokerAssistCount: crossedBlockBoundary
      ? nextSchedule.jokerAssistCount
      : existing.jokerAssistCount,
    updatedAt: new Date().toISOString(),
  };
  await redisClient.set(key, JSON.stringify(ledger), { EX: HOUSE_BOT_LEDGER_TTL_SECONDS });
  return ledger;
};

const loadHouseBotLedger = async (redisClient, userId) => {
  if (!redisClient || !userId) {
    return emptyLedger();
  }
  const key = houseBotLedgerKey(userId);
  const ledger = parseLedger(await redisClient.get(key));
  await redisClient.set(key, JSON.stringify(ledger), { EX: HOUSE_BOT_LEDGER_TTL_SECONDS });
  return ledger;
};

const buildHouseControlProfile = ({
  difficulty = {},
  ledger = {},
  gamesPlayed = 0,
  roomGamesPlayed = 0,
} = {}) => {
  const targetWinRate = Number(
    difficulty.targetBotWinRate ?? HOUSE_BOT_TARGET_WIN_RATE
  );
  const pressure = getHousePressure(ledger, {
    gamesPlayed: gamesPlayed || difficulty.gamesPlayed || 0,
    roomGamesPlayed,
    targetWinRate,
  });
  return {
    targetWinRate,
    pressure,
    strength: Number(difficulty.strength || 0),
    ledgerGames: Number(ledger.games || 0),
    ledgerBotWins: Number(ledger.botWins || 0),
  };
};

module.exports = {
  HOUSE_BOT_TARGET_WIN_RATE,
  HOUSE_BOT_NEW_USER_GRACE_GAMES,
  HOUSE_BOT_DECK_PEEK_DEPTH,
  HOUSE_BOT_LEDGER_WINDOW,
  MANAGED_BOT_SLOW_TURN_RATE,
  MANAGED_BOT_SLOW_TURN_MIN_MS,
  MANAGED_BOT_SLOW_TURN_MAX_MS,
  BOT_WIN_BLOCK_SIZE,
  GUARANTEED_BOT_WINS_PER_BLOCK,
  GUARANTEED_HUMAN_WINS_PER_BLOCK,
  VARIABLE_SCHEDULE_VERSION,
  VARIABLE_BLOCK_SIZES,
  MANAGED_BOT_READY_DELAY_MIN_MS,
  MANAGED_BOT_READY_DELAY_MAX_MS,
  MIN_PICKS_BEFORE_WIN,
  MAX_PICKS_BEFORE_WIN,
  analyzeWinningHand,
  estimateHandDistance,
  getHousePressure,
  getOpeningSwapCountForPressure,
  scoreDiscardCandidate,
  chooseDiscardIndex,
  shouldBotTakeLaid,
  biasDeckForBotDraw,
  normalizeGuaranteedBotWinSlots,
  normalizeGuaranteedHumanWinSlots,
  generateGuaranteedBotWinSlots,
  generateGuaranteedHumanWinSlots,
  generateGuaranteedWinSchedule,
  getGameBlockContext,
  getVariableScheduleContext,
  isValidGuaranteedWinSchedule,
  evaluateGameBlockForce,
  emptyLedger,
  weakenHumanOpeningHand,
  strengthenBotOpeningHandGuaranteed,
  biasDeckAgainstPlayer,
  biasBotOpeningHand,
  rankHelpsHand,
  rankIsCriticalForHand,
  recordHouseBotOutcome,
  planManagedBotLeave,
  recordManagedBotLeave,
  loadHouseBotLedger,
  buildHouseControlProfile,
  houseBotLedgerKey,
  parseLedger,
  isJoker,
  getRankCounts,
  cardKey,
  computeScriptedBotWinRate,
  decideScriptedOutcome,
  pressureForScriptedOutcome,
  clampPressureAfterSixGames,
  getHumanLikeTurnDelayMs,
  getHumanLikePickToLayDelayMs,
  getManagedBotReadyDelayMs,
  getManagedBonusIntroOutcome,
  getMinPicksBeforeWin,
  hasMetMinPlayBeforeWin,
  hasMetSoftHelpPlayThreshold,
};
