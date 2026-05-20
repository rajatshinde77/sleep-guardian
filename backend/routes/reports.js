const express = require('express');
const Report = require('../models/Report');
const SleepSession = require('../models/SleepSession');
const Alert = require('../models/Alert');
const SleepEvent = require('../models/SleepEvent');
const Child = require('../models/Child');
const { protect, authorize } = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const router = express.Router();

// @GET /api/reports
router.get('/', protect, async (req, res) => {
  try {
    const reports = await Report.find()
      .populate('generatedBy', 'name')
      .sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @POST /api/reports/generate
router.post('/generate', protect, authorize('admin', 'incharge'), async (req, res) => {
  try {
    const { reportType, startDate, endDate, childrenIds } = req.body;
    const start = new Date(startDate); start.setHours(0, 0, 0, 0);
    const end = new Date(endDate); end.setHours(23, 59, 59, 999);

    const childQuery = childrenIds?.length ? { _id: { $in: childrenIds }, isActive: true } : { isActive: true };
    const children = await Child.find(childQuery);

    const childReports = await Promise.all(children.map(async (child) => {
      const sessions = await SleepSession.find({
        child: child._id, date: { $gte: start, $lte: end }, status: 'completed'
      });

      // Get all sleep events for this child in the period
      const sleepEvents = await SleepEvent.find({
        child: child._id, timestamp: { $gte: start, $lte: end }
      }).sort({ timestamp: 1 });

      // Get alerts with type breakdown
      const alerts = await Alert.find({ child: child._id, createdAt: { $gte: start, $lte: end } });
      const alertBreakdown = {
        total:  alerts.length,
        fall:   alerts.filter(a => a.alertType === 'fall_detected').length,
        fight:  alerts.filter(a => a.alertType === 'fight_detected').length,
        shout:  alerts.filter(a => a.alertType === 'shout_detected').length,
        other:  alerts.filter(a => !['fall_detected','fight_detected','shout_detected'].includes(a.alertType)).length,
      };

      const avgDuration     = sessions.length ? Math.round(sessions.reduce((a, s) => a + (s.totalDuration || 0), 0) / sessions.length) : 0;
      const avgQuality      = sessions.length ? Math.round(sessions.reduce((a, s) => a + (s.qualityScore || 0), 0) / sessions.length) : 0;
      const totalDisturbances = sessions.reduce((a, s) => a + (s.disturbanceCount || 0), 0);
      const totalWakeUps    = sessions.reduce((a, s) => a + (s.wakeUpCount || 0), 0);

      let qualityLabel = 'poor';
      if (avgQuality >= 80) qualityLabel = 'excellent';
      else if (avgQuality >= 60) qualityLabel = 'good';
      else if (avgQuality >= 40) qualityLabel = 'fair';

      return {
        child: child._id,
        totalSessions: sessions.length,
        avgDuration, avgQualityScore: avgQuality, qualityLabel,
        totalDisturbances, totalWakeUps,
        totalAlerts: alerts.length,
        alertBreakdown,
        sleepData: sessions.map(s => ({
          date:          s.date,
          sleepStart:    s.sleepStart,
          sleepEnd:      s.sleepEnd,
          duration:      s.totalDuration,
          qualityScore:  s.qualityScore,
          disturbances:  s.disturbanceCount || 0,
          wakeUps:       s.wakeUpCount || 0,
        })),
        recentEvents: sleepEvents.slice(0, 20).map(e => ({
          eventType:   e.eventType,
          timestamp:   e.timestamp,
          severity:    e.severity,
          description: e.description,
        })),
      };
    }));

    const allSessions = await SleepSession.find({ date: { $gte: start, $lte: end }, status: 'completed' });
    const allAlerts = await Alert.countDocuments({ createdAt: { $gte: start, $lte: end } });

    const report = await Report.create({
      reportType, startDate: start, endDate: end,
      generatedBy: req.user._id,
      children: children.map(c => c._id),
      summary: {
        totalChildren: children.length,
        avgSleepDuration: allSessions.length ? Math.round(allSessions.reduce((a, s) => a + (s.totalDuration || 0), 0) / allSessions.length) : 0,
        avgQualityScore: allSessions.length ? Math.round(allSessions.reduce((a, s) => a + (s.qualityScore || 0), 0) / allSessions.length) : 0,
        totalAlerts: allAlerts,
        totalDisturbances: allSessions.reduce((a, s) => a + (s.disturbanceCount || 0), 0),
      },
      childReports: childReports.map(cr => ({
        child:             cr.child,
        totalSessions:     cr.totalSessions,
        avgDuration:       cr.avgDuration,
        avgQualityScore:   cr.avgQualityScore,
        qualityLabel:      cr.qualityLabel,
        totalDisturbances: cr.totalDisturbances,
        totalWakeUps:      cr.totalWakeUps,
        totalAlerts:       cr.totalAlerts,
        alertBreakdown:    cr.alertBreakdown,
        sleepData:         cr.sleepData,
        recentEvents:      cr.recentEvents,
      })),
      status: 'ready'
    });

    res.status(201).json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/reports/dashboard/stats
router.get('/dashboard/stats', protect, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const week = new Date(); week.setDate(week.getDate() - 7);
    const [totalChildren, todaySessions, weekAlerts, ongoingSessions] = await Promise.all([
      Child.countDocuments({ isActive: true }),
      SleepSession.countDocuments({ date: { $gte: today } }),
      Alert.countDocuments({ createdAt: { $gte: week } }),
      SleepSession.countDocuments({ status: 'ongoing' }),
    ]);
    const unreadAlerts = await Alert.countDocuments({ isRead: false });
    const recentAlerts = await Alert.find({ isRead: false })
      .populate('child', 'name bedNumber')
      .sort({ createdAt: -1 }).limit(5);
    const weekSessions = await SleepSession.find({ date: { $gte: week }, status: 'completed' });
    const avgQuality = weekSessions.length ? Math.round(weekSessions.reduce((a, s) => a + (s.qualityScore || 0), 0) / weekSessions.length) : 0;
    res.json({
      success: true, data: {
        totalChildren, todaySessions, weekAlerts, ongoingSessions,
        unreadAlerts, recentAlerts, avgQuality, weekSessions: weekSessions.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/reports/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const report = await Report.findById(req.params.id)
      .populate('generatedBy', 'name')
      .populate('childReports.child', 'name bedNumber photo age gender');
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @GET /api/reports/:id/pdf  — Download PDF (full report OR single child)
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const { childId } = req.query;
    const report = await Report.findById(req.params.id)
      .populate('generatedBy', 'name')
      .populate('childReports.child', 'name bedNumber age gender');
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

    // If childId provided, filter to just that child
    const isSingleChild = !!childId;
    const childReports = isSingleChild
      ? report.childReports.filter(cr => String(cr.child?._id) === String(childId))
      : report.childReports;
    const singleChild = isSingleChild && childReports[0]?.child;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const filename = isSingleChild
      ? `SmartNest_${singleChild?.name || 'Child'}_${report.reportType}_Report.pdf`
      : `SmartNest_${report.reportType}_${new Date(report.startDate).toISOString().split('T')[0]}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    // ── Header Banner ──
    doc.rect(0, 0, doc.page.width, 90).fill('#1e1b4b');
    doc.fill('#ffffff').fontSize(22).font('Helvetica-Bold').text('SmartNest', 50, 22);
    const subtitle = isSingleChild
      ? `${report.reportType.toUpperCase()} REPORT — ${singleChild?.name?.toUpperCase() || 'CHILD'}`
      : `${report.reportType.toUpperCase()} SLEEP MONITORING REPORT`;
    doc.fontSize(11).font('Helvetica').text(subtitle, 50, 52);
    doc.fontSize(9).text(`Generated: ${new Date(report.createdAt).toLocaleString()}   |   By: ${report.generatedBy?.name || 'System'}`, 50, 70);

    // ── Period ──
    doc.fill('#1e1b4b').fontSize(13).font('Helvetica-Bold').text('Report Period', 50, 108);
    doc.fill('#374151').fontSize(11).font('Helvetica')
       .text(`${new Date(report.startDate).toDateString()}  to  ${new Date(report.endDate).toDateString()}`, 50, 125);

    // ── Summary Cards ──
    const cardY = 152;
    let cards;
    if (isSingleChild && childReports[0]) {
      const cr = childReports[0];
      cards = [
        { label: 'Total Sessions', value: String(cr.totalSessions || 0), color: '#4f46e5' },
        { label: 'Sleep Quality', value: `${cr.avgQualityScore || 0}%`, color: '#16a34a' },
        { label: 'Disturbances', value: String(cr.totalDisturbances || 0), color: '#f59e0b' },
        { label: 'Alerts', value: String(cr.totalAlerts || 0), color: '#dc2626' },
      ];
    } else {
      cards = [
        { label: 'Total Children', value: String(report.summary?.totalChildren || 0), color: '#4f46e5' },
        { label: 'Avg Sleep Quality', value: `${report.summary?.avgQualityScore || 0}%`, color: '#16a34a' },
        { label: 'Total Alerts', value: String(report.summary?.totalAlerts || 0), color: '#dc2626' },
        { label: 'Avg Sleep (min)', value: String(report.summary?.avgSleepDuration || 0), color: '#d97706' },
      ];
    }
    const cardW = 115, cardH = 58, gap = 10;
    cards.forEach((c, i) => {
      const x = 50 + i * (cardW + gap);
      doc.roundedRect(x, cardY, cardW, cardH, 6).fill('#f1f5f9');
      doc.fill(c.color).fontSize(20).font('Helvetica-Bold')
         .text(c.value, x, cardY + 8, { width: cardW, align: 'center' });
      doc.fill('#6b7280').fontSize(9).font('Helvetica')
         .text(c.label, x, cardY + 38, { width: cardW, align: 'center' });
    });

    // ── Per Child Summary Table ──
    const tableTop = cardY + 78;
    doc.fill('#1e1b4b').fontSize(13).font('Helvetica-Bold')
       .text(isSingleChild ? 'Child Sleep Details' : 'Per Child Summary', 50, tableTop);

    const cols = [130, 55, 60, 70, 60, 55, 70];
    const headers = ['Child Name', 'Bed', 'Sessions', 'Avg Quality', 'Avg Sleep', 'WakeUps', 'Alerts'];
    const rowH = 22;
    let ty = tableTop + 18;

    // Header row
    doc.rect(50, ty, 500, rowH).fill('#4f46e5');
    let cx = 50;
    headers.forEach((h, i) => {
      doc.fill('#ffffff').fontSize(8).font('Helvetica-Bold').text(h, cx + 3, ty + 6, { width: cols[i] - 6 });
      cx += cols[i];
    });
    ty += rowH;

    if (!childReports || childReports.length === 0) {
      doc.rect(50, ty, 500, rowH).fill('#f8fafc');
      doc.fill('#94a3b8').fontSize(9).font('Helvetica').text('No data in this report period', 50, ty + 6, { width: 500, align: 'center' });
      ty += rowH;
    } else {
      childReports.forEach((cr, idx) => {
        doc.rect(50, ty, 500, rowH).fill(idx % 2 === 0 ? '#f8fafc' : '#ffffff');
        const qualColor = cr.avgQualityScore >= 80 ? '#16a34a' : cr.avgQualityScore >= 60 ? '#2563eb' : cr.avgQualityScore >= 40 ? '#d97706' : '#dc2626';
        const row = [
          cr.child?.name || 'Unknown',
          cr.child?.bedNumber || '--',
          String(cr.totalSessions),
          `${cr.avgQualityScore}%`,
          `${cr.avgDuration} min`,
          String(cr.totalWakeUps || 0),
          String(cr.totalAlerts),
        ];
        cx = 50;
        row.forEach((cell, i) => {
          doc.fill(i === 3 ? qualColor : '#374151').fontSize(8)
             .font(i === 3 ? 'Helvetica-Bold' : 'Helvetica')
             .text(cell, cx + 3, ty + 6, { width: cols[i] - 6 });
          cx += cols[i];
        });
        ty += rowH;
      });
    }

    // ── Alert Breakdown Section ──
    ty += 16;
    doc.fill('#1e1b4b').fontSize(13).font('Helvetica-Bold').text('Alert Breakdown', 50, ty);
    ty += 18;

    const alertCols = [150, 80, 80, 80, 110];
    const alertHeaders = ['Child Name', 'Fall Alerts', 'Fight Alerts', 'Shout Alerts', 'Total Alerts'];
    doc.rect(50, ty, 500, rowH).fill('#dc2626');
    cx = 50;
    alertHeaders.forEach((h, i) => {
      doc.fill('#ffffff').fontSize(8).font('Helvetica-Bold').text(h, cx + 3, ty + 6, { width: alertCols[i] - 6 });
      cx += alertCols[i];
    });
    ty += rowH;

    childReports.forEach((cr, idx) => {
      doc.rect(50, ty, 500, rowH).fill(idx % 2 === 0 ? '#fff5f5' : '#ffffff');
      const ab = cr.alertBreakdown || {};
      const alertRow = [
        cr.child?.name || 'Unknown',
        String(ab.fall  || 0),
        String(ab.fight || 0),
        String(ab.shout || 0),
        String(ab.total || 0),
      ];
      cx = 50;
      alertRow.forEach((cell, i) => {
        const color = i > 0 && parseInt(cell) > 0 ? '#dc2626' : '#374151';
        doc.fill(color).fontSize(8).font(parseInt(cell) > 0 ? 'Helvetica-Bold' : 'Helvetica')
           .text(cell, cx + 3, ty + 6, { width: alertCols[i] - 6 });
        cx += alertCols[i];
      });
      ty += rowH;
    });

    // ── Sleep Events Section (single child only) ──
    if (isSingleChild && childReports[0]?.recentEvents?.length > 0) {
      ty += 16;
      if (ty > doc.page.height - 150) { doc.addPage(); ty = 50; }
      doc.fill('#1e1b4b').fontSize(13).font('Helvetica-Bold').text('Recent Sleep Events', 50, ty);
      ty += 18;

      const evCols = [160, 100, 80, 160];
      const evHeaders = ['Timestamp', 'Event Type', 'Severity', 'Description'];
      doc.rect(50, ty, 500, rowH).fill('#1e40af');
      cx = 50;
      evHeaders.forEach((h, i) => {
        doc.fill('#ffffff').fontSize(8).font('Helvetica-Bold').text(h, cx + 3, ty + 6, { width: evCols[i] - 6 });
        cx += evCols[i];
      });
      ty += rowH;

      const evTypeColor = { fall: '#dc2626', fight: '#f97316', shout: '#f59e0b', wakeup: '#2563eb', movement: '#6b7280', disturbance: '#7c3aed' };

      childReports[0].recentEvents.forEach((ev, idx) => {
        if (ty > doc.page.height - 80) { doc.addPage(); ty = 50; }
        doc.rect(50, ty, 500, rowH).fill(idx % 2 === 0 ? '#f0f9ff' : '#ffffff');
        const ts  = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '--';
        const col = evTypeColor[ev.eventType] || '#374151';
        const evRow = [ts, ev.eventType || '--', ev.severity || '--', ev.description || '--'];
        cx = 50;
        evRow.forEach((cell, i) => {
          doc.fill(i === 1 ? col : '#374151').fontSize(8)
             .font(i === 1 ? 'Helvetica-Bold' : 'Helvetica')
             .text(cell, cx + 3, ty + 6, { width: evCols[i] - 6 });
          cx += evCols[i];
        });
        ty += rowH;
      });
    }

    // ── Sleep Sessions Detail (single child) ──
    if (isSingleChild && childReports[0]?.sleepData?.length > 0) {
      ty += 16;
      if (ty > doc.page.height - 150) { doc.addPage(); ty = 50; }
      doc.fill('#1e1b4b').fontSize(13).font('Helvetica-Bold').text('Sleep Sessions Detail', 50, ty);
      ty += 18;

      const ssCols = [100, 100, 100, 70, 60, 70];
      const ssHeaders = ['Date', 'Sleep Start', 'Sleep End', 'Duration', 'Quality', 'WakeUps'];
      doc.rect(50, ty, 500, rowH).fill('#065f46');
      cx = 50;
      ssHeaders.forEach((h, i) => {
        doc.fill('#ffffff').fontSize(8).font('Helvetica-Bold').text(h, cx + 3, ty + 6, { width: ssCols[i] - 6 });
        cx += ssCols[i];
      });
      ty += rowH;

      childReports[0].sleepData.forEach((sd, idx) => {
        if (ty > doc.page.height - 80) { doc.addPage(); ty = 50; }
        doc.rect(50, ty, 500, rowH).fill(idx % 2 === 0 ? '#f0fdf4' : '#ffffff');
        const qualColor = sd.qualityScore >= 80 ? '#16a34a' : sd.qualityScore >= 60 ? '#2563eb' : '#dc2626';
        const ssRow = [
          sd.date ? new Date(sd.date).toLocaleDateString() : '--',
          sd.sleepStart ? new Date(sd.sleepStart).toLocaleTimeString() : '--',
          sd.sleepEnd   ? new Date(sd.sleepEnd).toLocaleTimeString()   : '--',
          `${sd.duration || 0} min`,
          `${sd.qualityScore || 0}%`,
          String(sd.wakeUps || 0),
        ];
        cx = 50;
        ssRow.forEach((cell, i) => {
          doc.fill(i === 4 ? qualColor : '#374151').fontSize(8)
             .font(i === 4 ? 'Helvetica-Bold' : 'Helvetica')
             .text(cell, cx + 3, ty + 6, { width: ssCols[i] - 6 });
          cx += ssCols[i];
        });
        ty += rowH;
      });
    }

    // ── Footer ──
    doc.rect(0, doc.page.height - 38, doc.page.width, 38).fill('#1e1b4b');
    doc.fill('#9ca3af').fontSize(8).font('Helvetica')
       .text('SmartNest — Child Sleep Monitoring System  |  Confidential', 50, doc.page.height - 22);

    doc.end();
  } catch (err) {
    console.error('PDF Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
