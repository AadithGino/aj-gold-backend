const dayjs = require("dayjs");
const weekOfYear = require("dayjs/plugin/weekOfYear");
const isoWeek = require("dayjs/plugin/isoWeek");

dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);

const toDate = (value) => (value instanceof Date ? value : new Date(value));

const addMonths = (date, months) => dayjs(toDate(date)).add(months, "month").toDate();

const startOfDay = (date = new Date()) => dayjs(toDate(date)).startOf("day").toDate();

const endOfDay = (date = new Date()) => dayjs(toDate(date)).endOf("day").toDate();

const startOfWeek = (date = new Date()) => dayjs(toDate(date)).startOf("week").toDate();

const startOfMonth = (date = new Date()) => dayjs(toDate(date)).startOf("month").toDate();

const startOfYear = (date = new Date()) => dayjs(toDate(date)).startOf("year").toDate();

const isSameOrBefore = (dateA, dateB) =>
  dayjs(toDate(dateA)).isBefore(dayjs(toDate(dateB))) ||
  dayjs(toDate(dateA)).isSame(dayjs(toDate(dateB)), "day");

const isAfter = (dateA, dateB) => dayjs(toDate(dateA)).isAfter(dayjs(toDate(dateB)), "day");

const parseDateRange = (from, to) => {
  const range = {};

  if (from) {
    range.from = startOfDay(from);
  }

  if (to) {
    range.to = endOfDay(to);
  }

  if (range.from && range.to && range.from > range.to) {
    return { error: "Invalid date range: from must be before to." };
  }

  return range;
};

const buildPaymentDateMatch = (from, to) => {
  if (!from && !to) {
    return {};
  }

  const match = {};

  if (from) {
    match.$gte = from;
  }

  if (to) {
    match.$lte = to;
  }

  return { paymentDate: match };
};

module.exports = {
  toDate,
  addMonths,
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  startOfYear,
  isSameOrBefore,
  isAfter,
  parseDateRange,
  buildPaymentDateMatch,
};
