const mongoose = require("mongoose");
const { AUDIT_ACTIONS, USER_ROLES } = require("../constants/enums");

const auditLogSchema = new mongoose.Schema(
  {
    actor:       { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    actorRole:   { type: String, enum: Object.values(USER_ROLES) },
    action:      { type: String, enum: Object.values(AUDIT_ACTIONS), index: true },
    targetType:  { type: String },
    targetId:    { type: mongoose.Schema.Types.ObjectId },
    previousValue: { type: mongoose.Schema.Types.Mixed },
    newValue:      { type: mongoose.Schema.Types.Mixed },
    notes:       { type: String },
    ipAddress:   { type: String },
  },
  { timestamps: true }
);

auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
