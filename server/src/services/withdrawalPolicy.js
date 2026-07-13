const WITHDRAWAL_WAIT_DAYS = 30;
const SECONDS_PER_HOUR = 60 * 60;
const HOURS_PER_DAY = 24;

function splitRemainingWithdrawalTime(remainingSeconds) {
  const totalHours = Math.max(0, Math.ceil(Number(remainingSeconds || 0) / SECONDS_PER_HOUR));
  return {
    remainingDays: Math.floor(totalHours / HOURS_PER_DAY),
    remainingHours: totalHours % HOURS_PER_DAY,
  };
}

module.exports = {
  WITHDRAWAL_WAIT_DAYS,
  splitRemainingWithdrawalTime,
};
