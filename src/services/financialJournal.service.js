const crypto = require("crypto");
const mongoose = require("mongoose");
const FinancialJournal = require("../models/financialJournal.model");
const { JOURNAL_EVENT_TYPES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const isDuplicateKeyError = (error) => error?.code === 11000;

const normalizeValue = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (typeof value === "object") {
    if (value?._id) {
      return String(value._id);
    }
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeValue(value[key]);
        return acc;
      }, {});
  }
  return typeof value === "string" ? value : String(value);
};

const stableSerialize = (value) => JSON.stringify(normalizeValue(value));

const journalEntryMatches = (existing, expected) =>
  existing.eventType === expected.eventType &&
  existing.amount === expected.amount &&
  existing.debitAccount === expected.debitAccount &&
  existing.creditAccount === expected.creditAccount &&
  String(existing.customer || "") === String(expected.customer || "") &&
  String(existing.scheme || "") === String(expected.scheme || "") &&
  String(existing.sourceRecordType || "") === String(expected.sourceRecordType || "") &&
  String(existing.sourceRecordId || "") === String(expected.sourceRecordId || "") &&
  String(existing.actor || "") === String(expected.actor || "") &&
  String(existing.actorRole || "") === String(expected.actorRole || "") &&
  String(existing.clientRequestId || "") === String(expected.clientRequestId || "") &&
  String(existing.reversalOf || "") === String(expected.reversalOf || "") &&
  String(existing.compensates || "") === String(expected.compensates || "") &&
  stableSerialize(existing.metadata || {}) === stableSerialize(expected.metadata || {});

const appendJournalEntry = async (
  {
    businessKey,
    eventType,
    amount,
    debitAccount,
    creditAccount,
    customer = null,
    scheme = null,
    sourceRecordType = "",
    sourceRecordId = null,
    actor = null,
    actorRole = "",
    clientRequestId = "",
    effectiveAt = new Date(),
    reversalOf = null,
    compensates = null,
    formulaVersion = "",
    inputSnapshot = null,
    metadata = {},
  },
  session = null
) => {
  if (!businessKey?.trim()) {
    throw new ApiError(400, "Journal businessKey is required.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ApiError(400, "Journal amount must be a positive whole rupee value.");
  }
  if (debitAccount === creditAccount) {
    throw new ApiError(409, "Journal entry must affect two different accounts.", [], {
      code: ERROR_CODES.JOURNAL_BUSINESS_KEY_MISMATCH,
      retryable: false,
    });
  }

  const trimmedKey = businessKey.trim();
  const expectedPayload = {
    eventType,
    amount,
    debitAccount,
    creditAccount,
    customer,
    scheme,
    sourceRecordType: sourceRecordType || "",
    sourceRecordId,
    actor,
    actorRole,
    clientRequestId: clientRequestId?.trim() || "",
    reversalOf,
    compensates,
    metadata,
  };

  const existing = await FinancialJournal.findOne({ businessKey: trimmedKey }).session(
    session || null
  );
  if (existing) {
    if (!journalEntryMatches(existing, expectedPayload)) {
      throw new ApiError(409, "Journal businessKey was reused with a different payload.", [], {
        code: ERROR_CODES.JOURNAL_BUSINESS_KEY_MISMATCH,
        retryable: false,
      });
    }
    return existing;
  }

  const entryId = crypto.randomUUID();
  const payload = {
    entryId,
    businessKey: trimmedKey,
    eventType,
    amount,
    debitAccount,
    creditAccount,
    customer,
    scheme,
    sourceRecordType,
    sourceRecordId,
    actor,
    actorRole,
    clientRequestId: clientRequestId?.trim() || "",
    effectiveAt,
    recordedAt: new Date(),
    reversalOf,
    compensates,
    formulaVersion,
    inputSnapshot,
    metadata,
  };

  try {
    const [entry] = await FinancialJournal.create([payload], { session });
    return entry;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const duplicate = await FinancialJournal.findOne({ businessKey: trimmedKey }).session(
        session || null
      );
      if (duplicate) {
        if (!journalEntryMatches(duplicate, expectedPayload)) {
          throw new ApiError(409, "Journal businessKey was reused with a different payload.", [], {
            code: ERROR_CODES.JOURNAL_BUSINESS_KEY_MISMATCH,
            retryable: false,
          });
        }
        return duplicate;
      }
    }
    throw error;
  }
};

