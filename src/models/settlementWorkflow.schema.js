const mongoose = require("mongoose");

const settlementWorkflowSchema = new mongoose.Schema(
  {
    status: { type: String, trim: true, default: "" },
    settlementType: { type: String, trim: true, default: "" },
    entitlementAmount: { type: Number, min: 0 },
    formulaVersion: { type: String, trim: true, default: "" },
    inputSnapshot: { type: mongoose.Schema.Types.Mixed },
    settledAt: { type: Date },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    payoutMethod: { type: String, trim: true, default: "" },
    payoutReference: { type: String, trim: true, default: "" },
    payoutEvidence: { type: mongoose.Schema.Types.Mixed, default: null },
    notes: { type: String, trim: true, default: "" },
    clientRequestId: { type: String, trim: true, default: "" },
    settlementReceiptId: { type: String, trim: true, default: "" },
    journalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "FinancialJournal" }],
  },
  { _id: false }
);

module.exports = settlementWorkflowSchema;