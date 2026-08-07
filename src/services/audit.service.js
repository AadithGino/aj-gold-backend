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
  session = null,
}) => {
  const docs = await AuditLog.create(
    [
      {
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
      },
    ],
    session ? { session } : undefined
  );
  return docs[0];
};

module.exports = {
  logAudit,
};
