const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const Customer = require("../src/models/customer.model");
const Scheme = require("../src/models/scheme.model");
const CustomerDeletionRequest = require("../src/models/customerDeletionRequest.model");
require("../src/models/auditLog.model");
const { USER_ROLES, DELETION_REQUEST_STATUS, SCHEME_STATUS } = require("../src/constants/enums");
const { register, login } = require("../src/services/auth.service");
const {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
} = require("../src/services/customerDeletion.service");
const { deleteCustomer, getCustomerDetail, searchCustomers } = require("../src/services/customer.service");
const { runMigrations } = require("../src/migrations/runMigrations");

let replSet;

const createStaff = async () =>
  User.create({
    name: "Reg Staff",
    phone: `8${String(Date.now()).slice(-9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });

const createAdmin = async () =>
  User.create({
    name: "Reg Admin",
    phone: `9${String(Date.now()).slice(-9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
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

  it("duplicate phone registration does not consume a passbook number", async () => {
    const ReceiptCounter = require("../src/models/receiptCounter.model");
    const { PASSBOOK_COUNTER_KEY } = require("../src/services/receipt.service");
    const phone = `7${String(Date.now()).slice(-9)}`;
    const first = await register({ name: "One", phone, password: "custpass1" });

    const before = await ReceiptCounter.findOne({ key: PASSBOOK_COUNTER_KEY });
    await assert.rejects(
      () => register({ name: "Two", phone, password: "custpass1" }),
      (error) => error.statusCode === 409
    );
    const after = await ReceiptCounter.findOne({ key: PASSBOOK_COUNTER_KEY });
    assert.equal(after.seq, before.seq);

    const next = await register({
      name: "Three",
      phone: `7${String(Date.now() + 1).slice(-9)}`,
      password: "custpass1",
    });
    assert.equal(
      Number(next.customer.passbookNumber),
      Number(first.customer.passbookNumber) + 1
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

  it("lets admin delete a customer with no scheme and frees the phone", async () => {
    const phone = `7${String(Date.now()).slice(-9)}`;
    const admin = await createAdmin();
    const registered = await register({
      name: "No Scheme Customer",
      phone,
      password: "custpass1",
    });
    const passbookNumber = registered.customer.passbookNumber;

    const detail = await getCustomerDetail(registered.customer._id, admin);
    assert.equal(detail.canDelete, true);

    await createDeletionRequest(registered.user, { reason: "Never started" });
    const result = await deleteCustomer(registered.customer._id, admin);
    assert.equal(result.deleted, true);

    const keptCustomer = await Customer.findById(registered.customer._id);
    const keptUser = await User.findById(registered.user._id);
    assert.ok(keptCustomer);
    assert.ok(keptUser);
    assert.equal(keptCustomer.status, "INACTIVE");
    assert.ok(keptCustomer.deletedAt);
    assert.equal(keptCustomer.originalPhone, phone);
    assert.notEqual(keptCustomer.phone, phone);
    assert.equal(keptUser.status, "INACTIVE");
    assert.notEqual(keptUser.phone, phone);
    assert.equal(
      await CustomerDeletionRequest.countDocuments({ customer: registered.customer._id }),
      1
    );

    await assert.rejects(
      () => getCustomerDetail(registered.customer._id, admin),
      (error) => error.statusCode === 404
    );

    const listed = await searchCustomers(phone, admin, { paginated: true });
    assert.equal(
      listed.items.some((row) => String(row._id) === String(registered.customer._id)),
      false
    );

    await assert.rejects(
      () => login({ phone, password: "custpass1" }),
      (error) => error.statusCode === 401
    );

    const reused = await register({
      name: "Same Phone Again",
      phone,
      password: "custpass1",
    });
    assert.ok(reused.customer._id);
    assert.notEqual(reused.customer.passbookNumber, passbookNumber);
    assert.equal(
      Number(reused.customer.passbookNumber),
      Number(passbookNumber) + 1
    );
  });

  it("blocks staff from deleting a scheme-less customer", async () => {
    const staff = await createStaff();
    const registered = await register({
      name: "Staff Block",
      phone: `7${String(Date.now()).slice(-9)}`,
      password: "custpass1",
    });

    await assert.rejects(
      () => deleteCustomer(registered.customer._id, staff),
      (error) => error.statusCode === 403
    );
    assert.ok(await Customer.findById(registered.customer._id));
  });

  it("rejects delete when the customer has a scheme or legal hold", async () => {
    const admin = await createAdmin();
    const withScheme = await register({
      name: "Has Scheme",
      phone: `7${String(Date.now()).slice(-9)}`,
      password: "custpass1",
    });
    await Scheme.create({
      customer: withScheme.customer._id,
      enrollmentNumber: `ENR-DEL-${Date.now()}`,
      schemeName: "AJ Gold Scheme",
      startDate: new Date("2026-01-01"),
      sixMonthDate: new Date("2026-07-01"),
      maturityDate: new Date("2026-12-01"),
      status: SCHEME_STATUS.ACTIVE,
      createdBy: admin._id,
    });

    const held = await register({
      name: "Legal Hold",
      phone: `7${String(Date.now() + 2).slice(-9)}`,
      password: "custpass1",
    });
    await Customer.updateOne({ _id: held.customer._id }, { legalHold: true });

    const schemeDetail = await getCustomerDetail(withScheme.customer._id, admin);
    assert.equal(schemeDetail.canDelete, false);
    const heldDetail = await getCustomerDetail(held.customer._id, admin);
    assert.equal(heldDetail.canDelete, false);

    await assert.rejects(
      () => deleteCustomer(withScheme.customer._id, admin),
      (error) => error.statusCode === 409 && /scheme/i.test(error.message)
    );
    await assert.rejects(
      () => deleteCustomer(held.customer._id, admin),
      (error) => error.statusCode === 409 && /legal hold/i.test(error.message)
    );
  });
});
