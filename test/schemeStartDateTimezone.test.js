const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { toBusinessInstant, isUtcMidnightInstant } = require("../src/utils/date");
const { calculateSchemeDates } = require("../src/services/scheme.service");

/** Mirrors scheme.controller createSchemeSchema startDate field. */
const startDateSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z
    .union([
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
      z.date(),
      z.string().min(1),
    ])
    .optional()
);

describe("scheme startDate business timezone", () => {
  it("keeps YYYY-MM-DD strings through validation (does not coerce to UTC midnight)", () => {
    const parsed = startDateSchema.parse("2026-09-27");
    assert.equal(parsed, "2026-09-27");
    assert.equal(typeof parsed, "string");

    const dates = calculateSchemeDates(parsed);
    assert.equal(dates.startDate.toISOString(), "2026-09-26T18:30:00.000Z");
  });

  it("reinterprets legacy UTC-midnight Date values as IST start-of-day", () => {
    const legacy = new Date("2026-09-27T00:00:00.000Z");
    assert.equal(isUtcMidnightInstant(legacy), true);
    assert.equal(
      toBusinessInstant(legacy).toISOString(),
      "2026-09-26T18:30:00.000Z"
    );
  });

  it("does not shift real non-midnight timestamps", () => {
    const real = new Date("2026-09-26T20:22:59.627Z");
    assert.equal(isUtcMidnightInstant(real), false);
    assert.equal(toBusinessInstant(real).toISOString(), real.toISOString());
  });
});
