const ApiError = require("../utils/ApiError");
const { assertNotLocked } = require("../services/loginRateLimit.service");

const loginRateLimitMiddleware = async (req, res, next) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
    req.clientIp = ip;
    await assertNotLocked({ ip, phone: req.body?.phone?.trim() });
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = loginRateLimitMiddleware;
