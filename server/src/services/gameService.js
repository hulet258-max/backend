// services/gameService.js

function generateShuffledDeck(playerCount) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

  // Use one deck for 2 players, two decks for 3 players, and three decks for 4 players.
  const numberOfDecks = Math.max(1, Math.min(Number(playerCount || 2) - 1, 3));

  // Create a single 54-card deck (52 standard cards + 2 jokers)
  const createSingleDeckWithJokers = () => {
    const singleDeck = [];

    // Generate the 52 standard cards
    for (let suit of suits) {
      for (let rank of ranks) {
        singleDeck.push({
          rank,
          suit,
          color: (suit === "♥" || suit === "♦") ? "#e74c3c" : "#111"
        });
      }
    }

    // Add two jokers: one red, one black
    singleDeck.push({ rank: "JOKER", suit: "🃏", color: "#e74c3c" });
    singleDeck.push({ rank: "JOKER", suit: "🃏", color: "#111" });

    return singleDeck;
  };

  // Build the full deck with the required number of decks
  let deck = [];
  for (let i = 0; i < numberOfDecks; i++) {
    deck = deck.concat(createSingleDeckWithJokers());
  }

  // Fisher-Yates Shuffle algorithm
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function createInitialGameState(playerIds) {
  const deck = generateShuffledDeck(playerIds.length);
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
