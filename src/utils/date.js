const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const weekOfYear = require("dayjs/plugin/weekOfYear");
const isoWeek = require("dayjs/plugin/isoWeek");

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);

const BUSINESS_TIMEZONE = "Asia/Kolkata";

const toDate = (value) => (value instanceof Date ? value : new Date(value));

const isDateOnlyInput = (value) => {
  if (value instanceof Date) {
    return false;
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
};

const toBusinessInstant = (value) => {
  if (value === null || value === undefined || value === "") {
    return new Date();
  }

  if (isDateOnlyInput(value)) {
    return dayjs.tz(value.trim(), BUSINESS_TIMEZONE).startOf("day").toDate();
  }

  const parsed = toDate(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date value.");
  }
  return parsed;
};

const addCalendarMonthsInBusinessTz = (date, months) =>
  dayjs(toBusinessInstant(date)).tz(BUSINESS_TIMEZONE).add(months, "month").toDate();

const addMonths = (date, months) => addCalendarMonthsInBusinessTz(date, months);

const inBusinessTz = (date = new Date()) => dayjs(toDate(date)).tz(BUSINESS_TIMEZONE);

const startOfDay = (date = new Date()) => inBusinessTz(date).startOf("day").toDate();

const endOfDay = (date = new Date()) => inBusinessTz(date).endOf("day").toDate();

/** Week starts Monday (ISO) in Asia/Kolkata. */
const startOfWeek = (date = new Date()) => inBusinessTz(date).startOf("isoWeek").toDate();

const startOfMonth = (date = new Date()) => inBusinessTz(date).startOf("month").toDate();

const startOfYear = (date = new Date()) => inBusinessTz(date).startOf("year").toDate();

const businessYear = (date = new Date()) => inBusinessTz(date).year();

const businessDayKey = (date = new Date()) => inBusinessTz(date).format("YYYY-MM-DD");

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
  BUSINESS_TIMEZONE,
  toDate,
  toBusinessInstant,
  inBusinessTz,
  addCalendarMonthsInBusinessTz,
  addMonths,
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  startOfYear,
  businessYear,
  businessDayKey,
  isSameOrBefore,
  isAfter,
  parseDateRange,
  buildPaymentDateMatch,
};
