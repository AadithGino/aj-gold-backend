const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

router.get("/", (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const payload = {
    success: mongoReady,
    message: mongoReady ? "AJ Gold Kambil API is healthy." : "MongoDB is not connected.",
    uptimeSeconds: Math.floor(process.uptime()),
    mongo: {
      readyState: mongoose.connection.readyState,
      connected: mongoReady,
    },
  };

  res.status(mongoReady ? 200 : 503).json(payload);
});

module.exports = router;
