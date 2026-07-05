const express = require("express");
const router = express.Router();
router.get("/", (req, res) => res.json({ success: true, message: "AJ Gold Kambil API is healthy." }));
module.exports = router;
