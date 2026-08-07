const mongoose = require("mongoose");
const { USER_ROLES, USER_STATUS } = require("../constants/enums");

const userSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    phone:    { type: String, required: true, unique: true, trim: true, index: true },
    email:    { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role:     { type: String, enum: Object.values(USER_ROLES), required: true, index: true },
    status:   { type: String, enum: Object.values(USER_STATUS), default: USER_STATUS.ACTIVE, index: true },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
