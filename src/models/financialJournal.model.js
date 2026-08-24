const mongoose = require("mongoose");
const crypto = require("crypto");
const { JOURNAL_EVENT_TYPES } = require("../constants/enums");

const financialJournalSchema = new mongoose.Schema(
  {
    entryId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => crypto.randomUUID(),
    },
    businessKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    eventType: {
      type: String,
      enum: Object.values(JOURNAL_EVENT_TYPES),
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },
    debitAccount: { type: String, required: true, trim: true },
    creditAccount: { type: String, required: true, trim: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", index: true },
    scheme: { type: mongoose.Schema.Types.ObjectId, ref: "Scheme", index: true },
    sourceRecordType: { type: String, trim: true, default: "" },
    sourceRecordId: { type: mongoose.Schema.Types.ObjectId },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorRole: { type: String, trim: true, default: "" },
    clientRequestId: { type: String, trim: true, default: "" },
    effectiveAt: { type: Date, required: true, index: true },
    recordedAt: { type: Date, default: Date.now },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: "FinancialJournal" },
    compensates: { type: mongoose.Schema.Types.ObjectId, ref: "FinancialJournal" },
    formulaVersion: { type: String, trim: true, default: "" },
    inputSnapshot: { type: mongoose.Schema.Types.Mixed },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

financialJournalSchema.index({ scheme: 1, eventType: 1, effectiveAt: -1 });
financialJournalSchema.index({ customer: 1, effectiveAt: -1 });

const blockMutation = function blockMutation() {
  throw new Error("Financial journal entries are immutable.");
};

financialJournalSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "replaceOne", "findOneAndReplace"],
  blockMutation
);

financialJournalSchema.pre("save", function saveGuard() {
  if (!this.isNew) {
    blockMutation();
  }
});

module.exports = mongoose.model("FinancialJournal", financialJournalSchema);
