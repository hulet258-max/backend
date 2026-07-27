const MIN_DEPOSIT_BIRR = 20;
const MIN_ROOM_ENTRY_BIRR = 10;
const ROOM_ENTRY_STEP_BIRR = 5;
const MIN_WITHDRAW_BIRR = 10;
const MIN_WITHDRAWAL_GAMES = 6;
const MIN_WITHDRAWAL_PLAY_DAYS = 3;
const MIN_REMAINING_BALANCE_BIRR = 20;
const DAILY_WITHDRAWAL_LIMIT_BIRR = 100;
const MIN_COMMISSION_BIRR = 1;
const MANAGED_BOT_STARTING_BALANCE_BIRR = 20000;
const REFERRAL_REWARD_BIRR = 2;
const WELCOME_GIFT_BIRR = 10;

function toWholeBirr(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return NaN;
  return Math.round(parsed);
}

function isWholeBirrAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed);
}

function isValidRoomEntryBirr(value) {
  const parsed = Number(value);
  return isWholeBirrAmount(parsed) &&
    parsed >= MIN_ROOM_ENTRY_BIRR &&
    parsed % ROOM_ENTRY_STEP_BIRR === 0;
}

function birrToBalance(birrAmount) {
  const parsed = Number(birrAmount);
  if (!Number.isFinite(parsed)) return NaN;
  return parsed;
}

module.exports = {
  MIN_DEPOSIT_BIRR,
  MIN_ROOM_ENTRY_BIRR,
  ROOM_ENTRY_STEP_BIRR,
  MIN_WITHDRAW_BIRR,
  MIN_WITHDRAWAL_GAMES,
  MIN_WITHDRAWAL_PLAY_DAYS,
  MIN_REMAINING_BALANCE_BIRR,
  DAILY_WITHDRAWAL_LIMIT_BIRR,
  MIN_COMMISSION_BIRR,
  MANAGED_BOT_STARTING_BALANCE_BIRR,
  REFERRAL_REWARD_BIRR,
  WELCOME_GIFT_BIRR,
  birrToBalance,
  isValidRoomEntryBirr,
  isWholeBirrAmount,
  toWholeBirr,
};
