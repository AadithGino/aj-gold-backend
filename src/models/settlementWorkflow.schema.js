const mongoose = require("mongoose");

const settlementWorkflowSchema = new mongoose.Schema(
  {
    status: { type: String, trim: true, default: "" },
    settlementType: { type: String, trim: true, default: "" },
    entitlementAmount: { type: Number, min: 0 },
    formulaVersion: { type: String, trim: true, default: "" },
    inputSnapshot: { type: mongoose.Schema.Types.Mixed },
    requestedAt: { type: Date },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    payoutPendingAt: { type: Date },
    paidAt: { type: Date },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    payoutMethod: { type: String, trim: true, default: "" },
    payoutReference: { type: String, trim: true, default: "" },
    payoutEvidence: {
      objectRef: { type: String, trim: true, default: "" },
      checksum: { type: String, trim: true, default: "" },
    },
    finalizedAt: { type: Date },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    notes: { type: String, trim: true, default: "" },
    clientRequestId: { type: String, trim: true, default: "" },
    journalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "FinancialJournal" }],
  },
  { _id: false }
);

module.exports = settlementWorkflowSchema;