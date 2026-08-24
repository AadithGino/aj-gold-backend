const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const ApiError = require("../utils/ApiError");
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = require("../config/env");

const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError(401, "No token provided.");
    }
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (decoded.purpose) {
      throw new ApiError(401, "Invalid session token.");
    }
    const user = await User.findById(decoded.id);
    if (!user) throw new ApiError(401, "User not found.");
    if (user.status === "INACTIVE") throw new ApiError(403, "Account is inactive.");
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion || 0)) {
      throw new ApiError(401, "Session expired. Please log in again.");
    }
    req.user = user;
    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    next(new ApiError(401, "Invalid or expired token."));
  }
};

module.exports = authMiddleware;
