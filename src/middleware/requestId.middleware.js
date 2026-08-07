const crypto = require("crypto");
const ApiError = require("../utils/ApiError");

const requestIdMiddleware = (req, res, next) => {
  const incoming = req.headers["x-request-id"];
  req.requestId = typeof incoming === "string" && incoming.trim()
    ? incoming.trim().slice(0, 64)
    : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};

module.exports = requestIdMiddleware;
