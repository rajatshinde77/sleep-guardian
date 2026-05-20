const mongoose = require('mongoose');

const sleepEventSchema = new mongoose.Schema({
  child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'SleepSession' },
  eventType: {
    type: String,
    enum: ['wakeup', 'movement', 'disturbance', 'fall', 'fight', 'shout', 'crying', 'left_bed', 'returned_bed', 'other'],
    required: true
  },
  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'low' },
  timestamp: { type: Date, default: Date.now },
  duration: { type: Number }, // seconds
  description: { type: String },
  cameraSnapshot: { type: String }, // URL of snapshot
  loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isAutomated: { type: Boolean, default: false }, // true = detected by camera AI
  acknowledged: { type: Boolean, default: false },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('SleepEvent', sleepEventSchema);
