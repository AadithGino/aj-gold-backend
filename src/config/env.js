const dotenv = require("dotenv");
dotenv.config();

module.exports = {
  PORT:                  process.env.PORT || 8000,
  MONGO_URI:             process.env.MONGO_URI || "",
  mongoUri:              process.env.MONGO_URI || "",
  JWT_SECRET:            process.env.JWT_SECRET || "changeme",
  jwtSecret:             process.env.JWT_SECRET || "changeme",
  JWT_EXPIRES_IN:        process.env.JWT_EXPIRES_IN || "30d",
  NODE_ENV:              process.env.NODE_ENV || "development",
  DEFAULT_ADMIN_PHONE:   process.env.DEFAULT_ADMIN_PHONE || "9999999999",
  DEFAULT_ADMIN_PASSWORD:process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
};
