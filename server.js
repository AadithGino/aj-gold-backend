const { PORT } = require("./src/config/env");
const connectDB = require("./src/config/db");
const app = require("./src/app");
const mongoose = require("mongoose");

let server;

const shutdown = async (signal) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.connection.close(false);
  process.exit(0);
};

const start = async () => {
  await connectDB();
  server = app.listen(PORT, () => {
    console.log(`AJ Gold Kambil API running on port ${PORT}`);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});
