
const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema({
  patientId: {
    type: String,
    required: true,
    index: true
  },

  type: {
    type: String,
    required: true,
    enum: [
      "water",
      "medicine",
      "food",
      "help",
      "emergency"
    ]
  },

  message: String,

  priority: {
    type: String,
    enum: ["normal", "high", "critical"],
    default: "normal"
  },

  temperature: Number,

  acknowledged: {
    type: Boolean,
    default: false
  },

  acknowledgedAt: Date

}, {
  timestamps: true
});

module.exports = mongoose.model(
  "PatientRequest",
  requestSchema
);