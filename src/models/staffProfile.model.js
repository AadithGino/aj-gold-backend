const mongoose = require("mongoose");
const { DEFAULT_STAFF_PERMISSIONS } = require("../constants/staffPermissions");

const staffProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    employeeCode: { type: String, trim: true },
    permissions: {
      canCollectPayment: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canCollectPayment },
      canCreateCustomer: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canCreateCustomer },
      canViewReports: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canViewReports },
      canSubmitCash: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canSubmitCash },
      canMarkRedeemed: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canMarkRedeemed },
      canMarkClosed: { type: Boolean, default: DEFAULT_STAFF_PERMISSIONS.canMarkClosed },
      canFinalizeSettlement: {
        type: Boolean,
        default: DEFAULT_STAFF_PERMISSIONS.canFinalizeSettlement,
      },
    },
    joinedAt: { type: Date },
    notes: { type: String, trim: true, default: "" },
    cashVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

staffProfileSchema.index(
  { employeeCode: 1 },
  {
    unique: true,
    name: "uniq_staff_employee_code",
    partialFilterExpression: { employeeCode: { $exists: true, $type: "string", $gt: "" } },
  }
);

module.exports = mongoose.model("StaffProfile", staffProfileSchema);
