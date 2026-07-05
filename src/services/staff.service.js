const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { DEFAULT_STAFF_PERMISSIONS } = require("../constants/staffPermissions");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Scheme = require("../models/scheme.model");
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
  getStaffCashInHand,
  getPaymentMethodBreakdown,
  getStaffCollectionTotal,
  getStaffPaymentHistory,
  getStaffCashSubmissionHistory,
} = require("./cash.service");
const { logAudit } = require("./audit.service");
const {
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  startOfYear,
  parseDateRange,
} = require("../utils/date");

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

const generateEmployeeCode = async (date = new Date()) => {
  const year = date.getFullYear();
  const seq = await getNextSequence(`employee-${year}`);
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
  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    throw new ApiError(409, "Phone number is already registered.");
  }

  const resolvedEmployeeCode = employeeCode?.trim() || (await generateEmployeeCode());
  const existingCode = await StaffProfile.findOne({ employeeCode: resolvedEmployeeCode });
  if (existingCode) {
    throw new ApiError(409, "Employee code already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const [user] = await User.create(
      [
        {
          name: name.trim(),
          phone: phone.trim(),
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
          permissions: {
            ...DEFAULT_STAFF_PERMISSIONS,
            ...(permissions || {}),
          },
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
    profile.permissions = {
      ...(profile.permissions?.toObject ? profile.permissions.toObject() : profile.permissions),
      ...updates.permissions,
    };
  }

  if (updates.notes !== undefined) {
    profile.notes = updates.notes?.trim() || "";
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

const buildStaffListItem = async (user, profile) => {
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
    createdAt: user.createdAt,
  };
};

const listStaff = async ({ search = "" }) => {
  const query = { role: USER_ROLES.STAFF };
  const trimmedSearch = search.trim();

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

  const users = await User.find(query).sort({ createdAt: -1 });
  const profiles = await StaffProfile.find({ user: { $in: users.map((user) => user._id) } });
  const profileMap = new Map(profiles.map((profile) => [profile.user.toString(), profile]));

  const items = await Promise.all(
    users
      .filter((user) => profileMap.has(user._id.toString()))
      .map((user) => buildStaffListItem(user, profileMap.get(user._id.toString())))
  );

  return items;
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

const getStaffDetail = async (staffUserId, { from, to } = {}) => {
  const { user, profile } = await getStaffContextOrThrow(staffUserId);
  const now = new Date();
  const customRange = parseDateRange(from, to);

  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const rangeFrom = customRange.from || startOfMonth(now);
  const rangeTo = customRange.to || endOfDay(now);

  const [
    cashSummary,
    collectionBuckets,
    customCollection,
    paymentMethodBreakdown,
    paymentHistory,
    cashSubmissionHistory,
    statusActions,
  ] = await Promise.all([
    getStaffCashInHand(staffUserId),
    getStaffSummaryBuckets(staffUserId),
    getStaffCollectionTotal(staffUserId, rangeFrom, rangeTo),
    getPaymentMethodBreakdown({
      collectedBy: staffUserId,
      paymentDate: { $gte: rangeFrom, $lte: rangeTo },
    }),
    getStaffPaymentHistory(staffUserId, { from: rangeFrom, to: rangeTo, limit: 50 }),
    getStaffCashSubmissionHistory(staffUserId, { from: rangeFrom, to: rangeTo }),
    getStaffRedeemedClosedHistory(staffUserId),
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
      permissions: profile.permissions,
      notes: profile.notes || "",
      joinedAt: profile.joinedAt,
      createdAt: user.createdAt,
    },
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
    withdrawnByStaff: statusActions.withdrawn,
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

const getStaffRedeemedClosedHistory = async (staffUserId) => {
  await getStaffContextOrThrow(staffUserId);

  const schemes = await Scheme.find({
    "statusHistory.changedBy": staffUserId,
  })
    .populate("customer", "name passbookNumber phone")
    .sort({ updatedAt: -1 });

  const redeemed = [];
  const closed = [];
  const withdrawn = [];

  schemes.forEach((scheme) => {
    scheme.statusHistory
      .filter((entry) => entry.changedBy?.toString() === staffUserId.toString())
      .forEach((entry) => {
        const item = {
          schemeId: scheme._id,
          enrollmentNumber: scheme.enrollmentNumber,
          schemeName: scheme.schemeName,
          schemeStatus: scheme.status,
          customer: scheme.customer
            ? {
                _id: scheme.customer._id,
                name: scheme.customer.name,
                passbookNumber: scheme.customer.passbookNumber,
                phone: scheme.customer.phone,
              }
            : null,
          status: entry.status,
          changedAt: entry.changedAt,
          notes: entry.notes || "",
        };

        if (entry.status === SCHEME_STATUS.REDEEMED) {
          redeemed.push(item);
        } else if (entry.status === SCHEME_STATUS.CLOSED) {
          closed.push(item);
        } else if (entry.status === SCHEME_STATUS.WITHDRAWN) {
          withdrawn.push(item);
        }
      });
  });

  return { redeemed, closed, withdrawn };
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
