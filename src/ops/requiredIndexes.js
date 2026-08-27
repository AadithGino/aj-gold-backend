const { SCHEME_STATUS, CORRECTION_STATUS } = require("../constants/enums");

const stringify = (value) => JSON.stringify(value ?? null);

const hasOrderedKeyShape = (indexKey, keyShape) => {
  const indexEntries = Object.entries(indexKey || {});
  const shapeEntries = Object.entries(keyShape || {});
  if (indexEntries.length !== shapeEntries.length) return false;
  return shapeEntries.every(
    ([field, direction], idx) =>
      indexEntries[idx]?.[0] === field && indexEntries[idx]?.[1] === direction
  );
};

const indexHasShape = (
  indexes,
  keyShape,
  {
    unique = false,
    partial = null,
    name = null,
    ttl = null,
    sparse = null,
    collation = null,
  } = {}
) =>
  indexes.some((index) => {
    if (!hasOrderedKeyShape(index.key, keyShape)) return false;
    if (unique && !index.unique) return false;
    if (name && index.name !== name) return false;
    if (partial) {
      if (stringify(index.partialFilterExpression) !== stringify(partial)) {
        return false;
      }
    }
    if (ttl !== null && index.expireAfterSeconds !== ttl) return false;
    if (sparse !== null && Boolean(index.sparse) !== sparse) return false;
    if (collation && stringify(index.collation) !== stringify(collation)) return false;
    return true;
  });

const REQUIRED_INDEXES = [
  {
    collection: "idempotencyrecords",
    key: { clientRequestId: 1, operationType: 1 },
    unique: true,
    label: "idempotency clientRequestId+operationType",
  },
  {
    collection: "paymentcorrections",
    key: { payment: 1 },
    unique: true,
    partial: { status: CORRECTION_STATUS.PENDING },
    label: "pending correction per payment",
  },
  {
    collection: "paymentcorrections",
    key: { payment: 1, version: 1 },
    unique: true,
    name: "uniq_payment_correction_version_approved",
    partial: {
      status: CORRECTION_STATUS.APPROVED,
      version: { $exists: true, $type: "number", $gt: 0 },
    },
    label: "approved correction version per payment",
  },
  {
    collection: "payments",
    key: { scheme: 1, status: 1, paymentDate: -1 },
    label: "payments by scheme/status/date",
  },
  {
    collection: "payments",
    key: { customer: 1, status: 1, paymentDate: -1 },
    label: "payments by customer/status/date",
  },
  {
    collection: "payments",
    key: { collectedBy: 1, paymentMethod: 1, status: 1, paymentDate: -1 },
    label: "payments by collector/method/status/date",
  },
  {
    collection: "cashsubmissions",
    key: { staff: 1, submissionDate: -1 },
    label: "cash submissions by staff/date",
  },
  {
    collection: "cashsubmissions",
    key: { staff: 1, status: 1, submissionDate: -1 },
    name: "staff_active_submissions",
    label: "cash submissions active lifecycle index",
  },
  {
    collection: "schemes",
    key: { customer: 1, status: 1, "settlement.settledAt": -1, _id: -1 },
    name: "schemes_customer_terminal_settledAt",
    partial: { status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] } },
    label: "customer terminal settlements by date",
  },
  {
    collection: "schemes",
    key: { "settlement.settledBy": 1, status: 1, "settlement.settledAt": -1, _id: -1 },
    name: "schemes_settledBy_terminal_settledAt",
    partial: { status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] } },
    label: "staff terminal settlements by date",
  },
  {
    collection: "schemes",
    key: { customer: 1 },
    unique: true,
    name: "uniq_customer_active_scheme",
    partial: { status: SCHEME_STATUS.ACTIVE },
    label: "one active scheme per customer",
  },
  {
    collection: "financialjournals",
    key: { businessKey: 1 },
    unique: true,
    label: "journal businessKey unique",
  },
  {
    collection: "financialjournals",
    key: { entryId: 1 },
    unique: true,
    label: "journal entryId unique",
  },
  {
    collection: "financialjournals",
    key: { scheme: 1, eventType: 1, effectiveAt: -1 },
    label: "journal scheme/event/effectiveAt",
  },
  {
    collection: "financialjournals",
    key: { customer: 1, effectiveAt: -1 },
    label: "journal customer/effectiveAt",
  },
  {
    collection: "outboxevents",
    key: { status: 1, nextAttemptAt: 1 },
    label: "outbox worker polling",
  },
  {
    collection: "outboxevents",
    key: { dedupeKey: 1 },
    unique: true,
    label: "outbox dedupe key unique",
  },
  {
    collection: "loginattempts",
    key: { key: 1 },
    unique: true,
    name: "uniq_login_attempt_key",
    label: "login attempt key unique",
  },
  {
    collection: "loginattempts",
    key: { expiresAt: 1 },
    name: "login_attempt_ttl",
    ttl: 0,
    label: "login attempt TTL",
  },
  {
    collection: "staffprofiles",
    key: { employeeCode: 1 },
    unique: true,
    name: "uniq_staff_employee_code",
    partial: { employeeCode: { $exists: true, $type: "string", $gt: "" } },
    label: "staff employeeCode unique",
  },
  {
    collection: "notifications",
    key: { deliveryKey: 1 },
    unique: true,
    name: "uniq_notification_delivery_key",
    partial: { deliveryKey: { $exists: true, $type: "string", $gt: "" } },
    label: "notification delivery dedupe",
  },
];

const verifyRequiredIndexes = async (db) => {
  const missing = [];

  for (const spec of REQUIRED_INDEXES) {
    let indexes;
    try {
      indexes = await db.collection(spec.collection).indexes();
    } catch (error) {
      if (error.codeName === "NamespaceNotFound") {
        missing.push(`${spec.collection}: collection missing (${spec.label})`);
        continue;
      }
      throw error;
    }

    if (
      !indexHasShape(indexes, spec.key, {
        unique: spec.unique,
        partial: spec.partial,
        name: spec.name,
        ttl: spec.ttl,
        sparse: spec.sparse,
        collation: spec.collation,
      })
    ) {
      missing.push(`${spec.collection}: ${spec.label}`);
    }
  }

  if (missing.length) {
    throw new Error(`Missing or incorrect required indexes: ${missing.join("; ")}`);
  }

  return { verified: REQUIRED_INDEXES.length };
};

module.exports = {
  REQUIRED_INDEXES,
  indexHasShape,
  verifyRequiredIndexes,
};
