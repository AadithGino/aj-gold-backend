const AuditLog = require("../models/auditLog.model");

const logAudit = async ({
  actor,
  actorRole,
  action,
  targetType,
  targetId,
  previousValue,
  newValue,
  notes,
  ipAddress,
  userAgent,
}) => {
  return AuditLog.create({
    actor,
    actorRole,
    action,
    targetType,
    targetId,
    previousValue,
    newValue,
    notes,
    ipAddress,
    userAgent,
  });
};

module.exports = {
  logAudit,
};
