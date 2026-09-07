const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { sanitizeWritableStaffPermissions, resolveStaffPermissions } = require("../constants/staffPermissions");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Customer = require("../models/customer.model");
const {
  USER_ROLES,
  USER_STATUS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { getNextSequence } = require("./receipt.service");
const {
  getPaymentMethodBreakdown,
  getStaffCollectionTotal,
  getStaffPaymentHistory,
  getStaffCashSubmissionHistory,
} = require("./cash.service");
const { getStaffCashInHand } = require("./staffCash.service");
const { logAudit } = require("./audit.service");
const { assertPrivilegedPassword } = require("../constants/credentialPolicies");
const { generateTemporaryPassword } = require("./auth.service");
const {
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  startOfYear,
  parseDateRange,
} = require("../utils/date");
const { parseSafeSearchTerm } = require("../utils/safeSearch");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");
const { listSettlementHistory } = require("./settlementHistory.service");

const sanitizeStaffUser = (user) => ({
  _id: user._id,
  name: user.name,
  phone: user.phone,
  email: user.email || "",
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});

const generateEmployeeCode = async (date = new Date(), session = null) => {
  const year = date.getFullYear();
  const seq = await getNextSequence(`employee-${year}`, session);
  return `AJGK-STF-${year}-${String(seq).padStart(4, "0")}`;
};

const getStaffContextOrThrow = async (staffUserId) => {
  const user = await User.findById(staffUserId);

  if (!user || user.role !== USER_ROLES.STAFF) {
    throw new ApiError(404, "Staff member not found.");
  }

  const profile = await StaffProfile.findOne({ user: staffUserId });

  if (!profile) {
    throw new ApiError(404, "Staff profile not found.");
  }

  return { user, profile };
};

const createStaff = async (
  { name, phone, email, password, employeeCode, permissions, notes },
  actor
) => {
  const trimmedPhone = phone.trim();
  const existingUser = await User.findOne({ phone: trimmedPhone });
  if (existingUser) {
    throw new ApiError(409, "Phone number is already registered.");
  }

  const customEmployeeCode = employeeCode?.trim() || "";
  if (customEmployeeCode) {
    const existingCode = await StaffProfile.findOne({ employeeCode: customEmployeeCode });
    if (existingCode) {
      throw new ApiError(409, "Employee code already exists.");
    }
  }

  const resolvedPassword = password?.trim() || generateTemporaryPassword();
  assertPrivilegedPassword(resolvedPassword);
  const passwordHash = await bcrypt.hash(resolvedPassword, 10);
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const phoneTaken = await User.findOne({ phone: trimmedPhone }).session(session);
    if (phoneTaken) {
      throw new ApiError(409, "Phone number is already registered.");
    }

    const resolvedEmployeeCode =
      customEmployeeCode || (await generateEmployeeCode(new Date(), session));
    const existingCode = await StaffProfile.findOne({
      employeeCode: resolvedEmployeeCode,
    }).session(session);
    if (existingCode) {
      throw new ApiError(409, "Employee code already exists.");
    }

    const [user] = await User.create(
      [
        {
          name: name.trim(),
          phone: trimmedPhone,
          email: email?.trim() || undefined,
          passwordHash,
          role: USER_ROLES.STAFF,
          status: USER_STATUS.ACTIVE,
          createdBy: actor._id,
          updatedBy: actor._id,
        },
      ],
      { session }
    );

    const [profile] = await StaffProfile.create(
      [
        {
          user: user._id,
          employeeCode: resolvedEmployeeCode,
          permissions: sanitizeWritableStaffPermissions(permissions),
          joinedAt: new Date(),
          notes: notes?.trim() || "",
        },
      ],
      { session }
    );

    await session.commitTransaction();

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.STAFF_CREATED,
      targetType: "User",
      targetId: user._id,
      newValue: {
        name: user.name,
        phone: user.phone,
        employeeCode: profile.employeeCode,
      },
      notes: "Staff member created",
    });

    return { user, profile };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const updateStaff = async (staffUserId, updates, actor) => {
  const { user, profile } = await getStaffContextOrThrow(staffUserId);
  const previousValue = {
    name: user.name,
    phone: user.phone,
    email: user.email,
    status: user.status,
    permissions: profile.permissions,
    notes: profile.notes,
  };

  if (updates.phone && updates.phone !== user.phone) {
    const phoneTaken = await User.findOne({ phone: updates.phone, _id: { $ne: user._id } });
    if (phoneTaken) {
      throw new ApiError(409, "Phone number is already registered.");
    }
    user.phone = updates.phone.trim();
  }

  if (updates.name) {
    user.name = updates.name.trim();
  }

  if (updates.email !== undefined) {
    user.email = updates.email?.trim() || undefined;
  }

  if (updates.status) {
    user.status = updates.status;
  }

  if (updates.permissions) {
    profile.permissions = sanitizeWritableStaffPermissions({
      ...(profile.permissions?.toObject ? profile.permissions.toObject() : profile.permissions),
      ...updates.permissions,
    });
  }

  if (updates.permissions) {
    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.STAFF_PERMISSIONS_UPDATED,
      targetType: "User",
      targetId: user._id,
      previousValue: { permissions: previousValue.permissions },
      newValue: { permissions: profile.permissions },
      notes: "Staff permissions updated",
    });
  }

  if (updates.notes !== undefined) {
    profile.notes = updates.notes?.trim() || "";
  }

  if (updates.password?.trim()) {
    assertPrivilegedPassword(updates.password);
    user.passwordHash = await bcrypt.hash(String(updates.password).trim(), 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PASSWORD_RESET,
      targetType: "User",
      targetId: user._id,
      notes: "Staff password set by admin",
    });
  }

  user.updatedBy = actor._id;
  await user.save();
  await profile.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STAFF_UPDATED,
    targetType: "User",
    targetId: user._id,
    previousValue,
    newValue: {
      name: user.name,
      phone: user.phone,
      email: user.email,
      status: user.status,
      permissions: profile.permissions,
      notes: profile.notes,
    },
    notes: "Staff member updated",
  });

  return { user, profile };
};

