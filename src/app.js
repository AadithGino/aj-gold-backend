const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const ApiError = require("./utils/ApiError");
const { CORS_ORIGINS, BODY_SIZE_LIMIT, NODE_ENV, TRUST_PROXY } = require("./config/env");
const requestIdMiddleware = require("./middleware/requestId.middleware");
const requestLogMiddleware = require("./middleware/requestLog.middleware");
const sensitiveResponseMiddleware = require("./middleware/sensitiveResponse.middleware");

const healthRoutes       = require("./routes/health.routes");
const authRoutes         = require("./routes/auth.routes");
const adminRoutes        = require("./routes/admin.routes");
const customerRoutes     = require("./routes/customer.routes");
const schemeRoutes       = require("./routes/scheme.routes");
const paymentRoutes      = require("./routes/payment.routes");
const dashboardRoutes    = require("./routes/dashboard.routes");
const reportRoutes       = require("./routes/report.routes");
const notificationRoutes = require("./routes/notification.routes");
const correctionRoutes   = require("./routes/correction.routes");
const profileRoutes      = require("./routes/profileDeletion.routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

if (TRUST_PROXY !== false) {
  app.set("trust proxy", TRUST_PROXY);
}

app.use(requestIdMiddleware);
app.use(requestLogMiddleware);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const normalized = origin.trim().replace(/\/+$/, "");

      if (CORS_ORIGINS.length === 0) {
        if (NODE_ENV === "production") {
          return callback(new ApiError(403, "CORS is not configured for production."));
        }
        return callback(null, true);
      }

      if (CORS_ORIGINS.includes(normalized)) {
        return callback(null, true);
      }

      return callback(new ApiError(403, "CORS origin not allowed."));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: BODY_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

app.get("/", (req, res) => {
  res.json({ success: true, message: "AJ Gold Kambil API" });
});

app.use("/api/health",        healthRoutes);
app.use("/api/auth",          sensitiveResponseMiddleware, authRoutes);
app.use("/api/admin",         sensitiveResponseMiddleware, adminRoutes);
app.use("/api/customers",     sensitiveResponseMiddleware, customerRoutes);
app.use("/api/schemes",       sensitiveResponseMiddleware, schemeRoutes);
app.use("/api/payments",      sensitiveResponseMiddleware, paymentRoutes);
app.use("/api/dashboard",     sensitiveResponseMiddleware, dashboardRoutes);
app.use("/api/reports",       sensitiveResponseMiddleware, reportRoutes);
app.use("/api/notifications", sensitiveResponseMiddleware, notificationRoutes);
app.use("/api/corrections",   sensitiveResponseMiddleware, correctionRoutes);
app.use("/api/profile",       sensitiveResponseMiddleware, profileRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
