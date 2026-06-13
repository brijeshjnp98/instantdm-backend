# InstantDM Backend

Instagram DM Automation backend server.

## Setup & Deploy on Railway

### Step 1 — GitHub pe upload karo
1. github.com pe naya repo banao: `instantdm-backend`
2. Yeh saari files upload karo (drag & drop)
3. `.env` file mat upload karna (secret hai)

### Step 2 — Railway pe deploy karo
1. railway.app → New Project → Deploy from GitHub
2. `instantdm-backend` repo select karo
3. Deploy ho jayega automatically

### Step 3 — Environment Variables add karo Railway mein
Railway Dashboard → Variables tab → Add these:

```
IG_APP_ID        = 2185081322252768
IG_APP_SECRET    = b67f98897773f981fdcd8bedfffdf4f1
REDIRECT_URI     = https://YOUR_RAILWAY_URL/auth/callback
FRONTEND_URL     = https://YOUR_RAILWAY_URL
WEBHOOK_VERIFY   = instantdm_webhook_secret_123
```

### Step 4 — Railway URL copy karo
Deploy hone ke baad Railway ek URL deta hai jaise:
`https://instantdm-backend-production-xxxx.up.railway.app`

Isko `.env` mein update karo REDIRECT_URI aur FRONTEND_URL mein.

### Step 5 — Meta Console mein add karo
App Settings → Basic → App Domains:
`instantdm-backend-production-xxxx.up.railway.app`

Instagram → API Setup → OAuth Redirect URIs:
`https://instantdm-backend-production-xxxx.up.railway.app/auth/callback`

### Step 6 — Webhook configure karo
Instagram → API Setup → Configure Webhooks:
- Callback URL: `https://YOUR_RAILWAY_URL/webhook`
- Verify Token: `instantdm_webhook_secret_123`
- Subscribe to: `messages`, `comments`, `mentions`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/auth/instagram` | Start OAuth login |
| GET | `/auth/callback` | OAuth callback |
| GET | `/api/profile/:userId` | Get IG profile |
| GET | `/api/conversations/:userId` | Get DM inbox |
| POST | `/api/send-dm` | Send a DM |
| GET | `/api/comments/:userId/:mediaId` | Get comments |
| POST | `/api/reply-comment` | Reply to comment |
| GET | `/api/media/:userId` | Get posts |
| GET | `/webhook` | Webhook verify |
| POST | `/webhook` | Receive events |
