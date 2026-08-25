const mongoose = require("mongoose");
const { MONGO_URI, NODE_ENV } = require("./env");
const { assertDestructiveOperationAllowed } = require("../ops/destructiveGuard");

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

const CONNECTION_SCHEMA_MODE = Object.freeze({
  RUNTIME: "runtime",
  DISPOSABLE_BOOTSTRAP: "disposable-bootstrap",
});

const assertDisposableBootstrapAllowed = (uri) => {
  if ((process.env.NODE_ENV || "").toLowerCase() !== "test") {
    throw new Error("Disposable schema bootstrap is allowed only when NODE_ENV=test.");
  }
  const dbName = assertDestructiveOperationAllowed({
    mongoUri: uri,
    operationLabel: "disposable schema bootstrap",
    requireResetFlag: false,
    requireConfirmationToken: false,
  });
  if (!dbName.toLowerCase().endsWith("_test") && !/(dev|demo|test)/i.test(dbName)) {
    throw new Error(
      `Refusing disposable schema bootstrap for "${dbName}". Database name must end with _test or match disposable naming.`
    );
  }
};

const resolveConnectArgs = (uriOrOptions, options = {}) => {
  if (typeof uriOrOptions === "string" || uriOrOptions == null) {
    return {
      uri: uriOrOptions || MONGO_URI,
      schemaMode: options.schemaMode || CONNECTION_SCHEMA_MODE.RUNTIME,
    };
  }
  return {
    uri: uriOrOptions.uri || MONGO_URI,
    schemaMode: uriOrOptions.schemaMode || CONNECTION_SCHEMA_MODE.RUNTIME,
  };
};

const connectDb = async (uriOrOptions = MONGO_URI, options = {}) => {
  const { uri, schemaMode } = resolveConnectArgs(uriOrOptions, options);
  if (!uri) {
    throw new Error("MONGO_URI is not configured.");
  }

  if (!Object.values(CONNECTION_SCHEMA_MODE).includes(schemaMode)) {
    throw new Error(`Unsupported schema mode: ${schemaMode}`);
  }

  const enableSchemaDDL = schemaMode === CONNECTION_SCHEMA_MODE.DISPOSABLE_BOOTSTRAP;
  if (enableSchemaDDL) {
    assertDisposableBootstrapAllowed(uri);
  }

  mongoose.set("autoIndex", enableSchemaDDL && NODE_ENV !== "production");
  mongoose.set("autoCreate", enableSchemaDDL && NODE_ENV !== "production");

  await mongoose.connect(uri);
  if (enableSchemaDDL) {
    await awaitSchemaReadiness();
  }
  console.log("MongoDB connected");
};

const connectDB = async () =>
  connectDb({ uri: MONGO_URI, schemaMode: CONNECTION_SCHEMA_MODE.RUNTIME });

module.exports = connectDB;
module.exports.connectDb = connectDb;
module.exports.awaitSchemaReadiness = awaitSchemaReadiness;
module.exports.CONNECTION_SCHEMA_MODE = CONNECTION_SCHEMA_MODE;
