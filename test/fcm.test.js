const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

require("../src/models/scheme.model");
require("../src/models/payment.model");
require("../src/models/customer.model");
require("../src/models/financialJournal.model");
require("../src/models/idempotencyRecord.model");
require("../src/models/loginAttempt.model");
require("../src/models/cashSubmission.model");
require("../src/models/paymentCorrection.model");
const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Notification = require("../src/models/notification.model");
const DeviceToken = require("../src/models/deviceToken.model");
const OutboxEvent = require("../src/models/outboxEvent.model");
const { USER_ROLES } = require("../src/constants/enums");
const { NOTIFICATION_TYPES } = require("../src/models/notification.model");
const { OUTBOX_STATUS } = require("../src/models/outboxEvent.model");
const { createCustomer } = require("../src/services/customer.service");
const { signAccessToken } = require("../src/services/auth.service");
const {
  registerDeviceToken,
  unregisterDeviceToken,
  listTokensForUser,
} = require("../src/services/device.service");
const {
  processOutboxBatch,
} = require("../src/services/outbox.service");
const { runMigrations, verifyMigrationsApplied } = require("../src/migrations/runMigrations");
const migration014 = require("../src/migrations/versions/014_device_token_indexes");

const loadPushService = () => {
  delete require.cache[require.resolve("../src/services/push.service")];
  return require("../src/services/push.service");
};

const reqId = () => crypto.randomUUID();

let replSet;
let server;
let baseUrl;
let app;

