const mongoose = require("mongoose");
const { MONGO_URI } = require("./env");

const connectDb = async (uri = MONGO_URI) => {
  if (!uri) {
    throw new Error("MONGO_URI is not configured.");
  }
  try {
    await mongoose.connect(uri);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
};

const connectDB = async () => connectDb(MONGO_URI);

module.exports = connectDB;
module.exports.connectDb = connectDb;
