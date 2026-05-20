const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'SleepEvent' },
  alertType: {
    type: String,
    enum: ['fall_detected', 'fight_detected', 'shout_detected', 'crying_detected', 'prolonged_absence', 'no_sleep', 'excessive_movement', 'manual'],
    required: true
  },
  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  isSentToMobile: { type: Boolean, default: false },
  sentAt: { type: Date },
  readBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  readAt: { type: Date },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolvedAt: { type: Date },
  resolution: { type: String },
  roomNumber: { type: String },
  isResolved: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Alert', alertSchema);