const httpRequest = ({ method, path, token, body, headers = {} }) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const createAdmin = async () =>
  User.create({
    name: "FCM Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createCustomerUser = async (admin, suffix = "0") => {
  const customer = await createCustomer(
    {
      name: "FCM Customer",
      phone: `7${String(Date.now()).slice(-8)}${suffix}`,
      password: "1234",
    },
    admin
  );
  const user = await User.findById(customer.user);
  return { customer, user };
};

describe("FCM push notifications", () => {
  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.FCM_ENABLED = "false";
    process.env.FCM_TEST_PUSH_ENABLED = "true";
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete require.cache[require.resolve("../src/config/env")];
    delete require.cache[require.resolve("../src/services/push.service")];
    delete require.cache[require.resolve("../src/app")];

    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_fcm_${process.pid}` });

    app = require("../src/app");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await Promise.all(
      mongoose.modelNames().map((name) => mongoose.model(name).createCollection().catch(() => {}))
    );
    await runMigrations(mongoose.connection.db);
    await Promise.all([Notification, StaffProfile, DeviceToken].map((model) => model.syncIndexes()));
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
  });

  after(async () => {
    if (server?.closeAllConnections) {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
    delete require.cache[require.resolve("../src/app")];
    delete require.cache[require.resolve("../src/services/push.service")];
    delete require.cache[require.resolve("../src/config/env")];
  });

  it("migration 014 creates devicetokens indexes", async () => {
    const db = mongoose.connection.db;
    await migration014.up(db);
    const indexes = await db.collection("devicetokens").indexes();
    const names = indexes.map((index) => index.name);
    assert.ok(names.includes("user_1"));
    assert.ok(names.includes("token_1"));
  });

  it("verifyMigrationsApplied includes device token migration", async () => {
    await assert.doesNotReject(() => verifyMigrationsApplied(mongoose.connection.db));
  });

  it("registers, upserts, lists, and unregisters device tokens", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin);
    const token = `fcm-token-${reqId()}`;

    const created = await registerDeviceToken(user._id, { token, platform: "ios" });
    assert.equal(created.token, token);
    assert.equal(created.platform, "ios");

    const listed = await listTokensForUser(user._id);
    assert.equal(listed.length, 1);

    const upserted = await registerDeviceToken(user._id, { token, platform: "android" });
    assert.equal(upserted.platform, "android");
    assert.equal(await DeviceToken.countDocuments({ user: user._id }), 1);

    await unregisterDeviceToken(user._id, token);
    assert.equal(await DeviceToken.countDocuments({ user: user._id }), 0);
  });

  it("customer can register and remove FCM token via API", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "1");
    const token = signAccessToken(user);
    const fcmToken = `device-${reqId()}`;

    const registerRes = await httpRequest({
      method: "PUT",
      path: "/api/devices/fcm-token",
      token,
      body: { token: fcmToken, platform: "ios" },
    });
    assert.equal(registerRes.status, 200);
    assert.equal(registerRes.body.success, true);

    const stored = await DeviceToken.findOne({ token: fcmToken }).lean();
    assert.ok(stored);
    assert.equal(String(stored.user), String(user._id));

    const unregisterRes = await httpRequest({
      method: "DELETE",
      path: "/api/devices/fcm-token",
      token,
      body: { token: fcmToken, platform: "ios" },
    });
    assert.equal(unregisterRes.status, 200);
    assert.equal(await DeviceToken.countDocuments({ token: fcmToken }), 0);
  });

  it("staff cannot register device tokens", async () => {
    const staff = await User.create({
      name: "FCM Staff",
      phone: `8${String(Date.now()).slice(-8)}1`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: USER_ROLES.STAFF,
    });
    await StaffProfile.create({ user: staff._id, permissions: {} });

    const res = await httpRequest({
      method: "PUT",
      path: "/api/devices/fcm-token",
      token: signAccessToken(staff),
      body: { token: "staff-token", platform: "android" },
    });
    assert.equal(res.status, 403);
  });

  it("customer test-push skips send when FCM is disabled but token exists", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "2");
    const token = signAccessToken(user);
    const fcmToken = `device-${reqId()}`;

    await registerDeviceToken(user._id, { token: fcmToken, platform: "ios" });

    const res = await httpRequest({
      method: "POST",
      path: "/api/devices/test-push",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.result.skipped, true);
  });

  it("admin test-push by phone resolves customer user and skips when FCM disabled", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "3");
    await registerDeviceToken(user._id, { token: `device-${reqId()}`, platform: "android" });

    const res = await httpRequest({
      method: "POST",
      path: "/api/admin/test-push",
      token: signAccessToken(admin),
      body: { phone: user.phone },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.phone, user.phone);
    assert.equal(res.body.result.skipped, true);
    assert.equal(res.body.deviceCount, 1);
  });

  it("admin test-push returns 409 when customer has no registered device token", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "4");

    const res = await httpRequest({
      method: "POST",
      path: "/api/admin/test-push",
      token: signAccessToken(admin),
      body: { phone: user.phone },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /no registered device token/i);
  });

  it("deliverPushNotification only sends for PAYMENT_RECEIVED topic", async () => {
    const { deliverPushNotification, PUSH_TOPICS } = loadPushService();
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "5");
    await registerDeviceToken(user._id, { token: `device-${reqId()}`, platform: "ios" });

    const payload = {
      recipient: user._id,
      type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
      title: "Payment Received",
      message: "Test payment push",
      data: { paymentId: new mongoose.Types.ObjectId() },
    };

    const allowed = await deliverPushNotification(payload, "PAYMENT_RECEIVED");
    assert.equal(allowed.skipped, true);

    const blocked = await deliverPushNotification(payload, "PAYMENT_REVERSED");
    assert.equal(blocked.skipped, true);
    assert.ok(PUSH_TOPICS.has("PAYMENT_RECEIVED"));
    assert.ok(!PUSH_TOPICS.has("PAYMENT_REVERSED"));
  });

  it("outbox worker delivers in-app notification and attempts push without failing event", async () => {
    const admin = await createAdmin();
    const { user } = await createCustomerUser(admin, "6");
    await registerDeviceToken(user._id, { token: `device-${reqId()}`, platform: "ios" });

    const dedupeKey = `payment-received:${reqId()}`;
    await OutboxEvent.create({
      topic: "PAYMENT_RECEIVED",
      dedupeKey,
      payload: {
        recipient: user._id,
        type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
        title: "Payment Received",
        message: "Staff collected payment.",
        data: { paymentId: new mongoose.Types.ObjectId() },
      },
      status: OUTBOX_STATUS.PENDING,
      nextAttemptAt: new Date(),
    });

    const result = await processOutboxBatch({ limit: 5 });
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);

    const notification = await Notification.findOne({ deliveryKey: dedupeKey }).lean();
    assert.ok(notification);
    assert.equal(notification.type, NOTIFICATION_TYPES.PAYMENT_RECEIVED);

    const event = await OutboxEvent.findOne({ dedupeKey }).lean();
    assert.equal(event.status, OUTBOX_STATUS.SENT);
  });
});
