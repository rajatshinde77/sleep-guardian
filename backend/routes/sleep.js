const express = require('express');
const SleepSession = require('../models/SleepSession');
const SleepEvent = require('../models/SleepEvent');
const Child = require('../models/Child');
const { protect } = require('../middleware/auth');
const router = express.Router();

// @GET /api/sleep/sessions
router.get('/sessions', protect, async (req, res) => {
  try {
    const { childId, date, status, limit = 50 } = req.query;
    let query = {};
    if (childId) query.child = childId;
    if (status) query.status = status;
    if (date) {
      const start = new Date(date); start.setHours(0, 0, 0, 0);
      const end = new Date(date); end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }
    const sessions = await SleepSession.find(query)
      .populate('child', 'name bedNumber photo')
      .populate('loggedBy', 'name')
      .sort({ sleepStart: -1 })
      .limit(parseInt(limit));
    res.json({ success: true, count: sessions.length, data: sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/sleep/sessions/start
router.post('/sessions/start', protect, async (req, res) => {
  try {
    const { childId, notes } = req.body;
    const child = await Child.findById(childId);
    if (!child) return res.status(404).json({ success: false, message: 'Child not found' });
    const existing = await SleepSession.findOne({ child: childId, status: 'ongoing' });
    if (existing) return res.status(400).json({ success: false, message: 'Sleep session already ongoing for this child' });
    const session = await SleepSession.create({
      child: childId,
      date: new Date(),
      sleepStart: new Date(),
      notes,
      loggedBy: req.user._id,
      status: 'ongoing'
    });
    // Emit real-time event
    req.app.get('io').emit('sleep:started', { session, child });
    res.status(201).json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @PUT /api/sleep/sessions/:id/end
router.put('/sessions/:id/end', protect, async (req, res) => {
  try {
    const session = await SleepSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    session.sleepEnd = new Date();
    await session.save(); // triggers pre-save for quality scoring
    req.app.get('io').emit('sleep:ended', { session });
    res.json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/sleep/sessions/:id
router.get('/sessions/:id', protect, async (req, res) => {
  try {
    const session = await SleepSession.findById(req.params.id).populate('child', 'name bedNumber photo age');
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    const events = await SleepEvent.find({ session: session._id }).sort({ timestamp: 1 });
    res.json({ success: true, data: { session, events } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/sleep/events
router.post('/events', protect, async (req, res) => {
  try {
    const { childId, sessionId, eventType, severity, description, isAutomated } = req.body;
    const event = await SleepEvent.create({
      child: childId, session: sessionId, eventType, severity, description,
      isAutomated: isAutomated || false, loggedBy: req.user._id
    });
    // Update session disturbance counts
    if (sessionId) {
      const update = {};
      if (['disturbance', 'fall', 'fight', 'shout'].includes(eventType)) update.$inc = { disturbanceCount: 1 };
      if (eventType === 'wakeup') update.$inc = { ...(update.$inc || {}), wakeUpCount: 1 };
      if (Object.keys(update).length) await SleepSession.findByIdAndUpdate(sessionId, update);
    }
    const populated = await event.populate('child', 'name bedNumber');
    req.app.get('io').emit('sleep:event', populated);
    res.status(201).json({ success: true, data: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/sleep/events
router.get('/events', protect, async (req, res) => {
  try {
    const { childId, eventType, date, limit = 100 } = req.query;
    let query = {};
    if (childId) query.child = childId;
    if (eventType) query.eventType = eventType;
    if (date) {
      const start = new Date(date); start.setHours(0, 0, 0, 0);
      const end = new Date(date); end.setHours(23, 59, 59, 999);
      query.timestamp = { $gte: start, $lte: end };
    }
    const events = await SleepEvent.find(query)
      .populate('child', 'name bedNumber photo')
      .sort({ timestamp: -1 }).limit(parseInt(limit));
    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/sleep/child/:childId/history
router.get('/child/:childId/history', protect, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(); since.setDate(since.getDate() - parseInt(days));
    const sessions = await SleepSession.find({
      child: req.params.childId, createdAt: { $gte: since }, status: 'completed'
    }).sort({ date: -1 });
    const avg = sessions.reduce((acc, s) => {
      acc.duration += s.totalDuration || 0;
      acc.quality += s.qualityScore || 0;
      acc.disturbances += s.disturbanceCount || 0;
      return acc;
    }, { duration: 0, quality: 0, disturbances: 0 });
    const count = sessions.length || 1;
    res.json({
      success: true,
      data: {
        sessions,
        averages: {
          duration: Math.round(avg.duration / count),
          quality: Math.round(avg.quality / count),
          disturbances: Math.round(avg.disturbances / count)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/sleep/tonight
router.get('/tonight', protect, async (req, res) => {
  try {
    const today = new Date(); today.setHours(18, 0, 0, 0); // from 6pm
    const sessions = await SleepSession.find({
      sleepStart: { $gte: today }
    }).populate('child', 'name bedNumber photo roomNumber');
    const children = await Child.find({ isActive: true });
    res.json({ success: true, data: { sessions, totalChildren: children.length, sleeping: sessions.filter(s => s.status === 'ongoing').length } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
