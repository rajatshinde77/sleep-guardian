# 🌙 SleepGuardian – Child Sleep Monitoring System
## Complete Setup Guide (Step by Step)

---

## 📁 PROJECT STRUCTURE
```
sleep-guardian/
├── backend/
│   ├── config/db.js
│   ├── models/
│   │   ├── User.js
│   │   ├── Child.js
│   │   ├── SleepSession.js
│   │   ├── SleepEvent.js
│   │   ├── Alert.js
│   │   └── Report.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── children.js
│   │   ├── sleep.js
│   │   ├── alerts.js
│   │   └── reports.js
│   ├── middleware/auth.js
│   ├── server.js
│   ├── package.json
│   └── .env
└── frontend/
    └── index.html        ← Open this in browser!
```

---

## 🛠️ STEP 1: Install Prerequisites

### Install Node.js
- Go to: https://nodejs.org
- Download LTS version (20.x)
- Install it
- Verify: open terminal → type `node --version`

### Install MongoDB (Option A - Local)
- Go to: https://www.mongodb.com/try/download/community
- Download and install
- Start MongoDB service

### MongoDB Atlas (Option B - Cloud, RECOMMENDED)
1. Go to https://cloud.mongodb.com
2. Create free account
3. Create free cluster (M0)
4. Click "Connect" → "Connect your application"
5. Copy the connection string
6. Replace <password> with your password

---

## 🔧 STEP 2: Setup Backend

### Open Terminal/Command Prompt

```bash
# Go to backend folder
cd sleep-guardian/backend

# Install all packages
npm install

# Create .env file
cp .env.example .env
```

### Edit the .env file:
Open `.env` in Notepad or VS Code and fill in:

```
PORT=5000
MONGODB_URI=mongodb+srv://youruser:yourpassword@cluster0.xxxxx.mongodb.net/sleep_guardian
JWT_SECRET=mysupersecretkey123456789
JWT_EXPIRE=7d
CLIENT_URL=http://localhost:3000
NODE_ENV=development
```

> ⚠️ Replace MONGODB_URI with your actual MongoDB connection string

### Start the Backend:
```bash
npm run dev
```

You should see:
```
✅ MongoDB Connected: cluster0.xxxxx.mongodb.net
🚀 Server running on port 5000
```

---

## 🌐 STEP 3: Open Frontend

### Simple Way (No server needed!):
1. Go to `sleep-guardian/frontend/`
2. Double-click `index.html`
3. It opens in your browser!

### OR use Live Server (VS Code):
1. Install VS Code
2. Install "Live Server" extension
3. Right-click index.html → "Open with Live Server"

---

## 👤 STEP 4: Create Admin Account

1. Open the app in browser
2. Click "Create Admin Account" link
3. Enter your name, email, password
4. Click Sign In
5. You're in! ✅

---

## 🎯 STEP 5: Test All Features

### Add Children:
1. Click "Children" in sidebar
2. Click "+ Add Child"
3. Fill name, DOB, bed number, room
4. Click "Register Child"

### Start Sleep Session:
1. Click "Sleep Monitor"
2. Click "▶ Start Sleep Session"
3. Select a child
4. Click "Start"

### Log an Event:
1. Click "Sleep Monitor"
2. Click "+ Log Event"
3. Select child, event type, severity
4. Click "Log Event"
5. If it's fall/fight/shout → alert auto-created!

### View Alerts:
1. Click "🔔 Alerts" in sidebar
2. See all alerts with severity
3. Click "Resolve" to close an alert

### Generate Report:
1. Click "📈 Reports"
2. Click "📊 Generate Report"
3. Select Weekly/Monthly
4. Click "Generate"

---

## 📡 API ENDPOINTS REFERENCE

### Auth
```
POST /api/auth/setup     → Create first admin (one time only)
POST /api/auth/login     → Login
GET  /api/auth/me        → Get current user
```

### Children
```
GET    /api/children              → List all children
POST   /api/children              → Add child
GET    /api/children/:id          → Get child details
PUT    /api/children/:id          → Update child
DELETE /api/children/:id          → Deactivate child
GET    /api/children/stats/overview → Stats
```

### Sleep
```
GET  /api/sleep/sessions          → List sessions
POST /api/sleep/sessions/start    → Start session
PUT  /api/sleep/sessions/:id/end  → End session
POST /api/sleep/events            → Log event
GET  /api/sleep/events            → List events
GET  /api/sleep/child/:id/history → Child sleep history
GET  /api/sleep/tonight           → Tonight's status
```

### Alerts
```
GET /api/alerts              → List alerts
POST /api/alerts             → Create alert
PUT /api/alerts/:id/read     → Mark as read
PUT /api/alerts/:id/resolve  → Resolve alert
PUT /api/alerts/read-all     → Mark all read
GET /api/alerts/unread-count → Unread count
```

### Reports
```
GET  /api/reports              → List reports
POST /api/reports/generate     → Generate report
GET  /api/reports/:id          → Get report
GET  /api/reports/dashboard/stats → Dashboard stats
```

---

## 🧪 TESTING WITH POSTMAN

1. Download Postman: https://postman.com
2. Create new request
3. POST http://localhost:5000/api/auth/setup
4. Body (JSON):
```json
{
  "name": "Admin User",
  "email": "admin@shelter.org",
  "password": "admin123"
}
```
5. Copy the token from response
6. Use token in headers: `Authorization: Bearer <token>`

---

## 🐞 COMMON ISSUES & FIXES

| Problem | Fix |
|---------|-----|
| MongoDB not connecting | Check MONGODB_URI in .env |
| Port 5000 in use | Change PORT=5001 in .env |
| CORS error | Make sure CLIENT_URL matches in .env |
| npm install fails | Run `npm cache clean --force` then retry |
| Login fails | Make sure backend is running on port 5000 |

---

## 🚀 DEPLOY TO INTERNET (FREE)

### Backend → Railway.app
1. Go to https://railway.app
2. Connect GitHub account
3. Upload backend folder
4. Add environment variables
5. Deploy! Gets a public URL

### Frontend → Netlify
1. Go to https://netlify.com
2. Drag & drop frontend folder
3. Done! Gets a public URL

### Update API URL in index.html:
Change line: `const API = 'http://localhost:5000/api';`
To: `const API = 'https://your-railway-url.railway.app/api';`

---

## 📱 FOR MOBILE NOTIFICATIONS (Firebase)

1. Go to https://console.firebase.google.com
2. Create project
3. Add Web app
4. Go to Project Settings → Service Accounts
5. Generate private key
6. Add to .env:
```
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@project.iam.gserviceaccount.com
```

---

## ✅ SYSTEM CHECKLIST

- [ ] Node.js installed
- [ ] MongoDB connected
- [ ] Backend running on port 5000
- [ ] Frontend opens in browser
- [ ] Admin account created
- [ ] First child registered
- [ ] First sleep session started
- [ ] First event logged
- [ ] First alert received
- [ ] First report generated

**ALL DONE = FULL WORKING SYSTEM! 🎉**
