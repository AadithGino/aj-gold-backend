const { DELETION_REQUEST_STATUS } = require("../../constants/enums");

const id = "003_account_lifecycle_indexes";

const up = async (db) => {
  const deletionRequests = db.collection("accountdeletionrequests");
  await deletionRequests.createIndex({ customer: 1, status: 1 });
  await deletionRequests.createIndex(
    { customer: 1 },
    {
      unique: true,
      name: "uniq_pending_deletion_per_customer",
      partialFilterExpression: { status: DELETION_REQUEST_STATUS.PENDING },
    }
  );
  await deletionRequests.createIndex({ idempotencyKey: 1 }, { sparse: true });

  const loginAttempts = db.collection("loginattempts");
  await loginAttempts.createIndex({ key: 1 }, { unique: true, name: "uniq_login_attempt_key" });
  await loginAttempts.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "login_attempt_ttl" }
  );
};

const down = async (db) => {
  const deletionRequests = db.collection("accountdeletionrequests");
  await deletionRequests.dropIndex("customer_1_status_1").catch(() => {});
  await deletionRequests.dropIndex("uniq_pending_deletion_per_customer").catch(() => {});
  await deletionRequests.dropIndex("idempotencyKey_1").catch(() => {});

  const loginAttempts = db.collection("loginattempts");
  await loginAttempts.dropIndex("uniq_login_attempt_key").catch(() => {});
  await loginAttempts.dropIndex("login_attempt_ttl").catch(() => {});
};

module.exports = { id, up, down };
