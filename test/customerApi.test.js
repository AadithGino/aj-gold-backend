const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const Customer = require("../src/models/customer.model");
const CustomerDeletionRequest = require("../src/models/customerDeletionRequest.model");
const { USER_ROLES, DELETION_REQUEST_STATUS } = require("../src/constants/enums");
const { register, login, logout } = require("../src/services/auth.service");
const {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
} = require("../src/services/customerDeletion.service");
const { assertPasswordStrength } = require("../src/utils/password");

let replSet;

const uniquePhone = () => `7${String(Date.now()).slice(-9)}`;

describe("customer auth and profile APIs", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_customer_api_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (replSet) {
      await replSet.stop();
    }
  });

  it("password util loads without circular dependency", () => {
    assert.equal(typeof assertPasswordStrength, "function");
    assert.throws(() => assertPasswordStrength("abc"), (err) => err.statusCode === 400);
    assertPasswordStrength("pass1");
  });

  it("register creates user, customer, and returns token", async () => {
    const phone = uniquePhone();
    const result = await register({
      name: "New Customer",
      phone,
      password: "password12",
      address: "Test address",
    });

    assert.ok(result.token);
    assert.equal(result.user.role, USER_ROLES.CUSTOMER);
    assert.equal(result.user.phone, phone);
    assert.ok(result.customer?.passbookNumber);

    const user = await User.findOne({ phone });
    const customer = await Customer.findOne({ user: user._id });
    assert.ok(user);
    assert.ok(customer);
    assert.equal(customer.name, "New Customer");
  });

  it("register rejects missing password", async () => {
    await assert.rejects(
      () => register({ name: "A", phone: uniquePhone() }),
      (err) => err.statusCode === 400
    );
  });

  it("register rejects short password", async () => {
    await assert.rejects(
      () => register({ name: "A", phone: uniquePhone(), password: "abc" }),
      (err) => err.statusCode === 400 && /4 characters/.test(err.message)
    );
  });

  it("register rejects duplicate phone", async () => {
    const phone = uniquePhone();
    await register({ name: "First", phone, password: "password12" });
    await assert.rejects(
      () => register({ name: "Second", phone, password: "password12" }),
      (err) => err.statusCode === 409
    );
  });

  it("login works for registered customer", async () => {
    const phone = uniquePhone();
    const password = "password12";
    await register({ name: "Login Test", phone, password });

    const session = await login({ phone, password });
    assert.ok(session.token);
    assert.equal(session.user.phone, phone);
  });

  it("logout invalidates token version", async () => {
    const phone = uniquePhone();
    const password = "password12";
    const { token, user } = await register({ name: "Logout Test", phone, password });

    const before = await User.findById(user._id);
    assert.equal(before.tokenVersion || 0, 0);

    await logout({ _id: user._id, role: user.role });

    const after = await User.findById(user._id);
    assert.equal(after.tokenVersion, 1);

    const jwt = require("jsonwebtoken");
    const { JWT_SECRET } = require("../src/config/env");
    const decoded = jwt.verify(token, JWT_SECRET);
    assert.equal(decoded.tokenVersion, 0);
    assert.notEqual(decoded.tokenVersion, after.tokenVersion);
  });

  it("deletion request lifecycle: create, read, cancel, re-request", async () => {
    const phone = uniquePhone();
    const { user } = await register({
      name: "Delete Flow",
      phone,
      password: "password12",
    });

    const empty = await getDeletionRequestForUser(user);
    assert.equal(empty.request, null);
    assert.equal(empty.canRequest, true);

    const created = await createDeletionRequest(user, { reason: "No longer needed" });
    assert.equal(created.status, DELETION_REQUEST_STATUS.PENDING);
    assert.equal(created.reason, "No longer needed");

    const pending = await getDeletionRequestForUser(user);
    assert.equal(pending.request.status, DELETION_REQUEST_STATUS.PENDING);
    assert.equal(pending.canRequest, false);

    const cancelled = await cancelDeletionRequest(user);
    assert.equal(cancelled.status, DELETION_REQUEST_STATUS.CANCELLED);

    const afterCancel = await getDeletionRequestForUser(user);
    assert.equal(afterCancel.canRequest, true);

    const second = await createDeletionRequest(user, { reason: "Try again" });
    assert.equal(second.status, DELETION_REQUEST_STATUS.PENDING);

    const count = await CustomerDeletionRequest.countDocuments({ user: user._id });
    assert.equal(count, 2);
  });

  it("deletion request rejects duplicate pending request", async () => {
    const phone = uniquePhone();
    const { user } = await register({
      name: "Dup Delete",
      phone,
      password: "password12",
    });

    await createDeletionRequest(user, { reason: "First" });
    await assert.rejects(
      () => createDeletionRequest(user, { reason: "Second" }),
      (err) => err.statusCode === 409
    );
  });

  it("cancel deletion fails when no pending request", async () => {
    const phone = uniquePhone();
    const { user } = await register({
      name: "No Pending",
      phone,
      password: "password12",
    });

    await assert.rejects(
      () => cancelDeletionRequest(user),
      (err) => err.statusCode === 404
    );
  });
});
