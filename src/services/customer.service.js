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
const { isInFirstPeriod } = require("../utils/schemeWindow");
const {
  assertCustomerPassword,
} = require("../constants/credentialPolicies");
const {
  generateTemporaryPassword,
} = require("./auth.service");

const {
  assertCustomerSearchAccess,
  assertCustomerUpdateAccess,
  getCustomerAccessMode,
} = require("./accessControl.service");
const {
  enrichPaymentsWithEffectiveView,
  applyEffectivePaymentRow,
} = require("../utils/effectiveReadModel");

const getId = (value) => (value && typeof value === "object" ? value._id || null : value || null);

const sanitizeCollectionCustomer = (customer) => ({
  _id: customer._id,
  passbookNumber: customer.passbookNumber,
  name: customer.name,
  phone: customer.phone,
  status: customer.status,
});

const sanitizeCollectionSearchItem = (item) => ({
  ...sanitizeCollectionCustomer(item),
  activeScheme: item.activeScheme
    ? {
        _id: item.activeScheme._id,
        enrollmentNumber: item.activeScheme.enrollmentNumber,
        status: item.activeScheme.status,
        totalPaid: item.activeScheme.totalPaid,
        remainingAllowedPayment: item.activeScheme.remainingAllowedPayment,
        paymentCount: item.activeScheme.paymentCount,
        inFirstSixMonths: item.activeScheme.inFirstSixMonths,
        limitFullyUsed: item.activeScheme.limitFullyUsed,
      }
    : null,
});

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

const getCustomerOrThrow = async (customerId, session = null) => {
  const customer = await Customer.findById(customerId).session(session || null);
  if (!customer) {
    throw new ApiError(404, "Customer not found.");
  }
  return customer;
};

const assertCustomerActiveForOperations = async (customer, session = null) => {
  if (customer.status === USER_STATUS.INACTIVE) {
    throw new ApiError(403, "Customer account is inactive.");
  }

  if (!customer.user) return;

  const user = await User.findById(customer.user).session(session || null);
  if (!user || user.status === USER_STATUS.INACTIVE) {
    throw new ApiError(403, "Customer login account is inactive.");
  }
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
    settlement: scheme.settlement
      ? {
          amount: scheme.settlement.amount,
          settledAt: scheme.settlement.settledAt,
          settledBy: scheme.settlement.settledBy,
          notes: scheme.settlement.notes || "",
          formulaVersion: scheme.settlement.formulaVersion || "",
          totalPaidAtSettlement: scheme.settlement.totalPaidAtSettlement,
          payoutMethod: scheme.settlement.payoutMethod || "",
          payoutReference: scheme.settlement.payoutReference || "",
          settlementReceiptId: scheme.settlement.settlementReceiptId || "",
          settlementCategory: scheme.settlement.settlementCategory || "",
        }
      : null,
    settlementWorkflow: scheme.settlementWorkflow || null,
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

  const initialPassword = payload.password?.trim() || passbookNumber;
  const temporaryPasswordReturned = payload.password?.trim() ? null : initialPassword;
  if (payload.password?.trim()) {
    assertCustomerPassword(initialPassword);
  }
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

    return {
      ...sanitizeCustomer(customer),
      ...(temporaryPasswordReturned ? { temporaryPassword: temporaryPasswordReturned } : {}),
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const updateCustomer = async (customerId, payload, actor) => {
  assertCustomerUpdateAccess(actor);
  const customer = await getCustomerOrThrow(customerId);
  const previousValue = sanitizeCustomer(customer);

  if (payload.passbookNumber !== undefined && actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can update passbook number.");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (payload.passbookNumber && payload.passbookNumber.trim() !== customer.passbookNumber) {
      const duplicate = await Customer.findOne({
        passbookNumber: payload.passbookNumber.trim(),
        _id: { $ne: customer._id },
      }).session(session);
      if (duplicate) {
        throw new ApiError(409, "Passbook number already exists.");
      }
      customer.passbookNumber = payload.passbookNumber.trim();
    }

    if (payload.phone && payload.phone.trim() !== customer.phone) {
      const duplicatePhone = await User.findOne({
        phone: payload.phone.trim(),
        _id: { $ne: customer.user },
      }).session(session);
      if (duplicatePhone) {
        throw new ApiError(409, "Phone number is already registered.");
      }
      customer.phone = payload.phone.trim();
    }

    if (payload.name) {
      customer.name = payload.name.trim();
    }

    if (payload.address !== undefined) {
      customer.address = payload.address?.trim() || "";
    }

    if (payload.nominee) {
      customer.nominee = {
        name: payload.nominee.name?.trim() || customer.nominee?.name || "",
        phone: payload.nominee.phone?.trim() || customer.nominee?.phone || "",
        relationship:
          payload.nominee.relationship?.trim() || customer.nominee?.relationship || "",
        address: payload.nominee.address?.trim() || customer.nominee?.address || "",
      };
    }

    customer.updatedBy = actor._id;
    await customer.save({ session });

    if (customer.user && (payload.name || payload.phone)) {
      await User.findByIdAndUpdate(
        customer.user,
        {
          ...(payload.name ? { name: payload.name.trim() } : {}),
          ...(payload.phone ? { phone: payload.phone.trim() } : {}),
          updatedBy: actor._id,
        },
        { session }
      );
    }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

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

  const passwordToSet = newPassword?.trim() || customer.passbookNumber || generateTemporaryPassword().slice(0, 4);
  assertCustomerPassword(passwordToSet);
  const passwordHash = await bcrypt.hash(passwordToSet, 10);
  const temporaryPasswordReturned = newPassword?.trim() ? null : passwordToSet;

  await User.findByIdAndUpdate(customer.user, {
    passwordHash,
    updatedBy: actor._id,
    $inc: { tokenVersion: 1 },
  });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    targetType: "Customer",
    targetId: customer._id,
    notes: "Customer password reset",
  });

  return {
    success: true,
    ...(temporaryPasswordReturned ? { temporaryPassword: temporaryPasswordReturned } : {}),
  };
};

