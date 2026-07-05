const Scheme = require("../models/scheme.model");
const StaffProfile = require("../models/staffProfile.model");
const {
  SCHEME_STATUS,
  USER_ROLES,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { logAudit } = require("./audit.service");
const { enrichScheme } = require("./customer.service");
const {
  calculateSchemeDates,
  assertCustomerCanCreateActiveScheme,
  appendStatusHistory,
  createEnrollmentNumber,
} = require("./scheme.service");
const { getCustomerOrThrow } = require("./customer.service");

const STATUS_NOTES_REQUIRED = [
  SCHEME_STATUS.REDEEMED,
  SCHEME_STATUS.CLOSED,
  SCHEME_STATUS.WITHDRAWN,
];

const auditActionForStatus = {
  [SCHEME_STATUS.REDEEMED]: AUDIT_ACTIONS.SCHEME_REDEEMED,
  [SCHEME_STATUS.CLOSED]: AUDIT_ACTIONS.SCHEME_CLOSED,
  [SCHEME_STATUS.WITHDRAWN]: AUDIT_ACTIONS.SCHEME_WITHDRAWN,
};

const getSchemeOrThrow = async (schemeId) => {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const assertStaffSchemePermission = async (actor, status) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return;
  }

  const profile = await StaffProfile.findOne({ user: actor._id });
  if (!profile) {
    throw new ApiError(403, "Staff profile not found.");
  }

  if (status === SCHEME_STATUS.REDEEMED && !profile.permissions.canMarkRedeemed) {
    throw new ApiError(403, "Staff cannot mark scheme as redeemed.");
  }

  if (status === SCHEME_STATUS.CLOSED && !profile.permissions.canMarkClosed) {
    throw new ApiError(403, "Staff cannot mark scheme as closed.");
  }

  if (status === SCHEME_STATUS.WITHDRAWN && !profile.permissions.canMarkWithdrawn) {
    throw new ApiError(403, "Staff cannot mark scheme as withdrawn.");
  }
};

const createScheme = async ({ customerId, schemeName, startDate }, actor) => {
  const customer = await getCustomerOrThrow(customerId);
  await assertCustomerCanCreateActiveScheme(customerId);

  const dates = calculateSchemeDates(startDate || new Date());
  const enrollmentNumber = await createEnrollmentNumber(dates.startDate);

  const scheme = await Scheme.create({
    customer: customer._id,
    enrollmentNumber,
    schemeName: schemeName?.trim() || "Gold Savings Scheme",
    startDate: dates.startDate,
    sixMonthDate: dates.sixMonthDate,
    maturityDate: dates.maturityDate,
    status: SCHEME_STATUS.ACTIVE,
    statusHistory: [
      {
        status: SCHEME_STATUS.ACTIVE,
        changedBy: actor._id,
        changedByRole: actor.role,
        changedAt: new Date(),
        notes: "Scheme created",
      },
    ],
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SCHEME_CREATED,
    targetType: "Scheme",
    targetId: scheme._id,
    newValue: {
      customerId: customer._id,
      enrollmentNumber: scheme.enrollmentNumber,
      passbookNumber: customer.passbookNumber,
    },
    notes: "Scheme enrollment created",
  });

  return enrichScheme(scheme);
};

const updateSchemeStatus = async (schemeId, { status, notes }, actor) => {
  const scheme = await getSchemeOrThrow(schemeId);

  if (STATUS_NOTES_REQUIRED.includes(status) && !notes?.trim()) {
    throw new ApiError(400, "Notes are required for this status change.");
  }

  if (status === SCHEME_STATUS.ACTIVE) {
    await assertCustomerCanCreateActiveScheme(scheme.customer.toString());
  }

  await assertStaffSchemePermission(actor, status);

  const previousStatus = scheme.status;
  appendStatusHistory(scheme, {
    status,
    changedBy: actor._id,
    changedByRole: actor.role,
    notes: notes?.trim() || "",
  });
  scheme.updatedBy = actor._id;
  await scheme.save();

  const auditAction = auditActionForStatus[status] || AUDIT_ACTIONS.CUSTOMER_UPDATED;

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: auditAction,
    targetType: "Scheme",
    targetId: scheme._id,
    previousValue: { status: previousStatus },
    newValue: { status, notes: notes?.trim() || "" },
    notes: `Scheme status changed to ${status}`,
  });

  return enrichScheme(scheme);
};

const getSchemeDetail = async (schemeId) => {
  const scheme = await getSchemeOrThrow(schemeId);
  return enrichScheme(scheme);
};

module.exports = {
  createScheme,
  updateSchemeStatus,
  getSchemeDetail,
  getSchemeOrThrow,
};
