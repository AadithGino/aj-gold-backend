const id = "013_customer_deletion_request_indexes";

const COLLECTION = "customerdeletionrequests";

const up = async (db) => {
  const deletionRequests = db.collection(COLLECTION);
  await db.createCollection(COLLECTION).catch(() => {});
  await deletionRequests.createIndex({ customer: 1, status: 1 });
  await deletionRequests.createIndex({ user: 1, createdAt: -1 });
};

const down = async (db) => {
  const deletionRequests = db.collection(COLLECTION);
  await deletionRequests.dropIndex("customer_1_status_1").catch(() => {});
  await deletionRequests.dropIndex("user_1_createdAt_-1").catch(() => {});
};

module.exports = { id, up, down };
