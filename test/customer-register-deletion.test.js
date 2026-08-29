const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const { USER_ROLES, DELETION_REQUEST_STATUS } = require("../src/constants/enums");
const { register, login } = require("../src/services/auth.service");
const {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
} = require("../src/services/customerDeletion.service");
const { runMigrations } = require("../src/migrations/runMigrations");

let replSet;

const createStaff = async () =>
  User.create({
    name: "Reg Staff",
    phone: `8${String(Date.now()).slice(-9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });

describe("Customer self-register and deletion request", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_register_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  it("registers a customer without a scheme and signs them in", async () => {
    const phone = `7${String(Date.now()).slice(-9)}`;
    const result = await register({
      name: "Self Customer",
      phone,
      password: "custpass1",
      address: "Kambil",
    });

    assert.ok(result.token);
    assert.equal(result.user.role, USER_ROLES.CUSTOMER);
    assert.equal(result.user.phone, phone);
    assert.ok(result.customer.passbookNumber);
    assert.equal(result.customer.address, "Kambil");

    const loggedIn = await login({ phone, password: "custpass1" });
    assert.equal(loggedIn.user._id.toString(), result.user._id.toString());
  });

  it("rejects duplicate phone registration", async () => {
    const phone = `7${String(Date.now()).slice(-9)}`;
    await register({ name: "One", phone, password: "custpass1" });
    await assert.rejects(
      () => register({ name: "Two", phone, password: "custpass1" }),
      (error) => error.statusCode === 409
    );
  });

  it("lets a customer create and cancel a deletion request", async () => {
    const phone = `7${String(Date.now()).slice(-9)}`;
    const { user } = await register({ name: "Delete Me", phone, password: "custpass1" });

    const empty = await getDeletionRequestForUser(user);
    assert.equal(empty.request, null);
    assert.equal(empty.canRequest, true);

    const created = await createDeletionRequest(user, { reason: "Leaving the scheme" });
    assert.equal(created.status, DELETION_REQUEST_STATUS.PENDING);
    assert.equal(created.reason, "Leaving the scheme");

    const pending = await getDeletionRequestForUser(user);
    assert.equal(pending.canRequest, false);
    assert.equal(pending.request.status, DELETION_REQUEST_STATUS.PENDING);

    await assert.rejects(
      () => createDeletionRequest(user, { reason: "again" }),
      (error) => error.statusCode === 409
    );

    const cancelled = await cancelDeletionRequest(user);
    assert.equal(cancelled.status, DELETION_REQUEST_STATUS.CANCELLED);

    const afterCancel = await getDeletionRequestForUser(user);
    assert.equal(afterCancel.canRequest, true);
  });

  it("blocks staff from deletion requests", async () => {
    const staff = await createStaff();
    await assert.rejects(
      () => getDeletionRequestForUser(staff),
      (error) => error.statusCode === 403
    );
  });
});
