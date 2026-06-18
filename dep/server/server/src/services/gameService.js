// services/gameService.js

function generateShuffledDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  let deck = [];

  // Generate the 52 cards
  for (let suit of suits) {
    for (let rank of ranks) {
      deck.push({
        rank,
        suit,
        color: (suit === "♥" || suit === "♦") ? "#e74c3c" : "#111"
      });
    }
  }

  // Fisher-Yates Shuffle algorithm
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function createInitialGameState(playerIds) {
  const deck = generateShuffledDeck();
  const playerCards = {};

  // Deal cards to players
  playerIds.forEach((playerId, index) => {
    // Player 1 gets 11 cards, Player 2 gets 10 cards
    const cardsToDeal = index === 0 ? 11 : 10;
    playerCards[playerId] = deck.splice(0, cardsToDeal);
  });

  return {
    turn: playerIds[0],       // 1. Whose turn it is
    playerCards: playerCards, // 2. Each player's cards
    deck: deck,               // The remaining cards as the deck
    laidCards: []             // 3. Laid cards list
  };
}

module.exports = {
  createInitialGameState
};