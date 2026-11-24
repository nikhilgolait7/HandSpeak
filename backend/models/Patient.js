const mongoose = require("mongoose");

const patientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: { type: String, required: true },
  patientId: { type: String, unique: true, default: "patient-001" },
  
  // 2 Relatives
  relative1: { name: String, mobile: String },
  relative2: { name: String, mobile: String },
  
  // 1 Doctor
  doctor: { name: String, mobile: String },
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Patient", patientSchema);