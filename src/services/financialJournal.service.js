const crypto = require("crypto");
const mongoose = require("mongoose");
const FinancialJournal = require("../models/financialJournal.model");
const { JOURNAL_EVENT_TYPES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const isDuplicateKeyError = (error) => error?.code === 11000;

const journalEntryMatches = (existing, expected) =>
  existing.eventType === expected.eventType &&
  existing.amount === expected.amount &&
  existing.debitAccount === expected.debitAccount &&
  existing.creditAccount === expected.creditAccount &&
  String(existing.sourceRecordType || "") === String(expected.sourceRecordType || "") &&
  String(existing.sourceRecordId || "") === String(expected.sourceRecordId || "");

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

  const trimmedKey = businessKey.trim();
  const expectedPayload = {
    eventType,
    amount,
    debitAccount,
    creditAccount,
    sourceRecordType: sourceRecordType || "",
    sourceRecordId,
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

const getEventTypeTotal = async (eventType, session = null) => {
  const rows = await FinancialJournal.aggregate([
    { $match: { eventType } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]).session(session || null);
  return rows[0]?.total || 0;
};

const getSettlementPaidTotal = async (session = null) =>
  getEventTypeTotal(JOURNAL_EVENT_TYPES.SETTLEMENT_PAID, session);

const getSettlementAuthorizedTotal = async (session = null) =>
  getEventTypeTotal(JOURNAL_EVENT_TYPES.SETTLEMENT_AUTHORIZED, session);

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
  getEventTypeTotal,
  getSettlementPaidTotal,
  getSettlementAuthorizedTotal,
  assertJournalImmutable,
};
