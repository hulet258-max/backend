const MIN_TARGET_BOT_WIN_RATE = 0.7;
const MAX_TARGET_BOT_WIN_RATE = 0.9;
const MIN_OPENING_SWAPS = 2;
const MAX_OPENING_SWAPS = 6;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const normalizeCount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

const getBaseTargetBotWinRate = (gamesPlayed) => {
  const games = normalizeCount(gamesPlayed);
  if (games < 10) return 0.72;
  if (games < 25) return 0.76;
  if (games < 40) return 0.8;
  return 0.84;
};

const buildBotDifficultyProfile = ({ gamesPlayed = 0, wins = 0 } = {}) => {
  const normalizedGames = normalizeCount(gamesPlayed);
  const normalizedWins = normalizeCount(wins);
  const baseTargetBotWinRate = getBaseTargetBotWinRate(normalizedGames);
  const requestedWinBonus = Math.floor(normalizedWins / 5) * 0.01;
  const targetBotWinRate = Math.min(
    MAX_TARGET_BOT_WIN_RATE,
    Number((baseTargetBotWinRate + requestedWinBonus).toFixed(2))
  );
  const winBonus = Number((targetBotWinRate - baseTargetBotWinRate).toFixed(2));
  const strength = clamp(
    (targetBotWinRate - MIN_TARGET_BOT_WIN_RATE) /
      (MAX_TARGET_BOT_WIN_RATE - MIN_TARGET_BOT_WIN_RATE),
    0,
    1
  );

  return {
    gamesPlayed: normalizedGames,
    wins: normalizedWins,
    baseTargetBotWinRate,
    winBonus,
    targetBotWinRate,
    strength: Number(strength.toFixed(4)),
  };
};

const getOpeningHandSwapCount = (profile = {}, random = Math.random) => {
  const strength = clamp(Number(profile.strength || 0), 0, 1);
  const expectedSwaps = MIN_OPENING_SWAPS +
    (strength * (MAX_OPENING_SWAPS - MIN_OPENING_SWAPS));
  const wholeSwaps = Math.floor(expectedSwaps);
  const fractionalSwap = expectedSwaps - wholeSwaps;
  return Math.min(
    MAX_OPENING_SWAPS,
    wholeSwaps + (fractionalSwap > 0 && random() < fractionalSwap ? 1 : 0)
  );
};

const getUsefulLaidCardPickChance = (profile = {}) => (
  clamp(Number(profile.strength || 0), 0, 1)
);

module.exports = {
  MAX_TARGET_BOT_WIN_RATE,
  MIN_TARGET_BOT_WIN_RATE,
  buildBotDifficultyProfile,
  getBaseTargetBotWinRate,
  getOpeningHandSwapCount,
  getUsefulLaidCardPickChance,
};
