const { isUtcMidnightInstant, toBusinessInstant } = require("../../utils/date");

const id = "016_fix_cash_submission_utc_midnight_dates";

/**
 * Admin submits cash with YYYY-MM-DD; z.coerce.date() stored UTC midnight
 * (shown as 5:30 AM IST). Rewrite to Asia/Kolkata start-of-day.
 */
const up = async (db) => {
  const collection = db.collection("cashsubmissions");
  const cursor = collection.find({
    submissionDate: { $type: "date" },
  }).project({ _id: 1, submissionDate: 1 });

  let scanned = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const row = await cursor.next();
    scanned += 1;
    if (!isUtcMidnightInstant(row.submissionDate)) {
      continue;
    }

    const next = toBusinessInstant(row.submissionDate);
    if (next.getTime() === new Date(row.submissionDate).getTime()) {
      continue;
    }

    await collection.updateOne(
      { _id: row._id },
      {
        $set: {
          submissionDate: next,
          updatedAt: new Date(),
        },
      }
    );
    updated += 1;
  }

  const probe = toBusinessInstant(new Date("2026-10-10T00:00:00.000Z"));
  if (probe.toISOString() !== "2026-10-09T18:30:00.000Z") {
    throw new Error(`Unexpected toBusinessInstant probe result: ${probe.toISOString()}`);
  }

  return { scanned, updated };
};

const verify = async (db) => {
  const rows = await db
    .collection("cashsubmissions")
    .find({}, { projection: { submissionDate: 1 } })
    .toArray();
  const leftover = rows.filter((row) => isUtcMidnightInstant(row.submissionDate)).length;
  if (leftover > 0) {
    throw new Error(`Still have ${leftover} cash submission(s) with UTC-midnight submissionDate`);
  }
  return { leftoverUtcMidnightSubmissions: leftover };
};

module.exports = { id, up, verify };
