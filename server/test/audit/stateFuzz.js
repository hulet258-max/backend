const { createInitialGameState } = require("../../src/services/gameService");

const mulberry32 = (seed) => () => {
  let value = seed += 0x6D2B79F5;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
};

const signature = (card) => `${card.rank}|${card.suit}|${card.color}`;
const multiset = (cards) => cards.reduce((map, card) => {
  const key = signature(card);
  map.set(key, (map.get(key) || 0) + 1);
  return map;
}, new Map());

const sameMultiset = (left, right) => {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) if (right.get(key) !== count) return false;
  return true;
};

function runStateFuzz({ sequences = 10_000, seed = 1729 } = {}) {
  const random = mulberry32(seed);
  const failures = [];
  let actions = 0;

  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const playerCount = 2 + Math.floor(random() * 3);
    const players = Array.from({ length: playerCount }, (_, index) => `p-${index}`);
    const starter = players[Math.floor(random() * players.length)];
    const state = createInitialGameState(players, starter);
    const originalCards = Object.values(state.playerCards).flat().concat(state.deck, state.laidCards);
    const originalSet = multiset(originalCards);

    for (let step = 0; step < 60; step += 1) {
      const current = String(state.turn);
      const hand = state.playerCards[current];
      if (!hand) {
        failures.push({ sequence, step, reason: "turn-points-to-missing-player", current });
        break;
      }
      if (hand.length === 10) {
        if (!state.deck.length && state.laidCards.length > 1) {
          const top = state.laidCards.pop();
          state.deck.push(...state.laidCards.splice(0));
          state.laidCards.push(top);
        }
        if (!state.deck.length) break;
        hand.push(state.deck.pop());
      } else if (hand.length === 11) {
        const index = Math.floor(random() * hand.length);
        state.laidCards.push(hand.splice(index, 1)[0]);
        const playerIndex = players.indexOf(current);
        state.turn = players[(playerIndex + 1) % players.length];
      } else {
        failures.push({ sequence, step, reason: "illegal-hand-size", current, size: hand.length });
        break;
      }
      actions += 1;

      const allCards = Object.values(state.playerCards).flat().concat(state.deck, state.laidCards);
      if (!sameMultiset(originalSet, multiset(allCards))) {
        failures.push({ sequence, step, reason: "card-conservation-failed" });
        break;
      }
    }
  }

  return { sequences, seed, actions, failures: failures.slice(0, 25), failureCount: failures.length };
}

module.exports = { runStateFuzz };

