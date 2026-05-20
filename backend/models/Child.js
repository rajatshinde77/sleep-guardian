const mongoose = require('mongoose');

const childSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  dateOfBirth: { type: Date, required: true },
  gender: { type: String, enum: ['male', 'female', 'other'], required: true },
  admissionDate: { type: Date, default: Date.now },
  bedNumber: { type: String, required: true, unique: true },
  roomNumber: { type: String, required: true },
  photo: { type: String, default: null },
  guardianName: { type: String },
  guardianPhone: { type: String },
  medicalNotes: { type: String },
  isActive: { type: Boolean, default: true },
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tags: [String],
}, { timestamps: true, toJSON: { virtuals: true } });

childSchema.virtual('age').get(function () {
  const today = new Date();
  const birth = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
});

module.exports = mongoose.model('Child', childSchema);
