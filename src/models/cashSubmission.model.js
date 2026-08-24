const mongoose = require("mongoose");
const { CASH_SUBMISSION_STATUS } = require("../constants/enums");

const cashSubmissionSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    submittedAmount: { type: Number, required: true, min: 0 },
    submissionDate: { type: Date, required: true, index: true },
    receivedBy: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(CASH_SUBMISSION_STATUS),
      default: CASH_SUBMISSION_STATUS.ACTIVE,
      index: true,
    },
    reversedAt: { type: Date },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reversalReason: { type: String, trim: true, default: "" },
    notes: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

cashSubmissionSchema.index({ staff: 1, submissionDate: -1 });
cashSubmissionSchema.index(
  { staff: 1, status: 1, submissionDate: -1 },
  { name: "staff_active_submissions" }
);

module.exports = mongoose.model("CashSubmission", cashSubmissionSchema);
