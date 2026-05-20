// Firebase Admin SDK — for sending push notifications to mobile devices
// Setup: Place your Firebase service account JSON as firebase-service-account.json in the backend folder
// OR set FIREBASE_SERVICE_ACCOUNT env variable with the JSON string

let admin = null;
let firebaseEnabled = false;

try {
  admin = require('firebase-admin');
  
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    try {
      serviceAccount = require('../firebase-service-account.json');
    } catch (e) {
      console.log('ℹ️  Firebase: No service account file found. Push notifications disabled.');
      console.log('   To enable: Add firebase-service-account.json or set FIREBASE_SERVICE_ACCOUNT env var');
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseEnabled = true;
    console.log('✅ Firebase Admin SDK initialized — push notifications enabled');
  }
} catch (err) {
  console.log('ℹ️  Firebase disabled:', err.message);
}

/**
 * Send push notification to a device or topic
 * @param {string} token - FCM device token OR topic (prefix with /topics/)
 * @param {string} title - Notification title
 * @param {string} body  - Notification body
 * @param {object} data  - Extra data payload
 */
async function sendPushNotification(token, title, body, data = {}) {
  if (!firebaseEnabled || !admin) {
    console.log(`[PUSH - DISABLED] ${title}: ${body}`);
    return { success: false, reason: 'Firebase not configured' };
  }

  try {
    const message = {
      notification: { title, body },
      data: { ...data, timestamp: String(Date.now()) },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'smartnest_alerts' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    // Token or topic
    if (token.startsWith('/topics/')) {
      message.topic = token.replace('/topics/', '');
    } else {
      message.token = token;
    }

    const response = await admin.messaging().send(message);
    console.log(`✅ Push sent: ${response}`);
    return { success: true, messageId: response };
  } catch (err) {
    console.error('Push notification error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send alert notification to all staff (via topic broadcast)
 */
async function sendAlertNotification(alertType, childName, severity) {
  const emojis = { fall: '🚨', fight: '⚠️', shout: '📢', crying: '😢', movement: '🔄' };
  const emoji = emojis[alertType?.toLowerCase()] || '⚠️';
  return sendPushNotification(
    '/topics/smartnest_staff',
    `${emoji} Sleep Alert — ${severity?.toUpperCase()}`,
    `${childName}: ${alertType} detected`,
    { alertType, childName, severity }
  );
}

module.exports = { sendPushNotification, sendAlertNotification, firebaseEnabled };