const updateStaffStatus = async (staffUserId, status, actor) => {
  const { user, profile } = await getStaffContextOrThrow(staffUserId);
  const previousStatus = user.status;
  user.status = status;
  user.updatedBy = actor._id;
  await user.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STAFF_UPDATED,
    targetType: "User",
    targetId: user._id,
    previousValue: { status: previousStatus },
    newValue: { status },
    notes: "Staff status updated",
  });

  return { user, profile };
};

const countCustomersCreatedByStaffIds = async (staffIds = []) => {
  if (!staffIds.length) return new Map();
  const rows = await Customer.aggregate([
    { $match: { createdBy: { $in: staffIds } } },
    { $group: { _id: "$createdBy", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count || 0]));
};

const buildStaffListItem = async (user, profile, customersAdded = 0) => {
  const now = new Date();
  const [todayCollection, cashSummary] = await Promise.all([
    getStaffCollectionTotal(user._id, startOfDay(now), endOfDay(now)),
    getStaffCashInHand(user._id),
  ]);

  return {
    staffUserId: user._id,
    staffProfileId: profile._id,
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    employeeCode: profile.employeeCode,
    status: user.status,
    todayCollection,
    cashInHand: cashSummary.cashInHand,
    customersAdded,
    createdAt: user.createdAt,
  };
};

const listStaff = async ({ search = "", cursor, limit } = {}) => {
  const query = { role: USER_ROLES.STAFF };
  const trimmedSearch = parseSafeSearchTerm(search, { label: "search" });

  if (trimmedSearch) {
    const profiles = await StaffProfile.find({
      employeeCode: { $regex: trimmedSearch, $options: "i" },
    }).select("user");

    const profileUserIds = profiles.map((profile) => profile.user);

    query.$or = [
      { name: { $regex: trimmedSearch, $options: "i" } },
      { phone: { $regex: trimmedSearch, $options: "i" } },
      { _id: { $in: profileUserIds } },
    ];
  }

  const { limit: resolvedLimit, cursor: decodedCursor } = parseCursorPagination(
    { cursor, limit },
    { maxLimit: 100, defaultLimit: 50 }
  );

  if (decodedCursor?.createdAt && decodedCursor?._id) {
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { createdAt: { $lt: new Date(decodedCursor.createdAt) } },
        { createdAt: new Date(decodedCursor.createdAt), _id: { $lt: decodedCursor._id } },
      ],
    });
  }

  const users = await User.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(resolvedLimit + 1);
  const profiles = await StaffProfile.find({ user: { $in: users.map((user) => user._id) } });
  const profileMap = new Map(profiles.map((profile) => [profile.user.toString(), profile]));
  const listedUsers = users.filter((user) => profileMap.has(user._id.toString()));
  const customersAddedByStaff = await countCustomersCreatedByStaffIds(
    listedUsers.map((user) => user._id)
  );

  const items = await Promise.all(
    listedUsers.map((user) =>
      buildStaffListItem(
        user,
        profileMap.get(user._id.toString()),
        customersAddedByStaff.get(user._id.toString()) || 0
      )
    )
  );

  return buildCursorPage(items, {
    limit: resolvedLimit,
    getCursorValue: (row) => ({ createdAt: row.createdAt, _id: row.staffUserId }),
  });
};

const getStaffSummaryBuckets = async (staffUserId) => {
  const now = new Date();

  const [today, week, month, year] = await Promise.all([
    getStaffCollectionTotal(staffUserId, startOfDay(now), endOfDay(now)),
    getStaffCollectionTotal(staffUserId, startOfWeek(now), endOfDay(now)),
    getStaffCollectionTotal(staffUserId, startOfMonth(now), endOfDay(now)),
    getStaffCollectionTotal(staffUserId, startOfYear(now), endOfDay(now)),
  ]);

  return { today, week, month, year };
};

