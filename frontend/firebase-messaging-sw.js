// SmartNest — Firebase Cloud Messaging Service Worker
// This file MUST be placed in the frontend/ folder (same folder as index.html)

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDQxQTe4VM9BGCalQvr3QXzb7qXXf5YpPc",
  authDomain: "smartnest-b9028.firebaseapp.com",
  projectId: "smartnest-b9028",
  storageBucket: "smartnest-b9028.firebasestorage.app",
  messagingSenderId: "185651536958",
  appId: "1:185651536958:web:ee1b59bf54eb62704c1d6f"
});

const messaging = firebase.messaging();

// Handle background messages (when app is closed or minimized)
messaging.onBackgroundMessage((payload) => {
  console.log('[SmartNest SW] Background message received:', payload);

  const title = payload.notification?.title || '🚨 SmartNest Alert';
  const body  = payload.notification?.body  || 'New alert detected';

  const options = {
    body,
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'smartnest-alert',
    requireInteraction: true,  // stays on screen until user taps
    vibrate: [200, 100, 200],  // vibrate pattern on Android
    data: payload.data || {},
    actions: [
      { action: 'view', title: '👁 View Alert' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  };

  self.registration.showNotification(title, options);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'view' || !event.action) {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});
