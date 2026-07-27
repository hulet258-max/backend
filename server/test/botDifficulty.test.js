const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBotDifficultyProfile,
  getOpeningHandSwapCount,
  getUsefulLaidCardPickChance,
} = require("../src/services/botDifficulty");

test("uses the configured games-played tier boundaries", () => {
  const cases = [
    [0, 0.72], [9, 0.72],
    [10, 0.76], [24, 0.76],
    [25, 0.8], [39, 0.8],
    [40, 0.84], [500, 0.84],
  ];

  for (const [gamesPlayed, expected] of cases) {
    assert.equal(buildBotDifficultyProfile({ gamesPlayed }).baseTargetBotWinRate, expected);
  }
});

test("adds one percentage point per five wins", () => {
  assert.equal(buildBotDifficultyProfile({ gamesPlayed: 0, wins: 4 }).targetBotWinRate, 0.72);
  assert.equal(buildBotDifficultyProfile({ gamesPlayed: 0, wins: 5 }).targetBotWinRate, 0.73);
  assert.equal(buildBotDifficultyProfile({ gamesPlayed: 10, wins: 10 }).targetBotWinRate, 0.78);
  assert.equal(buildBotDifficultyProfile({ gamesPlayed: 25, wins: 24 }).targetBotWinRate, 0.84);
  assert.equal(buildBotDifficultyProfile({ gamesPlayed: 25, wins: 25 }).targetBotWinRate, 0.85);
});

test("caps the final target at ninety percent", () => {
  const profile = buildBotDifficultyProfile({ gamesPlayed: 40, wins: 1000 });
  assert.equal(profile.targetBotWinRate, 0.9);
  assert.equal(profile.winBonus, 0.06);
  assert.equal(profile.strength, 1);
});

test("higher targets produce monotonically stronger strategy parameters", () => {
  const targets = [
    buildBotDifficultyProfile({ gamesPlayed: 0, wins: 0 }),
    buildBotDifficultyProfile({ gamesPlayed: 10, wins: 0 }),
    buildBotDifficultyProfile({ gamesPlayed: 25, wins: 0 }),
    buildBotDifficultyProfile({ gamesPlayed: 40, wins: 0 }),
    buildBotDifficultyProfile({ gamesPlayed: 40, wins: 30 }),
  ];
  const swaps = targets.map((profile) => getOpeningHandSwapCount(profile, () => 0.99));
  const laidCardChances = targets.map(getUsefulLaidCardPickChance);

  // strengths: 0.1, 0.3, 0.5, 0.7, 1.0 → swaps with r=0.99: 2,3,4,4,6
  assert.deepEqual(swaps, [2, 3, 4, 4, 6]);
  assert.deepEqual(laidCardChances, [0.1, 0.3, 0.5, 0.7, 1]);
});

test("a one-point win bonus affects fractional opening-hand strength", () => {
  const profile = buildBotDifficultyProfile({ gamesPlayed: 0, wins: 5 });
  assert.equal(getOpeningHandSwapCount(profile, () => 0), 3);
  assert.equal(getOpeningHandSwapCount(profile, () => 0.99), 2);
});
