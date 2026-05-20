const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reportType: { type: String, enum: ['weekly', 'monthly', 'custom'], required: true },
  startDate: { type: Date, required: true },
  endDate:   { type: Date, required: true },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  children: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Child' }],

  summary: {
    totalChildren:    Number,
    avgSleepDuration: Number,
    avgQualityScore:  Number,
    totalAlerts:      Number,
    totalDisturbances: Number,
  },

  childReports: [{
    child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child' },

    // ── Basic sleep stats ──────────────────────────────────
    totalSessions:    Number,
    avgDuration:      Number,
    avgQualityScore:  Number,
    qualityLabel:     String,
    totalDisturbances: Number,
    totalWakeUps:     Number,   // ← NEW
    totalAlerts:      Number,

    // ── Alert breakdown by type ───────────────────────────
    alertBreakdown: {           // ← NEW
      total: Number,
      fall:  Number,
      fight: Number,
      shout: Number,
      other: Number,
    },

    // ── Sleep data per session ────────────────────────────
    sleepData: [{
      date:         Date,
      sleepStart:   Date,       // ← NEW
      sleepEnd:     Date,       // ← NEW
      duration:     Number,
      qualityScore: Number,
      disturbances: Number,     // ← NEW
      wakeUps:      Number,     // ← NEW
    }],

    // ── Recent sleep events with timestamps ───────────────
    recentEvents: [{            // ← NEW
      eventType:   String,
      timestamp:   Date,
      severity:    String,
      description: String,
    }],
  }],

  pdfUrl:  { type: String },
  status:  { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
}, { timestamps: true });

module.exports = mongoose.model('Report', reportSchema);
