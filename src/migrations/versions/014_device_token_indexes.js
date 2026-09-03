const id = "014_device_token_indexes";

const COLLECTION = "devicetokens";

const up = async (db) => {
  const deviceTokens = db.collection(COLLECTION);
  await db.createCollection(COLLECTION).catch(() => {});
  await deviceTokens.createIndex({ user: 1 });
  await deviceTokens.createIndex({ token: 1 }, { unique: true });
};

const down = async (db) => {
  const deviceTokens = db.collection(COLLECTION);
  await deviceTokens.dropIndex("user_1").catch(() => {});
  await deviceTokens.dropIndex("token_1").catch(() => {});
};

module.exports = { id, up, down };
