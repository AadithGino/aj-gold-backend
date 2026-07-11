const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const {
  USER_ROLES,
  USER_STATUS,
  SCHEME_STATUS,
  PAYMENT_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { getNextSequence, generatePassbookNumber } = require("./receipt.service");
const { logAudit } = require("./audit.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");

const getId = (value) => (value && typeof value === "object" ? value._id || null : value || null);
const normalizeActor = (actor) => {
  if (!actor) return null;
  if (typeof actor === "object") {
    return {
      _id: actor._id || null,
      name: actor.name || "",
      role: actor.role || null,
    };
  }
  return { _id: actor, name: "", role: null };
};

const sanitizeCustomer = (customer) => ({
  _id: customer._id,
  user: customer.user,
  customerCode: customer.customerCode,
  passbookNumber: customer.passbookNumber,
  name: customer.name,
  phone: customer.phone,
  address: customer.address || "",
  nominee: customer.nominee || {},
  status: customer.status,
  createdBy: getId(customer.createdBy),
  updatedBy: getId(customer.updatedBy),
  createdAt: customer.createdAt,
  updatedAt: customer.updatedAt,
});

const generateCustomerCode = async (date = new Date()) => {
  const year = date.getFullYear();
  const seq = await getNextSequence(`customer-${year}`);
  return `AJGK-CUST-${year}-${String(seq).padStart(4, "0")}`;
};

const getCustomerOrThrow = async (customerId) => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError(404, "Customer not found.");
  }
  return customer;
};

