const express = require('express');
const Alert = require('../models/Alert');
const { protect, authorize } = require('../middleware/auth');
const { sendAlertNotification } = require('../config/firebase');
const { sendWhatsAppAlert } = require('../config/whatsapp');
const router = express.Router();

// @GET /api/alerts
router.get('/', protect, async (req, res) => {
  try {
    const { isRead, isResolved, severity, limit = 50 } = req.query;
    let query = {};
    if (isRead !== undefined) query.isRead = isRead === 'true';
    if (isResolved !== undefined) query.isResolved = isResolved === 'true';
    if (severity) query.severity = severity;
    const alerts = await Alert.find(query)
      .populate('child', 'name bedNumber photo')
      .sort({ createdAt: -1 }).limit(parseInt(limit));
    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/alerts
router.post('/', protect, async (req, res) => {
  try {
    const alert = await Alert.create({ ...req.body });
    const populated = await alert.populate('child', 'name bedNumber');

    // Emit real-time socket event
    req.app.get('io').emit('alert:new', populated);

    // Send Firebase push notification (works even if Firebase not configured — graceful fallback)
    const childName = populated.child?.name || 'Unknown Child';
    const alertType = req.body.alertType || 'unknown';
    const severity = req.body.severity || 'medium';
    sendAlertNotification(alertType, childName, severity).catch(() => {}); // non-blocking

    // Send WhatsApp alert
    const bedNumber = populated.child?.bedNumber || 'Unknown';
    const roomNumber = req.body.roomNumber || 'Unknown';
    sendWhatsAppAlert(alertType, childName, bedNumber, severity, roomNumber).catch(() => {});

    res.status(201).json({ success: true, data: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @PUT /api/alerts/read-all
router.put('/read-all', protect, async (req, res) => {
  try {
    await Alert.updateMany({ isRead: false }, { isRead: true, readBy: req.user._id, readAt: new Date() });
    res.json({ success: true, message: 'All alerts marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/alerts/unread-count
router.get('/unread-count', protect, async (req, res) => {
  try {
    const count = await Alert.countDocuments({ isRead: false });
    res.json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @PUT /api/alerts/:id/read
router.put('/:id/read', protect, async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id,
      { isRead: true, readBy: req.user._id, readAt: new Date() }, { new: true });
    res.json({ success: true, data: alert });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @PUT /api/alerts/:id/resolve
router.put('/:id/resolve', protect, async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id,
      { isResolved: true, resolvedBy: req.user._id, resolvedAt: new Date(), resolution: req.body.resolution },
      { new: true });
    req.app.get('io').emit('alert:resolved', alert);
    res.json({ success: true, data: alert });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/alerts/register-device
// Register device FCM token for push notifications
router.post('/register-device', protect, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM token required' });
    // Store token on user (requires User model to have fcmTokens field)
    const User = require('../models/User');
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { fcmTokens: fcmToken } });
    res.json({ success: true, message: 'Device registered for push notifications' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
