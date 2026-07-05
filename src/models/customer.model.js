const mongoose = require("mongoose");
const { USER_STATUS } = require("../constants/enums");

const customerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    customerCode: { type: String, unique: true, index: true, sparse: true, trim: true },
    passbookNumber: { type: String, unique: true, index: true, required: true, trim: true },
    name: { type: String, trim: true, required: true },
    phone: { type: String, index: true, trim: true, required: true },
    address: { type: String, trim: true },
    nominee: {
      name: String,
      phone: String,
      relationship: String,
      address: String,
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

customerSchema.index({ name: 1 });

module.exports = mongoose.model("Customer", customerSchema);