const buildSchemeProgress = (scheme) => {
  const now = new Date();
  const start = new Date(scheme.startDate);
  const maturity = new Date(scheme.maturityDate);
  const totalMs = Math.max(maturity.getTime() - start.getTime(), 1);
  const elapsedMs = Math.max(Math.min(now.getTime() - start.getTime(), totalMs), 0);
  const progressPercent = Math.round((elapsedMs / totalMs) * 100);

  const daysLeft = Math.max(
    Math.ceil((maturity.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    0
  );
  const monthsLeft = Math.max(
    Math.ceil(daysLeft / 30),
    0
  );

  return {
    progressPercent,
    daysLeft,
    monthsLeft,
    maturityDate: scheme.maturityDate,
    startDate: scheme.startDate,
    sixMonthDate: scheme.sixMonthDate,
  };
};

const mapStatusHistory = (statusHistory = []) =>
  statusHistory.map((entry) => ({
    status: entry.status,
    changedBy: normalizeActor(entry.changedBy),
    changedByRole: entry.changedByRole || null,
    changedAt: entry.changedAt,
    notes: entry.notes || "",
  }));

const getLatestStatusEvent = (statusHistory, status) => {
  for (let i = statusHistory.length - 1; i >= 0; i -= 1) {
    if (statusHistory[i].status === status) return statusHistory[i];
  }
  return null;
};

const enrichScheme = async (scheme) => {
  const limitSummary = await getSchemeLimitSummary(scheme._id);
  const progress = buildSchemeProgress(scheme);
  const statusHistory = mapStatusHistory(scheme.statusHistory || []);
  const redeemedEvent = getLatestStatusEvent(statusHistory, SCHEME_STATUS.REDEEMED);
  const closedEvent = getLatestStatusEvent(statusHistory, SCHEME_STATUS.CLOSED);

  return {
    _id: scheme._id,
    customer: scheme.customer,
    enrollmentNumber: scheme.enrollmentNumber,
    schemeName: scheme.schemeName,
    startDate: scheme.startDate,
    sixMonthDate: scheme.sixMonthDate,
    maturityDate: scheme.maturityDate,
    status: scheme.status,
    statusHistory,
    createdBy: normalizeActor(scheme.createdBy),
    updatedBy: normalizeActor(scheme.updatedBy),
    redeemedBy: redeemedEvent?.changedBy || null,
    redeemedAt: redeemedEvent?.changedAt || null,
    closedBy: closedEvent?.changedBy || null,
    closedAt: closedEvent?.changedAt || null,
    totalPaid: limitSummary.totalPaid,
    firstSixMonthsPaid: limitSummary.firstSixMonthsPaid,
    afterSixMonthsPaid: limitSummary.afterSixMonthsPaid,
    remainingAllowedPayment: limitSummary.remainingAllowedPayment,
    progress,
    createdAt: scheme.createdAt,
    updatedAt: scheme.updatedAt,
  };
};

const groupSchemes = (schemes) => {
  const active = schemes.find((scheme) => scheme.status === SCHEME_STATUS.ACTIVE) || null;
  const redeemed = schemes.filter((scheme) => scheme.status === SCHEME_STATUS.REDEEMED);
  const closed = schemes.filter((scheme) => scheme.status === SCHEME_STATUS.CLOSED);
  const previous = schemes.filter((scheme) => scheme.status !== SCHEME_STATUS.ACTIVE);

  return { active, redeemed, closed, previous, all: schemes };
};

const createCustomer = async (payload, actor) => {
  if (payload.passbookNumber !== undefined && String(payload.passbookNumber).trim() !== "") {
    throw new ApiError(400, "Passbook number is generated automatically and cannot be provided.");
  }

  const phone = payload.phone.trim();
  const passbookNumber = await generatePassbookNumber();

  const existingPassbook = await Customer.findOne({ passbookNumber });
  if (existingPassbook) {
    throw new ApiError(409, "Passbook number already exists.");
  }

  const existingPhone = await User.findOne({ phone });
  if (existingPhone) {
    throw new ApiError(409, "Phone number is already registered.");
  }

  const initialPassword = payload.password || passbookNumber;
  const passwordHash = await bcrypt.hash(initialPassword, 10);
  const customerCode = await generateCustomerCode();

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const [user] = await User.create(
      [
        {
          name: payload.name.trim(),
          phone,
          passwordHash,
          role: USER_ROLES.CUSTOMER,
          status: USER_STATUS.ACTIVE,
          createdBy: actor._id,
          updatedBy: actor._id,
        },
      ],
      { session }
    );

    const [customer] = await Customer.create(
      [
        {
          user: user._id,
          customerCode,
          passbookNumber,
          name: payload.name.trim(),
          phone,
          address: payload.address?.trim() || "",
          nominee: {
            name: payload.nominee?.name?.trim() || "",
            phone: payload.nominee?.phone?.trim() || "",
            relationship: payload.nominee?.relationship?.trim() || "",
            address: payload.nominee?.address?.trim() || "",
          },
          status: USER_STATUS.ACTIVE,
          createdBy: actor._id,
          updatedBy: actor._id,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      targetType: "Customer",
      targetId: customer._id,
      newValue: {
        passbookNumber: customer.passbookNumber,
        name: customer.name,
        phone: customer.phone,
      },
      notes: "Customer created",
    });

    return sanitizeCustomer(customer);
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const updateCustomer = async (customerId, payload, actor) => {
  const customer = await getCustomerOrThrow(customerId);
  const previousValue = sanitizeCustomer(customer);

  if (payload.passbookNumber !== undefined && actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can update passbook number.");
  }

  if (payload.passbookNumber && payload.passbookNumber.trim() !== customer.passbookNumber) {
    const duplicate = await Customer.findOne({
      passbookNumber: payload.passbookNumber.trim(),
      _id: { $ne: customer._id },
    });
    if (duplicate) {
      throw new ApiError(409, "Passbook number already exists.");
    }
    customer.passbookNumber = payload.passbookNumber.trim();
  }

  if (payload.phone && payload.phone.trim() !== customer.phone) {
    const duplicatePhone = await User.findOne({
      phone: payload.phone.trim(),
      _id: { $ne: customer.user },
    });
    if (duplicatePhone) {
      throw new ApiError(409, "Phone number is already registered.");
    }

    customer.phone = payload.phone.trim();
    if (customer.user) {
      await User.findByIdAndUpdate(customer.user, {
        phone: payload.phone.trim(),
        updatedBy: actor._id,
      });
    }
  }

  if (payload.name) {
    customer.name = payload.name.trim();
    if (customer.user) {
      await User.findByIdAndUpdate(customer.user, {
        name: payload.name.trim(),
        updatedBy: actor._id,
      });
    }
  }

  if (payload.address !== undefined) {
    customer.address = payload.address?.trim() || "";
  }

  if (payload.nominee) {
    customer.nominee = {
      name: payload.nominee.name?.trim() || customer.nominee?.name || "",
      phone: payload.nominee.phone?.trim() || customer.nominee?.phone || "",
      relationship: payload.nominee.relationship?.trim() || customer.nominee?.relationship || "",
      address: payload.nominee.address?.trim() || customer.nominee?.address || "",
    };
  }

  customer.updatedBy = actor._id;
  await customer.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    targetType: "Customer",
    targetId: customer._id,
    previousValue,
    newValue: sanitizeCustomer(customer),
    notes: "Customer updated",
  });

  return sanitizeCustomer(customer);
};

const resetCustomerPassword = async (customerId, newPassword, actor) => {
  const customer = await getCustomerOrThrow(customerId);

  if (!customer.user) {
    throw new ApiError(400, "Customer login user is not linked.");
  }

  const passwordToSet = newPassword?.trim() || customer.passbookNumber;
  const passwordHash = await bcrypt.hash(passwordToSet, 10);

  await User.findByIdAndUpdate(customer.user, {
    passwordHash,
    updatedBy: actor._id,
  });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CUSTOMER_PASSWORD_RESET,
    targetType: "Customer",
    targetId: customer._id,
    notes: "Customer password reset",
  });

  return { success: true };
};

