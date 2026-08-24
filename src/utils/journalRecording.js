const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
const { JOURNAL_EVENT_TYPES, PAYMENT_METHODS, PAYMENT_STATUS, USER_ROLES } = require("../constants/enums");
const { appendJournalEntry } = require("../services/financialJournal.service");

const journalBusinessKey = {
  paymentCollection: (paymentId) => `payment:${paymentId}:collection`,
  paymentReversal: (paymentId, clientRequestId) => `payment:${paymentId}:reversal:${clientRequestId}`,
  collectionAdjustment: (correctionId) => `correction:${correctionId}:adjustment`,
  cashSubmission: (submissionId) => `cash-submission:${submissionId}`,
  cashSubmissionReversal: (submissionId) => `cash-submission:${submissionId}:reversal`,
};

const collectionAccountsForPayment = (paymentMethod, collectedByRole) => {
  if (paymentMethod === PAYMENT_METHODS.CASH && collectedByRole === USER_ROLES.STAFF) {
    return {
      debitAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
    };
  }

  return {
    debitAccount: JOURNAL_ACCOUNTS.VAULT,
    creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
  };
};

const staffMetadata = (payment) => {
  if (payment.collectedByRole === USER_ROLES.STAFF && payment.collectedBy) {
    return { staffId: payment.collectedBy };
  }
  return {};
};

const recordCollectionReceived = async (
  { payment, actor, clientRequestId },
  session
) =>
  appendJournalEntry(
    {
      businessKey: journalBusinessKey.paymentCollection(payment._id),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
      amount: payment.amount,
      ...collectionAccountsForPayment(payment.paymentMethod, payment.collectedByRole),
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "Payment",
      sourceRecordId: payment._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: payment.paymentDate || new Date(),
      metadata: {
        paymentMethod: payment.paymentMethod,
        receiptNumber: payment.receiptNumber,
        ...staffMetadata(payment),
      },
    },
    session
  );

const recordCollectionReversal = async (
  { payment, actor, clientRequestId, originalEntryId = null, effectiveAmount, effectiveMethod },
  session
) => {
  const amount = effectiveAmount ?? payment.amount;
  const paymentMethod = effectiveMethod ?? payment.paymentMethod;
  const originalAccounts = collectionAccountsForPayment(
    paymentMethod,
    payment.collectedByRole
  );

  return appendJournalEntry(
    {
      businessKey: journalBusinessKey.paymentReversal(payment._id, clientRequestId),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_REVERSAL,
      amount,
      debitAccount: originalAccounts.creditAccount,
      creditAccount: originalAccounts.debitAccount,
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "Payment",
      sourceRecordId: payment._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      reversalOf: originalEntryId,
      metadata: {
        paymentMethod,
        receiptNumber: payment.receiptNumber,
        ...staffMetadata(payment),
      },
    },
    session
  );
};

