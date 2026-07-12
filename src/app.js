const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { CORS_ORIGINS, BODY_SIZE_LIMIT, NODE_ENV } = require("./config/env");
const requestIdMiddleware = require("./middleware/requestId.middleware");

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
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(requestIdMiddleware);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS origin not allowed."));
    },
    credentials: true,
  })
);
app.use(
  morgan(NODE_ENV === "production" ? "combined" : "dev", {
    skip: (req) => req.path === "/api/health",
  })
);
app.use(express.json({ limit: BODY_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

app.get("/", (req, res) => {
  res.json({ success: true, message: "AJ Gold Kambil API" });
});

app.use("/api/health",        healthRoutes);
app.use("/api/auth",          authRoutes);
app.use("/api/admin",         adminRoutes);
app.use("/api/customers",     customerRoutes);
app.use("/api/schemes",       schemeRoutes);
app.use("/api/payments",      paymentRoutes);
app.use("/api/dashboard",     dashboardRoutes);
app.use("/api/reports",       reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/corrections",   correctionRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
