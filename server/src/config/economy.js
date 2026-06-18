const COIN_BIRR_VALUE = 5;
const MIN_DEPOSIT_BIRR = 20;
const MIN_DEPOSIT_COINS = MIN_DEPOSIT_BIRR / COIN_BIRR_VALUE;
const MIN_ROOM_ENTRY_COINS = 2;
const MIN_WITHDRAW_COINS = 1;
const REFERRAL_REWARD_COINS = 1;
const WELCOME_GIFT_COINS = 2;

function toWholeCoins(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return NaN;
  return Math.round(parsed);
}

function isWholeCoinAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed);
}

function birrToCoins(birrAmount) {
  const parsed = Number(birrAmount);
  if (!Number.isFinite(parsed)) return NaN;
  return Math.floor(parsed / COIN_BIRR_VALUE);
}

module.exports = {
  COIN_BIRR_VALUE,
  MIN_DEPOSIT_BIRR,
  MIN_DEPOSIT_COINS,
  MIN_ROOM_ENTRY_COINS,
  MIN_WITHDRAW_COINS,
  REFERRAL_REWARD_COINS,
  WELCOME_GIFT_COINS,
  birrToCoins,
  isWholeCoinAmount,
  toWholeCoins,
};
