const { isUtcMidnightInstant, toBusinessInstant } = require("../../utils/date");
const { calculateSchemeDates } = require("../../services/scheme.service");

const id = "015_fix_scheme_utc_midnight_start_dates";

const utcYmd = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Schemes created via z.coerce.date() on YYYY-MM-DD were stored at UTC midnight
 * (05:30 IST). Rewrite start/sixMonth/maturity to Asia/Kolkata start-of-day.
 */
const up = async (db) => {
  const schemes = db.collection("schemes");
  const cursor = schemes.find({
    startDate: { $type: "date" },
  }).project({
    _id: 1,
    enrollmentNumber: 1,
    startDate: 1,
    sixMonthDate: 1,
    maturityDate: 1,
  });

  let scanned = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const scheme = await cursor.next();
    scanned += 1;
    if (!isUtcMidnightInstant(scheme.startDate)) {
      continue;
    }

    const dates = calculateSchemeDates(utcYmd(scheme.startDate));
    const nextStart = dates.startDate;
    const nextSix = dates.sixMonthDate;
    const nextMaturity = dates.maturityDate;

    // Idempotent: already-normalized docs no-op.
    if (
      nextStart.getTime() === new Date(scheme.startDate).getTime() &&
      nextSix.getTime() === new Date(scheme.sixMonthDate).getTime() &&
      nextMaturity.getTime() === new Date(scheme.maturityDate).getTime()
    ) {
      continue;
    }

    await schemes.updateOne(
      { _id: scheme._id },
      {
        $set: {
          startDate: nextStart,
          sixMonthDate: nextSix,
          maturityDate: nextMaturity,
          updatedAt: new Date(),
        },
      }
    );
    updated += 1;
  }

  // Sanity: a known UTC-midnight shape must normalize to IST midnight.
  const probe = toBusinessInstant(new Date("2026-09-27T00:00:00.000Z"));
  if (probe.toISOString() !== "2026-09-26T18:30:00.000Z") {
    throw new Error(`Unexpected toBusinessInstant probe result: ${probe.toISOString()}`);
  }

  return { scanned, updated };
};

const verify = async (db) => {
  const leftover = await db.collection("schemes").countDocuments({
    $expr: {
      $and: [
        { $eq: [{ $hour: "$startDate" }, 0] },
        { $eq: [{ $minute: "$startDate" }, 0] },
        { $eq: [{ $second: "$startDate" }, 0] },
        { $eq: [{ $millisecond: "$startDate" }, 0] },
      ],
    },
  });

  // Mongo $hour is UTC for Date fields — leftover UTC midnights should be 0 after up().
  if (leftover > 0) {
    throw new Error(`Still have ${leftover} scheme(s) with UTC-midnight startDate`);
  }
  return { leftoverUtcMidnightStarts: leftover };
};

module.exports = { id, up, verify };
