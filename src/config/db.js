const mongoose = require("mongoose");
const { MONGO_URI, NODE_ENV } = require("./env");

const connectDb = async (uri = MONGO_URI) => {
  if (!uri) {
    throw new Error("MONGO_URI is not configured.");
  }

  mongoose.set("autoIndex", NODE_ENV !== "production");
  mongoose.set("autoCreate", NODE_ENV !== "production");

  await mongoose.connect(uri);
  console.log("MongoDB connected");
};

const connectDB = async () => connectDb(MONGO_URI);

module.exports = connectDB;
module.exports.connectDb = connectDb;
