const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

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
const payoutRoutes         = require("./routes/payout.routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.use("/api/payouts",         payoutRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