const getJournalEntriesForScheme = async (schemeId, session = null) =>
  FinancialJournal.find({ scheme: schemeId })
    .sort({ effectiveAt: 1, recordedAt: 1 })
    .session(session || null)
    .lean();

const ASSET_ACCOUNTS = new Set([
  require("../constants/journalAccounts").JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
  require("../constants/journalAccounts").JOURNAL_ACCOUNTS.VAULT,
]);

const getJournalAccountBalance = async (account, session = null) => {
  const rows = await FinancialJournal.aggregate([
    {
      $match: {
        $or: [{ debitAccount: account }, { creditAccount: account }],
      },
    },
    {
      $group: {
        _id: null,
        debits: {
          $sum: {
            $cond: [{ $eq: ["$debitAccount", account] }, "$amount", 0],
          },
        },
        credits: {
          $sum: {
            $cond: [{ $eq: ["$creditAccount", account] }, "$amount", 0],
          },
        },
      },
    },
  ]).session(session || null);

  const debits = rows[0]?.debits || 0;
  const credits = rows[0]?.credits || 0;
  return ASSET_ACCOUNTS.has(account) ? debits - credits : credits - debits;
};

const getStaffCustodyBalance = async (staffId, session = null) => {
  const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
  const account = JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY;
  const staffObjectId =
    staffId instanceof mongoose.Types.ObjectId
      ? staffId
      : new mongoose.Types.ObjectId(String(staffId));

  const rows = await FinancialJournal.aggregate([
    {
      $match: {
        $and: [
          { $or: [{ debitAccount: account }, { creditAccount: account }] },
          {
            $or: [
              { actor: staffObjectId },
              { "metadata.staffId": staffObjectId },
              { "metadata.staffId": String(staffId) },
            ],
          },
        ],
      },
    },
    {
      $group: {
        _id: null,
        debits: {
          $sum: {
            $cond: [{ $eq: ["$debitAccount", account] }, "$amount", 0],
          },
        },
        credits: {
          $sum: {
            $cond: [{ $eq: ["$creditAccount", account] }, "$amount", 0],
          },
        },
      },
    },
  ]).session(session || null);

  const debits = rows[0]?.debits || 0;
  const credits = rows[0]?.credits || 0;
  return debits - credits;
};

const getStaffCustodyBalanceMap = async (staffIds = [], session = null) => {
  const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
  const account = JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY;
  const uniqueIds = [...new Set(staffIds.map((id) => String(id)))].filter(Boolean);
  const map = new Map(uniqueIds.map((id) => [id, 0]));
  if (!uniqueIds.length) return map;

  const objectIds = uniqueIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const rows = await FinancialJournal.aggregate([
    {
      $match: {
        $or: [{ debitAccount: account }, { creditAccount: account }],
      },
    },
    {
      $addFields: {
        staffKey: { $ifNull: ["$metadata.staffId", "$actor"] },
      },
    },
    {
      $match: {
        $or: [{ staffKey: { $in: objectIds } }, { staffKey: { $in: uniqueIds } }],
      },
    },
    {
      $group: {
        _id: { $toString: "$staffKey" },
        debits: {
          $sum: { $cond: [{ $eq: ["$debitAccount", account] }, "$amount", 0] },
        },
        credits: {
          $sum: { $cond: [{ $eq: ["$creditAccount", account] }, "$amount", 0] },
        },
      },
    },
  ]).session(session || null);

  for (const row of rows) {
    map.set(String(row._id), (row.debits || 0) - (row.credits || 0));
  }
  return map;
};

const getEventTypeTotal = async (eventType, session = null) => {
  const rows = await FinancialJournal.aggregate([
    { $match: { eventType } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]).session(session || null);
  return rows[0]?.total || 0;
};

const getSettlementPaidTotal = async (session = null) =>
  getEventTypeTotal(JOURNAL_EVENT_TYPES.SETTLEMENT_PAID, session);

const assertJournalImmutable = () => {
  throw new ApiError(409, "Financial journal entries are immutable.", [], {
    code: ERROR_CODES.JOURNAL_ENTRY_IMMUTABLE,
    retryable: false,
  });
};

module.exports = {
  appendJournalEntry,
  getJournalEntriesForScheme,
  getJournalAccountBalance,
  getStaffCustodyBalance,
  getStaffCustodyBalanceMap,
  getEventTypeTotal,
  getSettlementPaidTotal,
  assertJournalImmutable,
};
