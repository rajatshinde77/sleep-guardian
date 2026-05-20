// WhatsApp Alerts via Twilio
// Place this file in: backend/config/whatsapp.js

const https = require('https');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Twilio sandbox
const ALERT_PHONE_NUMBERS  = process.env.ALERT_PHONE_NUMBERS  || 'whatsapp:+919307498732'; // comma-separated

/**
 * Send WhatsApp message via Twilio
 * @param {string} to   - e.g. "whatsapp:+919307498732"
 * @param {string} body - message text
 */
function sendWhatsApp(to, body) {
  return new Promise((resolve, reject) => {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.log('[WhatsApp DISABLED] Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
      return resolve({ success: false, reason: 'Twilio not configured' });
    }

    const postData = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: body }).toString();
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.sid) {
            console.log(`✅ WhatsApp sent to ${to}: ${parsed.sid}`);
            resolve({ success: true, sid: parsed.sid });
          } else {
            console.error(`❌ WhatsApp error:`, parsed.message || data);
            resolve({ success: false, error: parsed.message });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', (e) => {
      console.error('WhatsApp request error:', e.message);
      resolve({ success: false, error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Send alert WhatsApp to all configured numbers
 * @param {string} alertType  - fall_detected / fight_detected / shout_detected etc.
 * @param {string} childName  - Child's name
 * @param {string} bedNumber  - Bed number
 * @param {string} severity   - low / medium / high / critical
 * @param {string} roomNumber - Room number
 */
async function sendWhatsAppAlert(alertType, childName, bedNumber, severity, roomNumber) {
  const emojis = {
    fall_detected:      '🚨',
    fight_detected:     '⚠️',
    shout_detected:     '📢',
    crying_detected:    '😢',
    excessive_movement: '🔄',
    manual:             '🔔',
  };

  const emoji = emojis[alertType] || '⚠️';
  const typeLabel = alertType.replace(/_/g, ' ').toUpperCase();
  const severityLabel = severity?.toUpperCase() || 'MEDIUM';

  const message = `${emoji} *SLEEP GUARDIAN ALERT*\n\n` +
    `*Type:* ${typeLabel}\n` +
    `*Child:* ${childName}\n` +
    `*Bed:* ${bedNumber || 'Unknown'}\n` +
    `*Room:* ${roomNumber || 'Unknown'}\n` +
    `*Severity:* ${severityLabel}\n` +
    `*Time:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
    `Please check on the child immediately.`;

  // Send to all configured numbers
  const numbers = ALERT_PHONE_NUMBERS.split(',').map(n => n.trim()).filter(Boolean);
  const results = await Promise.all(numbers.map(num => sendWhatsApp(num, message)));
  return results;
}

module.exports = { sendWhatsApp, sendWhatsAppAlert };
