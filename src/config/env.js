const dotenv = require("dotenv");
dotenv.config();

const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET || "changeme";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const JWT_ISSUER = process.env.JWT_ISSUER || "aj-gold-api";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "aj-gold-clients";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, "");

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const parseTrustProxy = () => {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") {
    return NODE_ENV === "production" ? 1 : false;
  }
  if (raw === "false") return false;
  if (raw === "true") return true;
  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber)) return asNumber;
  return raw;
};

const extractDbName = (uri) => {
  if (!uri) return "";
  const withoutQuery = uri.split("?")[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return last.includes(":") || last.includes("@") ? "" : last;
};

const validateProductionEnv = () => {
  if (process.env.AJ_MIGRATION_CLI === "1") return;
  if (NODE_ENV !== "production") return;

  if (!process.env.JWT_SECRET || JWT_SECRET === "changeme" || JWT_SECRET.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to a strong value (minimum 32 characters) in production."
    );
  }

  if (CORS_ORIGINS.length === 0) {
    throw new Error("CORS_ORIGINS must be a non-empty allowlist in production.");
  }

  if (CORS_ORIGINS.some((origin) => origin === "*" || origin.includes("*"))) {
    throw new Error("Wildcard CORS origins are not allowed in production with credentials.");
  }

  if (!process.env.MONGO_URI?.trim()) {
    throw new Error("MONGO_URI is required in production.");
  }

  const dbName = extractDbName(process.env.MONGO_URI);
  if (!dbName) {
    throw new Error("MONGO_URI must include an explicit database name in production.");
  }

  if (/(dev|demo|test)/i.test(dbName)) {
    throw new Error(`Production MONGO_URI must not target demo/test database "${dbName}".`);
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
  JWT_ISSUER,
  JWT_AUDIENCE,
  LOG_LEVEL,
  NODE_ENV,
  CORS_ORIGINS,
  normalizeOrigin,
  TRUST_PROXY: parseTrustProxy(),
  BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || "100kb",
  LOGIN_RATE_LIMIT_WINDOW_MS: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  LOGIN_RATE_LIMIT_MAX: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  LOGIN_LOCKOUT_MS: Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000),
  SEED_ALLOW_PRODUCTION: process.env.SEED_ALLOW_PRODUCTION === "true",
  SHUTDOWN_TIMEOUT_MS: Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000),
  SETTLEMENT_FORMULA_VERSION: process.env.SETTLEMENT_FORMULA_VERSION || "principal-v1",
};
