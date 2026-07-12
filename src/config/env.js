const dotenv = require("dotenv");
dotenv.config();

const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET || "changeme";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const validateProductionEnv = () => {
  if (NODE_ENV !== "production") return;

  if (!process.env.JWT_SECRET || JWT_SECRET === "changeme" || JWT_SECRET.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to a strong value (minimum 32 characters) in production."
    );
  }
};

validateProductionEnv();

module.exports = {
  PORT: process.env.PORT || 8000,
  MONGO_URI: process.env.MONGO_URI || "",
  mongoUri: process.env.MONGO_URI || "",
  JWT_SECRET,
  jwtSecret: JWT_SECRET,
  JWT_EXPIRES_IN,
  NODE_ENV,
  CORS_ORIGINS,
  BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || "100kb",
  LOGIN_RATE_LIMIT_WINDOW_MS: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  LOGIN_RATE_LIMIT_MAX: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  SEED_ALLOW_PRODUCTION: process.env.SEED_ALLOW_PRODUCTION === "true",
};
