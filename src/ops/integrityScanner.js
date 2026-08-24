const mongoose = require("mongoose");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const Customer = require("../models/customer.model");
const User = require("../models/user.model");
const FinancialJournal = require("../models/financialJournal.model");
const CashSubmission = require("../models/cashSubmission.model");
const OutboxEvent = require("../models/outboxEvent.model");
const {
  SCHEME_STATUS,
  PAYMENT_STATUS,
  SETTLEMENT_WORKFLOW_STATUS,
  SETTLEMENT_STATUSES,
  CASH_SUBMISSION_STATUS,
  CORRECTION_STATUS,
} = require("../constants/enums");
const { verifyRequiredIndexes } = require("./requiredIndexes");
const { verifyMigrationsApplied, loadMigrationFiles } = require("../migrations/runMigrations");
const { buildReconciliationSummary } = require("../services/reconciliation.service");
const { deriveSchemeWindow } = require("../utils/schemeWindow");
const { loadSchemeLedgerContext } = require("../utils/paymentLedger");
const { getLedgerPeriodTotals } = require("../utils/ledgerValidation");
const { computeEntitlement } = require("../services/entitlement.service");

const CRITICAL = "critical";
const WARNING = "warning";
const DEFAULT_FINDING_LIMIT = 500;

const addFinding = (findings, severity, code, message, details = {}) => {
  findings.push({ severity, code, message, details });
};

const paginateFindings = (findings, { offset = 0, limit = DEFAULT_FINDING_LIMIT } = {}) => {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_FINDING_LIMIT), DEFAULT_FINDING_LIMIT);
  const page = findings.slice(safeOffset, safeOffset + safeLimit);
  return {
    findings: page,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      returned: page.length,
      total: findings.length,
      hasMore: safeOffset + page.length < findings.length,
      nextOffset: safeOffset + page.length < findings.length ? safeOffset + page.length : null,
    },
  };
};