const getStaffDetail = async (
  staffUserId,
  { from, to, limit, paymentMethod } = {}
) => {
  const { user, profile } = await getStaffContextOrThrow(staffUserId);
  const now = new Date();
  const customRange = parseDateRange(from, to);

  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const rangeFrom = customRange.from || startOfMonth(now);
  const rangeTo = customRange.to || endOfDay(now);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const paymentMethodFilter = paymentMethod && paymentMethod !== "ALL" ? paymentMethod : undefined;

  const [
    cashSummary,
    collectionBuckets,
    customCollection,
    paymentMethodBreakdown,
    paymentHistory,
    cashSubmissionHistory,
    statusActions,
    customersAdded,
    customersAddedItems,
  ] = await Promise.all([
    getStaffCashInHand(staffUserId),
    getStaffSummaryBuckets(staffUserId),
    getStaffCollectionTotal(staffUserId, rangeFrom, rangeTo),
    getPaymentMethodBreakdown({
      collectedBy: staffUserId,
      paymentDate: { $gte: rangeFrom, $lte: rangeTo },
    }),
    getStaffPaymentHistory(staffUserId, {
      from: rangeFrom,
      to: rangeTo,
      limit: safeLimit,
      paymentMethod: paymentMethodFilter,
    }),
    getStaffCashSubmissionHistory(staffUserId, { from: rangeFrom, to: rangeTo }),
    getStaffRedeemedClosedHistory(staffUserId),
    Customer.countDocuments({ createdBy: staffUserId }),
    Customer.find({ createdBy: staffUserId })
      .sort({ createdAt: -1 })
      .select("name phone passbookNumber status createdAt")
      .lean(),
  ]);

  return {
    staff: {
      staffUserId: user._id,
      staffProfileId: profile._id,
      name: user.name,
      email: user.email || "",
      phone: user.phone,
      employeeCode: profile.employeeCode,
      status: user.status,
      permissions: resolveStaffPermissions(profile.permissions),
      notes: profile.notes || "",
      joinedAt: profile.joinedAt,
      createdAt: user.createdAt,
    },
    customersAdded,
    customersAddedItems: (customersAddedItems || []).map((customer) => ({
      _id: customer._id,
      name: customer.name,
      phone: customer.phone,
      passbookNumber: customer.passbookNumber || "",
      status: customer.status,
      createdAt: customer.createdAt,
    })),
    cashInHand: cashSummary.cashInHand,
    cashCollected: cashSummary.cashCollected,
    cashSubmitted: cashSummary.cashSubmitted,
    pendingCashAmount: cashSummary.cashInHand,
    collections: {
      today: collectionBuckets.today,
      week: collectionBuckets.week,
      month: collectionBuckets.month,
      year: collectionBuckets.year,
      custom: {
        from: rangeFrom,
        to: rangeTo,
        total: customCollection,
      },
    },
    paymentMethodBreakdown,
    paymentHistory,
    cashSubmissionHistory,
    redeemedByStaff: statusActions.redeemed,
    closedByStaff: statusActions.closed,
  };
};

const getStaffCashSummary = async (staffUserId, { from, to } = {}) => {
  await getStaffContextOrThrow(staffUserId);

  const customRange = parseDateRange(from, to);
  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const rangeFrom = customRange.from || startOfDay(new Date());
  const rangeTo = customRange.to || endOfDay(new Date());

  const [cashSummary, collectionTotal, paymentMethodBreakdown] = await Promise.all([
    getStaffCashInHand(staffUserId),
    getStaffCollectionTotal(staffUserId, rangeFrom, rangeTo),
    getPaymentMethodBreakdown({
      collectedBy: staffUserId,
      paymentDate: { $gte: rangeFrom, $lte: rangeTo },
    }),
  ]);

  return {
    staffUserId,
    cashInHand: cashSummary.cashInHand,
    cashCollected: cashSummary.cashCollected,
    cashSubmitted: cashSummary.cashSubmitted,
    pendingCashAmount: cashSummary.cashInHand,
    collectionTotal,
    from: rangeFrom,
    to: rangeTo,
    paymentMethodBreakdown,
  };
};

const getStaffRedeemedClosedHistory = async (staffUserId, filters = {}) => {
  await getStaffContextOrThrow(staffUserId);
  const page = await listSettlementHistory({
    settledBy: staffUserId,
    includeCustomer: true,
    from: filters.from,
    to: filters.to,
    cursor: filters.cursor,
    limit: filters.limit,
  });

  return {
    items: page.items,
    pageInfo: page.pageInfo,
    summary: page.summary,
    range: page.range,
    redeemed: page.items.filter((row) => row.status === SCHEME_STATUS.REDEEMED),
    closed: page.items.filter((row) => row.status === SCHEME_STATUS.CLOSED),
  };
};

module.exports = {
  sanitizeStaffUser,
  generateEmployeeCode,
  createStaff,
  updateStaff,
  updateStaffStatus,
  listStaff,
  getStaffDetail,
  getStaffCashSummary,
  getStaffRedeemedClosedHistory,
  getStaffContextOrThrow,
};
