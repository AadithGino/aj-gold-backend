const mongoose = require("mongoose");
const { MONGO_URI, NODE_ENV } = require("./env");

const isNamespaceExistsError = (error) =>
  error?.codeName === "NamespaceExists" ||
  error?.code === 48 ||
  error?.message?.includes("already exists");

const awaitSchemaReadiness = async () => {
  const modelNames = mongoose.modelNames();
  for (const name of modelNames) {
    const model = mongoose.model(name);
    await model.createCollection().catch((error) => {
      if (!isNamespaceExistsError(error)) {
        throw error;
      }
    });
    await model.init();
  }
};

const connectDb = async (uri = MONGO_URI) => {
  if (!uri) {
    throw new Error("MONGO_URI is not configured.");
  }

  mongoose.set("autoIndex", NODE_ENV !== "production");
  mongoose.set("autoCreate", NODE_ENV !== "production");

  await mongoose.connect(uri);
  await awaitSchemaReadiness();
  console.log("MongoDB connected");
};

const connectDB = async () => connectDb(MONGO_URI);

module.exports = connectDB;
module.exports.connectDb = connectDb;
module.exports.awaitSchemaReadiness = awaitSchemaReadiness;