const searchCustomers = async (search = "") => {
  const trimmed = search.trim();
  let customers = [];

  if (!trimmed) {
    customers = await Customer.find().sort({ createdAt: -1 }).limit(100);
  } else {
    const regex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    customers = await Customer.find({
      $or: [{ name: regex }, { phone: regex }, { passbookNumber: regex }],
    })
      .sort({ createdAt: -1 })
      .limit(100);
  }

  const customerIds = customers.map((customer) => customer._id);
  const schemes = await Scheme.find({ customer: { $in: customerIds } });
  const schemesByCustomer = new Map();

  schemes.forEach((scheme) => {
    const key = scheme.customer.toString();
    if (!schemesByCustomer.has(key)) {
      schemesByCustomer.set(key, []);
    }
    schemesByCustomer.get(key).push(scheme);
  });

  const items = await Promise.all(
    customers.map(async (customer) => {
      const customerSchemes = schemesByCustomer.get(customer._id.toString()) || [];
      const activeSchemeDoc = customerSchemes.find((scheme) => scheme.status === SCHEME_STATUS.ACTIVE);
      let activeScheme = null;

      if (activeSchemeDoc) {
        activeScheme = await enrichScheme(activeSchemeDoc);
        const paymentCount = await Payment.countDocuments({
          scheme: activeSchemeDoc._id,
          status: PAYMENT_STATUS.SUCCESS,
        });
        const now = new Date();
        const inFirstSixMonths = now <= new Date(activeSchemeDoc.sixMonthDate);
        activeScheme = {
          ...activeScheme,
          paymentCount,
          inFirstSixMonths,
          limitFullyUsed:
            !inFirstSixMonths &&
            activeScheme.firstSixMonthsPaid > 0 &&
            activeScheme.remainingAllowedPayment <= 0,
        };
      }

      const schemeStatusCounts = customerSchemes.reduce((counts, scheme) => {
        counts[scheme.status] = (counts[scheme.status] || 0) + 1;
        return counts;
      }, {});

      return {
        ...sanitizeCustomer(customer),
        activeScheme,
        schemeStatusCounts,
      };
    })
  );

  return items;
};

const getCustomerDetail = async (customerId) => {
  const customer = await Customer.findById(customerId)
    .populate("createdBy", "name role")
    .populate("updatedBy", "name role");
  if (!customer) {
    throw new ApiError(404, "Customer not found.");
  }

  const schemes = await Scheme.find({ customer: customerId })
    .populate("createdBy", "name role")
    .populate("updatedBy", "name role")
    .populate("statusHistory.changedBy", "name role")
    .sort({ createdAt: -1 });
  const enrichedSchemes = await Promise.all(schemes.map((scheme) => enrichScheme(scheme)));
  const grouped = groupSchemes(enrichedSchemes);

  const payments = await Payment.find({ customer: customerId })
    .populate("scheme", "enrollmentNumber status schemeName")
    .populate("collectedBy", "name role")
    .sort({ paymentDate: -1 })
    .limit(50)
    .select("-__v");

  const paymentHistory = payments.map((payment) => ({
    _id: payment._id,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    paymentDate: payment.paymentDate,
    receiptNumber: payment.receiptNumber,
    status: payment.status,
    scheme: payment.scheme,
    collectedBy: payment.collectedBy
      ? { name: payment.collectedBy.name, role: payment.collectedBy.role }
      : null,
    collectedByRole: payment.collectedByRole,
    transactionReference: payment.transactionReference || null,
    notes: payment.notes || null,
    isLimitOverride: payment.isLimitOverride || false,
    overrideReason: payment.overrideReason || null,
  }));

  const receiptHistory = paymentHistory.map((payment) => ({
    receiptNumber: payment.receiptNumber,
    amount: payment.amount,
    paymentDate: payment.paymentDate,
    scheme: payment.scheme,
  }));

  return {
    customer: sanitizeCustomer(customer),
    customerAudit: {
      createdBy: normalizeActor(customer.createdBy),
      updatedBy: normalizeActor(customer.updatedBy),
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    },
    nominee: customer.nominee || {},
    activeScheme: grouped.active,
    previousSchemes: grouped.previous,
    closedSchemes: grouped.closed,
    redeemedSchemes: grouped.redeemed,
    withdrawnSchemes: grouped.withdrawn,
    maturedSchemes: grouped.matured,
    suspendedSchemes: grouped.suspended,
    schemes: enrichedSchemes,
    paymentHistory,
    receiptHistory,
  };
};

const getCustomerSchemes = async (customerId) => {
  await getCustomerOrThrow(customerId);
  const schemes = await Scheme.find({ customer: customerId })
    .populate("createdBy", "name role")
    .populate("updatedBy", "name role")
    .populate("statusHistory.changedBy", "name role")
    .sort({ createdAt: -1 });
  return Promise.all(schemes.map((scheme) => enrichScheme(scheme)));
};

module.exports = {
  sanitizeCustomer,
  createCustomer,
  updateCustomer,
  resetCustomerPassword,
  searchCustomers,
  getCustomerDetail,
  getCustomerSchemes,
  getCustomerOrThrow,
  enrichScheme,
  buildSchemeProgress,
  groupSchemes,
};
