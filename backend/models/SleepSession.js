const mongoose = require('mongoose');

const sleepSessionSchema = new mongoose.Schema({
  child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
  date: { type: Date, required: true },
  sleepStart: { type: Date, required: true },
  sleepEnd: { type: Date },
  totalDuration: { type: Number }, // in minutes
  qualityScore: { type: Number, min: 0, max: 100 },
  qualityLabel: { type: String, enum: ['excellent', 'good', 'fair', 'poor'] },
  disturbanceCount: { type: Number, default: 0 },
  wakeUpCount: { type: Number, default: 0 },
  notes: { type: String },
  loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['ongoing', 'completed'], default: 'ongoing' },
}, { timestamps: true });

// Auto calculate duration and quality
sleepSessionSchema.pre('save', function (next) {
  if (this.sleepEnd && this.sleepStart) {
    this.totalDuration = Math.round((this.sleepEnd - this.sleepStart) / 60000);
    // Quality scoring logic
    let score = 100;
    score -= this.disturbanceCount * 10;
    score -= this.wakeUpCount * 15;
    if (this.totalDuration < 360) score -= 20; // less than 6 hours
    if (this.totalDuration > 540) score += 10; // more than 9 hours bonus
    score = Math.max(0, Math.min(100, score));
    this.qualityScore = score;
    if (score >= 80) this.qualityLabel = 'excellent';
    else if (score >= 60) this.qualityLabel = 'good';
    else if (score >= 40) this.qualityLabel = 'fair';
    else this.qualityLabel = 'poor';
    this.status = 'completed';
  }
  next();
});

module.exports = mongoose.model('SleepSession', sleepSessionSchema);