const searchCustomers = async (search = "", actor = null) => {
  const accessMode = await assertCustomerSearchAccess(actor, search);
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
        const inFirstSixMonths = isInFirstPeriod(activeSchemeDoc, now);
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

      const item = {
        ...sanitizeCustomer(customer),
        activeScheme,
        schemeStatusCounts,
      };

      return accessMode === "collection" ? sanitizeCollectionSearchItem(item) : item;
    })
  );

  return items;
};

const getCustomerDetail = async (customerId, actor = null) => {
  const accessMode = await getCustomerAccessMode(actor);
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

  const enrichedPayments = await enrichPaymentsWithEffectiveView(
    payments.map((payment) => (payment.toObject ? payment.toObject() : payment))
  );

  const paymentHistory = enrichedPayments
    .filter(({ view }) => view.effectiveLedger)
    .map(({ payment, latest }) => {
      const effectiveMeta = applyEffectivePaymentRow(payment, latest);
      return {
        _id: payment._id,
        amount: effectiveMeta.displayAmount,
        paymentMethod: effectiveMeta.displayPaymentMethod,
        paymentDate: effectiveMeta.displayPaymentDate,
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
        sourceAmount: payment.amount,
        effectiveAmount: effectiveMeta.effectiveAmount,
      };
    });

  const receiptHistory = paymentHistory.map((payment) => ({
    receiptNumber: payment.receiptNumber,
    amount: payment.amount,
    paymentDate: payment.paymentDate,
    scheme: payment.scheme,
  }));

  if (accessMode === "collection") {
    return {
      customer: sanitizeCollectionCustomer(customer),
      activeScheme: grouped.active
        ? {
            _id: grouped.active._id,
            enrollmentNumber: grouped.active.enrollmentNumber,
            status: grouped.active.status,
            totalPaid: grouped.active.totalPaid,
            remainingAllowedPayment: grouped.active.remainingAllowedPayment,
            progress: grouped.active.progress,
          }
        : null,
    };
  }

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

const getCustomerSchemes = async (customerId, actor = null) => {
  const accessMode = await getCustomerAccessMode(actor);
  await getCustomerOrThrow(customerId);
  const schemes = await Scheme.find({ customer: customerId })
    .populate("createdBy", "name role")
    .populate("updatedBy", "name role")
    .populate("statusHistory.changedBy", "name role")
    .sort({ createdAt: -1 });
  const enriched = await Promise.all(schemes.map((scheme) => enrichScheme(scheme)));

  if (accessMode === "collection") {
    return enriched
      .filter((scheme) => scheme.status === SCHEME_STATUS.ACTIVE)
      .map((scheme) => ({
        _id: scheme._id,
        enrollmentNumber: scheme.enrollmentNumber,
        status: scheme.status,
        totalPaid: scheme.totalPaid,
        remainingAllowedPayment: scheme.remainingAllowedPayment,
        progress: scheme.progress,
      }));
  }

  return enriched;
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
  assertCustomerActiveForOperations,
  enrichScheme,
  buildSchemeProgress,
  groupSchemes,
};
