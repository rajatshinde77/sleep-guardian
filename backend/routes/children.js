const express = require('express');
const Child = require('../models/Child');
const { protect, authorize } = require('../middleware/auth');
const router = express.Router();

// @GET /api/children
router.get('/', protect, async (req, res) => {
  try {
    const { isActive, room, search } = req.query;
    let query = {};
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (room) query.roomNumber = room;
    if (search) query.name = { $regex: search, $options: 'i' };
    const children = await Child.find(query).populate('registeredBy', 'name').sort({ createdAt: -1 });
    res.json({ success: true, count: children.length, data: children });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/children
router.post('/', protect, authorize('admin', 'incharge'), async (req, res) => {
  try {
    const { photo, ...rest } = req.body;
    // Accept base64 photo (max ~5MB)
    const childData = { ...rest, registeredBy: req.user._id };
    if (photo && photo.startsWith('data:image')) {
      childData.photo = photo;
    }
    const child = await Child.create(childData);
    res.status(201).json({ success: true, data: child });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Bed number already assigned' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/children/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const child = await Child.findById(req.params.id).populate('registeredBy', 'name');
    if (!child) return res.status(404).json({ success: false, message: 'Child not found' });
    res.json({ success: true, data: child });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @PUT /api/children/:id
router.put('/:id', protect, authorize('admin', 'incharge'), async (req, res) => {
  try {
    const child = await Child.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!child) return res.status(404).json({ success: false, message: 'Child not found' });
    res.json({ success: true, data: child });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @DELETE /api/children/:id (soft delete)
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const child = await Child.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!child) return res.status(404).json({ success: false, message: 'Child not found' });
    res.json({ success: true, message: 'Child deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/children/stats/overview
router.get('/stats/overview', protect, async (req, res) => {
  try {
    const total = await Child.countDocuments({ isActive: true });
    const byRoom = await Child.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$roomNumber', count: { $sum: 1 } } }
    ]);
    const byGender = await Child.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$gender', count: { $sum: 1 } } }
    ]);
    res.json({ success: true, data: { total, byRoom, byGender } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
