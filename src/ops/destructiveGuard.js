const extractDbName = (uri) => {
  if (!uri || typeof uri !== "string") return "";
  const withoutQuery = uri.split("?")[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  if (!last || last.includes(":") || last.includes("@")) return "";
  return last;
};

const assertDestructiveOperationAllowed = ({
  mongoUri,
  operationLabel = "destructive operation",
  requireResetFlag = true,
  requireConfirmationToken = true,
}) => {
  const nodeEnv = process.env.NODE_ENV || "development";
  if (nodeEnv === "production") {
    throw new Error(`Refusing ${operationLabel} when NODE_ENV=production.`);
  }

  if (!mongoUri?.trim()) {
    throw new Error("MONGO_URI is required.");
  }

  if (requireResetFlag && process.env.ALLOW_DATABASE_RESET !== "true") {
    throw new Error(`Set ALLOW_DATABASE_RESET=true to allow ${operationLabel}.`);
  }

  const dbName = extractDbName(mongoUri);
  if (!dbName) {
    throw new Error("Could not determine an unambiguous database name from MONGO_URI.");
  }

  const normalized = dbName.toLowerCase();
  if (!/(dev|demo|test)/.test(normalized)) {
    throw new Error(
      `Refusing ${operationLabel} on database "${dbName}". Name must contain dev, demo, or test.`
    );
  }

  if (requireConfirmationToken) {
    const expected = process.env.CONFIRM_DATABASE_RESET?.trim();
    if (!expected || expected !== dbName) {
      throw new Error(
        `Set CONFIRM_DATABASE_RESET=${dbName} to confirm ${operationLabel} on this database.`
      );
    }
  }

  return dbName;
};

const assertBackupAllowed = ({ mongoUri }) => {
  if (!mongoUri?.trim()) {
    throw new Error("MONGO_URI is required.");
  }

  const dbName = extractDbName(mongoUri);
  if (!dbName) {
    throw new Error("Could not determine an unambiguous database name from MONGO_URI.");
  }

  return dbName;
};

module.exports = {
  extractDbName,
  assertDestructiveOperationAllowed,
  assertBackupAllowed,
};
