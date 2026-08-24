const id = "007_remove_account_deletion_indexes";

const dropIndexIfExists = async (collection, indexName) => {
  try {
    await collection.dropIndex(indexName);
  } catch (error) {
    if (error?.codeName !== "IndexNotFound" && error?.code !== 27) {
      throw error;
    }
  }
};

const up = async (db) => {
  const deletionRequests = db.collection("accountdeletionrequests");
  await dropIndexIfExists(deletionRequests, "customer_1_status_1");
  await dropIndexIfExists(deletionRequests, "uniq_pending_deletion_per_customer");
  await dropIndexIfExists(deletionRequests, "idempotencyKey_1");
};

const down = async () => {
  // Intentionally left empty. Account deletion workflow is out of approved scope.
};

module.exports = { id, up, down };
