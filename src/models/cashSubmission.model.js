const mongoose = require("mongoose");

const cashSubmissionSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    submittedAmount: { type: Number, required: true, min: 0 },
    submissionDate: { type: Date, required: true, index: true },
    receivedBy: { type: String, required: true, trim: true },
    notes: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

cashSubmissionSchema.index({ staff: 1, submissionDate: -1 });

module.exports = mongoose.model("CashSubmission", cashSubmissionSchema);