const scanIntegrity = async ({ db, offset = 0, limit = DEFAULT_FINDING_LIMIT } = {}) => {
  const findings = [];
  const connectionDb = db || mongoose.connection.db;

  if (connectionDb) {
    try {
      await verifyMigrationsApplied(connectionDb);
    } catch (error) {
      addFinding(findings, CRITICAL, "MIGRATION_STATE", error.message);
    }

    try {
      await verifyRequiredIndexes(connectionDb);
    } catch (error) {
      addFinding(findings, CRITICAL, "INDEX_STATE", error.message);
    }

    const ambiguousMigrations = await connectionDb
      .collection("journal_migration_ambiguous")
      .find({})
      .limit(50)
      .toArray()
      .catch(() => []);
    for (const row of ambiguousMigrations) {
      addFinding(findings, CRITICAL, "MIGRATION_AMBIGUITY", "Legacy migration ambiguity requires manual decision.", row);
    }
  }

  const activeSchemes = await Scheme.aggregate([
    { $match: { status: SCHEME_STATUS.ACTIVE } },
    { $group: { _id: "$customer", count: { $sum: 1 }, schemeIds: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const row of activeSchemes) {
    addFinding(findings, CRITICAL, "MULTIPLE_ACTIVE_SCHEMES", "Customer has multiple ACTIVE schemes.", {
      customerId: row._id,
      schemeIds: row.schemeIds,
    });
  }

  const orphanCustomers = await Customer.find({ user: { $exists: true, $ne: null } }).lean();
  for (const customer of orphanCustomers) {
    const user = await User.findById(customer.user);
    if (!user) {
      addFinding(findings, WARNING, "ORPHAN_CUSTOMER_USER", "Customer references missing user.", {
        customerId: customer._id,
        userId: customer.user,
      });
    }
  }

  const payments = await Payment.find({ status: PAYMENT_STATUS.SUCCESS }).populate("scheme").lean();
  for (const payment of payments) {
    if (!payment.scheme) {
      addFinding(findings, WARNING, "ORPHAN_PAYMENT", "Payment references missing scheme.", {
        paymentId: payment._id,
      });
      continue;
    }

    const window = deriveSchemeWindow(payment.scheme);
    const paymentDate = new Date(payment.paymentDate);
    if (paymentDate >= new Date(window.maturityDate)) {
      addFinding(findings, CRITICAL, "PAYMENT_AFTER_MATURITY", "Payment at or after maturity.", {
        paymentId: payment._id,
        schemeId: payment.scheme._id,
        paymentDate,
      });
    }

    if (paymentDate < window.startDate || paymentDate >= window.maturityDate) {
      addFinding(findings, CRITICAL, "PAYMENT_OUTSIDE_WINDOW", "Payment outside scheme window.", {
        paymentId: payment._id,
        schemeId: payment.scheme._id,
        paymentDate,
      });
    }
  }

  const activeSchemeDocs = await Scheme.find({ status: SCHEME_STATUS.ACTIVE });
  for (const scheme of activeSchemeDocs) {
    const { entries } = await loadSchemeLedgerContext(scheme._id);
    const { firstPeriodPaid, laterPeriodPaid } = getLedgerPeriodTotals(scheme, entries);
    if (laterPeriodPaid > firstPeriodPaid) {
      addFinding(findings, CRITICAL, "CAP_VIOLATION", "Later-period effective total exceeds first-period total.", {
        schemeId: scheme._id,
        firstPeriodPaid,
        laterPeriodPaid,
      });
    }
  }

  const settledSchemes = await Scheme.find({ status: { $in: SETTLEMENT_STATUSES } });
  for (const scheme of settledSchemes) {
    const entitlement = await computeEntitlement(scheme._id);
    if (scheme.settlement?.amount != null && scheme.settlement.amount !== entitlement.finalEntitlement) {
      addFinding(findings, CRITICAL, "SETTLEMENT_ENTITLEMENT_MISMATCH", "Settlement amount differs from effective entitlement.", {
        schemeId: scheme._id,
        settlementAmount: scheme.settlement.amount,
        entitlementAmount: entitlement.finalEntitlement,
      });
    }

    const pendingCorrection = await PaymentCorrection.findOne({
      scheme: scheme._id,
      status: CORRECTION_STATUS.PENDING,
    });
    if (pendingCorrection) {
      addFinding(findings, CRITICAL, "MUTATION_AFTER_SETTLEMENT", "Pending correction exists on settled scheme.", {
        schemeId: scheme._id,
        correctionId: pendingCorrection._id,
      });
    }
  }

  const journalDupes = await FinancialJournal.aggregate([
    { $group: { _id: "$businessKey", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const row of journalDupes) {
    addFinding(findings, CRITICAL, "JOURNAL_DUPLICATE_BUSINESS_KEY", "Duplicate journal businessKey.", {
      businessKey: row._id,
      count: row.count,
    });
  }

  const selfBalancedEntries = await FinancialJournal.find({
    $expr: { $eq: ["$debitAccount", "$creditAccount"] },
  })
    .limit(50)
    .lean();
  for (const entry of selfBalancedEntries) {
    addFinding(findings, CRITICAL, "JOURNAL_SELF_BALANCE", "Journal entry debits and credits the same account.", {
      entryId: entry.entryId,
      businessKey: entry.businessKey,
    });
  }

  const reversedSubmissions = await CashSubmission.find({
    status: CASH_SUBMISSION_STATUS.REVERSED,
  }).lean();
  for (const submission of reversedSubmissions) {
    const reversalCount = await FinancialJournal.countDocuments({
      businessKey: `cash-submission:${submission._id}:reversal`,
    });
    if (reversalCount > 1) {
      addFinding(findings, CRITICAL, "DUPLICATE_CASH_SUBMISSION_REVERSAL", "Cash submission reversed more than once in journal.", {
        submissionId: submission._id,
        reversalCount,
      });
    }
  }

  try {
    const reconciliation = await buildReconciliationSummary();
    if (reconciliation.exceptions?.length) {
      for (const exception of reconciliation.exceptions) {
        addFinding(findings, CRITICAL, "CASH_RECONCILIATION", exception.code || "Cash mismatch.", exception);
      }
    }
  } catch (error) {
    addFinding(findings, WARNING, "CASH_RECONCILIATION_SCAN_FAILED", error.message);
  }

  const staleOutboxHours = Number(process.env.OUTBOX_STALE_HOURS || 1);
  const staleBefore = new Date(Date.now() - staleOutboxHours * 60 * 60 * 1000);
  const staleOutbox = await OutboxEvent.countDocuments({
    status: { $in: ["PENDING", "FAILED"] },
    createdAt: { $lte: staleBefore },
  });
  if (staleOutbox > 0) {
    addFinding(findings, WARNING, "OUTBOX_STALE", "Outbox events pending/failed beyond threshold.", {
      count: staleOutbox,
      staleBefore,
    });
  }

  const pendingSettlements = await Scheme.countDocuments({
    status: SCHEME_STATUS.ACTIVE,
    "settlementWorkflow.status": {
      $in: [
        "REQUESTED",
        "APPROVED",
        "PAYOUT_PENDING",
        "PAID",
      ],
    },
  });
  if (pendingSettlements > 0) {
    addFinding(findings, WARNING, "SETTLEMENT_PENDING", "Unsettled settlement workflows exist.", {
      count: pendingSettlements,
    });
  }

  const lockedWithOpenWorkflow = await Scheme.find({
    status: { $in: SETTLEMENT_STATUSES },
  }).lean();
  for (const scheme of lockedWithOpenWorkflow) {
    if (
      scheme.settlementWorkflow?.status &&
      scheme.settlementWorkflow.status !== SETTLEMENT_WORKFLOW_STATUS.FINALIZED
    ) {
      addFinding(findings, WARNING, "SETTLED_SCHEME_OPEN_WORKFLOW", "Settled scheme has non-final workflow state.", {
        schemeId: scheme._id,
        workflowStatus: scheme.settlementWorkflow.status,
      });
    }
  }

  const criticalCount = findings.filter((item) => item.severity === CRITICAL).length;
  const paged = paginateFindings(findings, { offset, limit });

  return {
    ok: criticalCount === 0,
    criticalCount,
    warningCount: findings.filter((item) => item.severity === WARNING).length,
    findings: paged.findings,
    pagination: paged.pagination,
    migrationCount: loadMigrationFiles().length,
    scannedAt: new Date().toISOString(),
  };
};

module.exports = {
  scanIntegrity,
  paginateFindings,
  CRITICAL,
  WARNING,
  DEFAULT_FINDING_LIMIT,
};
