const crypto = require("crypto");
const OutboxEvent = require("../models/outboxEvent.model");
const { OUTBOX_STATUS } = require("../models/outboxEvent.model");
const Notification = require("../models/notification.model");

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const OUTBOX_LEASE_MS = Number(process.env.OUTBOX_LEASE_MS || 60_000);
const workerOwner = () => `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

const computeNextAttempt = (attempts) => {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, 60_000);
  return new Date(Date.now() + delay);
};

const enqueueOutboxEvent = async ({ topic, dedupeKey, payload }, session = null) => {
  const trimmedKey = dedupeKey?.trim();
  if (!trimmedKey) {
    throw new Error("Outbox dedupeKey is required.");
  }

  const existing = await OutboxEvent.findOne({ dedupeKey: trimmedKey }).session(session || null);
  if (existing) {
    return existing;
  }

  try {
    const [event] = await OutboxEvent.create(
      [
        {
          topic,
          dedupeKey: trimmedKey,
          payload,
          status: OUTBOX_STATUS.PENDING,
          nextAttemptAt: new Date(),
        },
      ],
      { session }
    );
    return event;
  } catch (error) {
    if (error?.code === 11000) {
      return OutboxEvent.findOne({ dedupeKey: trimmedKey }).session(session || null);
    }
    throw error;
  }
};

const deliverInAppNotification = async (payload, deliveryKey) => {
  const { recipient, type, title, message, data } = payload;
  if (!recipient || !type || !title || !message) {
    throw new Error("Invalid in-app notification payload.");
  }

  const key = String(deliveryKey || payload.deliveryKey || "").trim();
  if (!key) {
    throw new Error("Notification deliveryKey is required.");
  }

  try {
    await Notification.create({
      recipient,
      type,
      title,
      message,
      data: data || {},
      deliveryKey: key,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return;
    }
    throw error;
  }
};

const dispatchOutboxEvent = async (event) => {
  switch (event.topic) {
    case "PAYMENT_RECEIVED":
    case "PAYMENT_REVERSED":
    case "CORRECTION_APPROVED":
    case "CASH_SUBMITTED":
    case "SETTLEMENT_FINALIZED":
      await deliverInAppNotification(event.payload, event.dedupeKey);
      return;
    default:
      throw new Error(`Unsupported outbox topic: ${event.topic}`);
  }
};

const buildClaimableQuery = (now) => ({
  $or: [
    {
      status: OUTBOX_STATUS.PENDING,
      nextAttemptAt: { $lte: now },
      attempts: { $lt: MAX_ATTEMPTS },
    },
    {
      status: OUTBOX_STATUS.FAILED,
      nextAttemptAt: { $lte: now },
      attempts: { $lt: MAX_ATTEMPTS },
    },
    {
      status: OUTBOX_STATUS.PROCESSING,
      leaseExpiresAt: { $lte: now },
      attempts: { $lt: MAX_ATTEMPTS },
    },
  ],
});

const processOutboxBatch = async ({ limit = 20, owner = workerOwner() } = {}) => {
  const now = new Date();
  const candidates = await OutboxEvent.find(buildClaimableQuery(now))
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(limit);

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let deadLetter = 0;

  for (const event of candidates) {
    const leaseExpiresAt = new Date(Date.now() + OUTBOX_LEASE_MS);
    const claimed = await OutboxEvent.findOneAndUpdate(
      {
        _id: event._id,
        ...buildClaimableQuery(now),
      },
      {
        $set: {
          status: OUTBOX_STATUS.PROCESSING,
          processingOwner: owner,
          leaseExpiresAt,
        },
      },
      { new: true }
    );
    if (!claimed) continue;

    processed += 1;
    try {
      await dispatchOutboxEvent(claimed);
      await OutboxEvent.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: OUTBOX_STATUS.SENT,
            sentAt: new Date(),
            deliveredAt: new Date(),
            lastError: "",
            processingOwner: "",
            leaseExpiresAt: null,
          },
        }
      );
      sent += 1;
    } catch (error) {
      const attempts = claimed.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await OutboxEvent.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: terminal ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.PENDING,
            attempts,
            nextAttemptAt: terminal ? claimed.nextAttemptAt : computeNextAttempt(attempts),
            lastError: String(error.message || "Outbox delivery failed").slice(0, 500),
            processingOwner: "",
            leaseExpiresAt: null,
          },
        }
      );
      if (terminal) deadLetter += 1;
      else failed += 1;
    }
  }

  return { processed, sent, failed, deadLetter, owner };
};

const getOutboxHealthMetrics = async () => {
  const now = new Date();
  const [oldestPending, processingLease, deadLetterCount, retryCount] = await Promise.all([
    OutboxEvent.findOne({
      status: { $in: [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.FAILED] },
    })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .select("nextAttemptAt createdAt status")
      .lean(),
    OutboxEvent.findOne({ status: OUTBOX_STATUS.PROCESSING })
      .sort({ leaseExpiresAt: -1 })
      .select("leaseExpiresAt processingOwner")
      .lean(),
    OutboxEvent.countDocuments({ status: OUTBOX_STATUS.DEAD_LETTER }),
    OutboxEvent.countDocuments({
      status: { $in: [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.FAILED] },
      attempts: { $gt: 0 },
    }),
  ]);

  const queueAgeMs = oldestPending
    ? Math.max(now.getTime() - new Date(oldestPending.nextAttemptAt || oldestPending.createdAt).getTime(), 0)
    : 0;
  const processingLeaseAgeMs = processingLease?.leaseExpiresAt
    ? Math.max(new Date(processingLease.leaseExpiresAt).getTime() - now.getTime(), 0)
    : 0;

  return {
    queueAgeMs,
    processingLeaseAgeMs,
    deadLetterCount,
    retryCount,
    oldestPendingStatus: oldestPending?.status || null,
    processingOwner: processingLease?.processingOwner || null,
  };
};

module.exports = {
  enqueueOutboxEvent,
  processOutboxBatch,
  deliverInAppNotification,
  getOutboxHealthMetrics,
  MAX_ATTEMPTS,
  OUTBOX_LEASE_MS,
};