const recordEffectiveStateCorrection = async (
  { correction, payment, before, after, actor, clientRequestId },
  session
) => {
  if (after.status === PAYMENT_STATUS.REVERSED) {
    return recordCollectionReversal(
      {
        payment,
        actor,
        clientRequestId,
        effectiveAmount: before.amount,
        effectiveMethod: before.paymentMethod,
      },
      session
    );
  }

  const journalEntries = [];
  const beforeAccounts = collectionAccountsForPayment(
    before.paymentMethod,
    payment.collectedByRole
  );
  const afterAccounts = collectionAccountsForPayment(after.paymentMethod, payment.collectedByRole);

  const financialStateChanged =
    before.amount !== after.amount || before.paymentMethod !== after.paymentMethod;

  if (!financialStateChanged) {
    return journalEntries;
  }

  if (before.paymentMethod !== after.paymentMethod) {
    journalEntries.push(
      await appendJournalEntry(
        {
          businessKey: `correction:${correction._id}:unwind`,
          eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
          amount: before.amount,
          debitAccount: beforeAccounts.creditAccount,
          creditAccount: beforeAccounts.debitAccount,
          customer: payment.customer,
          scheme: payment.scheme,
          sourceRecordType: "PaymentCorrection",
          sourceRecordId: correction._id,
          actor: actor._id,
          actorRole: actor.role,
          clientRequestId,
          effectiveAt: new Date(),
          metadata: {
            phase: "unwind",
            previousAmount: before.amount,
            previousMethod: before.paymentMethod,
            ...staffMetadata(payment),
          },
        },
        session
      )
    );
    journalEntries.push(
      await appendJournalEntry(
        {
          businessKey: `correction:${correction._id}:apply`,
          eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
          amount: after.amount,
          debitAccount: afterAccounts.debitAccount,
          creditAccount: afterAccounts.creditAccount,
          customer: payment.customer,
          scheme: payment.scheme,
          sourceRecordType: "PaymentCorrection",
          sourceRecordId: correction._id,
          actor: actor._id,
          actorRole: actor.role,
          clientRequestId,
          effectiveAt: new Date(),
          metadata: {
            phase: "apply",
            effectiveAmount: after.amount,
            effectiveMethod: after.paymentMethod,
            ...staffMetadata(payment),
          },
        },
        session
      )
    );
    return journalEntries;
  }

  const delta = after.amount - before.amount;
  if (delta === 0) {
    return journalEntries;
  }

  if (delta > 0) {
    journalEntries.push(
      await appendJournalEntry(
        {
          businessKey: journalBusinessKey.collectionAdjustment(correction._id),
          eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
          amount: delta,
          debitAccount: beforeAccounts.debitAccount,
          creditAccount: beforeAccounts.creditAccount,
          customer: payment.customer,
          scheme: payment.scheme,
          sourceRecordType: "PaymentCorrection",
          sourceRecordId: correction._id,
          actor: actor._id,
          actorRole: actor.role,
          clientRequestId,
          effectiveAt: new Date(),
          metadata: {
            previousAmount: before.amount,
            effectiveAmount: after.amount,
            paymentMethod: after.paymentMethod,
            ...staffMetadata(payment),
          },
        },
        session
      )
    );
  } else {
    journalEntries.push(
      await appendJournalEntry(
        {
          businessKey: journalBusinessKey.collectionAdjustment(correction._id),
          eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
          amount: Math.abs(delta),
          debitAccount: beforeAccounts.creditAccount,
          creditAccount: beforeAccounts.debitAccount,
          customer: payment.customer,
          scheme: payment.scheme,
          sourceRecordType: "PaymentCorrection",
          sourceRecordId: correction._id,
          actor: actor._id,
          actorRole: actor.role,
          clientRequestId,
          effectiveAt: new Date(),
          metadata: {
            previousAmount: before.amount,
            effectiveAmount: after.amount,
            paymentMethod: after.paymentMethod,
            ...staffMetadata(payment),
          },
        },
        session
      )
    );
  }

  return journalEntries;
};

const recordCollectionAdjustment = async (
  { correction, payment, effectiveAmount, actor, clientRequestId },
  session
) =>
  appendJournalEntry(
    {
      businessKey: journalBusinessKey.collectionAdjustment(correction._id),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
      amount: Math.abs(effectiveAmount - payment.amount) || payment.amount,
      debitAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
      creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "PaymentCorrection",
      sourceRecordId: correction._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      metadata: {
        previousAmount: payment.amount,
        effectiveAmount,
      },
    },
    session
  );

const recordStaffCashSubmitted = async (
  { submission, actor, clientRequestId },
  session
) =>
  appendJournalEntry(
    {
      businessKey: journalBusinessKey.cashSubmission(submission._id),
      eventType: JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
      amount: submission.submittedAmount,
      debitAccount: JOURNAL_ACCOUNTS.VAULT,
      creditAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      customer: null,
      scheme: null,
      sourceRecordType: "CashSubmission",
      sourceRecordId: submission._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: submission.submissionDate || new Date(),
      metadata: {
        staffId: submission.staff,
      },
    },
    session
  );

const recordCashSubmissionReversal = async (
  { submission, actor, clientRequestId },
  session
) =>
  appendJournalEntry(
    {
      businessKey: journalBusinessKey.cashSubmissionReversal(submission._id),
      eventType: JOURNAL_EVENT_TYPES.VAULT_REVERSAL,
      amount: submission.submittedAmount,
      debitAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      creditAccount: JOURNAL_ACCOUNTS.VAULT,
      sourceRecordType: "CashSubmission",
      sourceRecordId: submission._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      metadata: {
        staffId: submission.staff,
        reversal: true,
      },
    },
    session
  );

module.exports = {
  journalBusinessKey,
  recordCollectionReceived,
  recordCollectionReversal,
  recordCollectionAdjustment,
  recordEffectiveStateCorrection,
  recordStaffCashSubmitted,
  recordCashSubmissionReversal,
};
