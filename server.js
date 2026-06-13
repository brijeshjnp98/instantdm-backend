const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const crypto  = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const META_APP_ID    = process.env.META_APP_ID    || "2185081322252768";
const IG_APP_ID      = process.env.IG_APP_ID      || "981987564633538";
const IG_APP_SECRET  = process.env.IG_APP_SECRET  || "b67f98897773f981fdcd8bedfffdf4f1";
const REDIRECT_URI   = process.env.REDIRECT_URI   || "https://instantdm-backend.onrender.com/auth/callback";
const FRONTEND_URL   = process.env.FRONTEND_URL   || "https://instantdm-backend.onrender.com";
const WEBHOOK_VERIFY = process.env.WEBHOOK_VERIFY || "instantdm_webhook_secret_123";
const DATABASE_URL   = process.env.DATABASE_URL   || "postgresql://instantdm_db_user:Teq0NkavkDuOR0BKZEDZyewFsGFmf18J@dpg-d8mf6se7r5hc739nicp0-a/instantdm_db";

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables if not exist
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        ig_user_id    TEXT PRIMARY KEY,
        username      TEXT,
        name          TEXT,
        bio           TEXT,
        followers     INTEGER,
        following     INTEGER,
        posts         INTEGER,
        profile_pic   TEXT,
        account_type  TEXT,
        access_token  TEXT,
        connected_at  TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS automations (
        id          SERIAL PRIMARY KEY,
        ig_user_id  TEXT REFERENCES users(ig_user_id),
        name        TEXT,
        type        TEXT,
        keyword     TEXT,
        message     TEXT,
        status      BOOLEAN DEFAULT true,
        triggers    INTEGER DEFAULT 0,
        replies     INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dm_log (
        id           SERIAL PRIMARY KEY,
        ig_user_id   TEXT,
        recipient_id TEXT,
        message      TEXT,
        status       TEXT,
        sent_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id          SERIAL PRIMARY KEY,
        event_type  TEXT,
        payload     JSONB,
        received_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database tables ready!");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

initDB();

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function saveUser(data) {
  await pool.query(`
    INSERT INTO users (ig_user_id, username, name, bio, followers, following, posts, profile_pic, account_type, access_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (ig_user_id) DO UPDATE SET
      username=EXCLUDED.username, name=EXCLUDED.name, bio=EXCLUDED.bio,
      followers=EXCLUDED.followers, following=EXCLUDED.following, posts=EXCLUDED.posts,
      profile_pic=EXCLUDED.profile_pic, access_token=EXCLUDED.access_token,
      updated_at=NOW()
  `, [data.igUserId, data.username, data.name, data.bio, data.followers,
      data.following, data.posts, data.profilePic, data.accountType, data.accessToken]);
}

async function getUser(igUserId) {
  const res = await pool.query("SELECT * FROM users WHERE ig_user_id=$1", [igUserId]);
  return res.rows[0] || null;
}

async function getAllUsers() {
  const res = await pool.query("SELECT ig_user_id,username,name,bio,followers,following,posts,profile_pic,account_type,connected_at FROM users");
  return res.rows;
}

async function logDM(igUserId, recipientId, message, status) {
  await pool.query(
    "INSERT INTO dm_log (ig_user_id,recipient_id,message,status) VALUES ($1,$2,$3,$4)",
    [igUserId, recipientId, message, status]
  );
}

async function logWebhook(eventType, payload) {
  await pool.query(
    "INSERT INTO webhook_events (event_type,payload) VALUES ($1,$2)",
    [eventType, JSON.stringify(payload)]
  );
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:  "✅ InstantDM Backend Running",
    version: "2.0.0",
    db:      "PostgreSQL Connected",
    endpoints: [
      "GET  /auth/instagram              → Start OAuth",
      "GET  /auth/callback               → OAuth callback",
      "GET  /api/profile/:userId         → Get IG profile",
      "GET  /api/users                   → All connected users",
      "GET  /api/conversations/:userId   → Get DM inbox",
      "POST /api/send-dm                 → Send a DM",
      "GET  /api/media/:userId           → Get posts",
      "GET  /api/comments/:userId/:mediaId → Get comments",
      "POST /api/reply-comment           → Reply to comment",
      "GET  /api/dm-log/:userId          → DM history",
      "GET  /webhook                     → Verify webhook",
      "POST /webhook                     → Receive IG events",
    ]
  });
});

// ─── OAUTH START ──────────────────────────────────────────────────────────────
app.get("/auth/instagram", (req, res) => {
  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
  ].join(",");

  const authUrl =
    `https://www.instagram.com/oauth/authorize` +
    `?client_id=${IG_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scopes}` +
    `&response_type=code`;

  console.log("🔗 OAuth redirect to:", authUrl);
  res.redirect(authUrl);
});

// ─── OAUTH CALLBACK ───────────────────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error, error_reason } = req.query;

  console.log("📩 OAuth callback received:", { code: code?.slice(0,10)+"...", error });

  if (error) {
    console.error("OAuth denied:", error, error_reason);
    return res.redirect(`${FRONTEND_URL}?error=${error}&reason=${error_reason||""}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}?error=no_code`);
  }

  try {
    // Step 1: Exchange code → short-lived token
    console.log("🔄 Exchanging code for token...");
    const tokenRes = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        client_id:     IG_APP_ID,
        client_secret: IG_APP_SECRET,
        grant_type:    "authorization_code",
        redirect_uri:  REDIRECT_URI,
        code,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    console.log("✅ Short token received:", tokenRes.data);
    const { access_token: shortToken, user_id: igUserId } = tokenRes.data;

    // Step 2: Exchange short → long-lived token (60 days)
    console.log("🔄 Exchanging for long-lived token...");
    const longRes = await axios.get(
      `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${IG_APP_SECRET}` +
      `&access_token=${shortToken}`
    );

    const longToken = longRes.data.access_token;
    console.log("✅ Long-lived token received");

    // Step 3: Fetch real profile
    console.log("🔄 Fetching profile...");
    const profileRes = await axios.get(
      `https://graph.instagram.com/v21.0/${igUserId}` +
      `?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,account_type` +
      `&access_token=${longToken}`
    );

    const profile = profileRes.data;
    console.log(`✅ Profile fetched: @${profile.username}`);

    // Step 4: Save to PostgreSQL
    await saveUser({
      igUserId:    String(igUserId),
      username:    profile.username,
      name:        profile.name || profile.username,
      bio:         profile.biography || "",
      followers:   profile.followers_count || 0,
      following:   profile.follows_count   || 0,
      posts:       profile.media_count     || 0,
      profilePic:  profile.profile_picture_url || "",
      accountType: profile.account_type || "BUSINESS",
      accessToken: longToken,
    });

    console.log(`💾 User @${profile.username} saved to DB!`);

    // Step 5: Redirect to frontend with userId
    const redirectUrl = `${FRONTEND_URL}?connected=true&userId=${igUserId}&username=${profile.username}&followers=${profile.followers_count||0}`;
    console.log("↩️ Redirecting to:", redirectUrl);
    res.redirect(redirectUrl);

  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("❌ OAuth Error:", JSON.stringify(errData));
    res.redirect(`${FRONTEND_URL}?error=oauth_failed&details=${encodeURIComponent(JSON.stringify(errData))}`);
  }
});

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
app.get("/api/profile/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const { access_token, ...profile } = user;
    res.json(profile);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET ALL USERS ────────────────────────────────────────────────────────────
app.get("/api/users", async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET CONVERSATIONS ────────────────────────────────────────────────────────
app.get("/api/conversations/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not connected" });

    const convsRes = await axios.get(
      `https://graph.instagram.com/v21.0/${user.ig_user_id}/conversations` +
      `?fields=id,participants,messages{id,message,from,created_time},updated_time` +
      `&access_token=${user.access_token}`
    );
    res.json(convsRes.data);
  } catch(err) {
    console.error("Conversations error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── SEND DM ──────────────────────────────────────────────────────────────────
app.post("/api/send-dm", async (req, res) => {
  const { userId, recipientId, message } = req.body;
  try {
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: "User not connected" });

    const sendRes = await axios.post(
      `https://graph.instagram.com/v21.0/${user.ig_user_id}/messages`,
      { recipient: { id: recipientId }, message: { text: message } },
      { headers: { "Authorization": `Bearer ${user.access_token}` } }
    );

    await logDM(userId, recipientId, message, "sent");
    console.log(`📨 DM sent to ${recipientId}`);
    res.json({ success: true, messageId: sendRes.data.message_id });
  } catch(err) {
    await logDM(userId, recipientId, message, "failed");
    console.error("Send DM error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── GET MEDIA ────────────────────────────────────────────────────────────────
app.get("/api/media/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not connected" });

    const mediaRes = await axios.get(
      `https://graph.instagram.com/v21.0/${user.ig_user_id}/media` +
      `?fields=id,caption,media_type,thumbnail_url,media_url,timestamp,like_count,comments_count,permalink` +
      `&access_token=${user.access_token}`
    );
    res.json(mediaRes.data);
  } catch(err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── GET COMMENTS ─────────────────────────────────────────────────────────────
app.get("/api/comments/:userId/:mediaId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not connected" });

    const commRes = await axios.get(
      `https://graph.instagram.com/v21.0/${req.params.mediaId}/comments` +
      `?fields=id,text,username,timestamp,from` +
      `&access_token=${user.access_token}`
    );
    res.json(commRes.data);
  } catch(err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── REPLY TO COMMENT ─────────────────────────────────────────────────────────
app.post("/api/reply-comment", async (req, res) => {
  const { userId, commentId, message } = req.body;
  try {
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: "User not connected" });

    const replyRes = await axios.post(
      `https://graph.instagram.com/v21.0/${commentId}/replies`,
      { message },
      { params: { access_token: user.access_token } }
    );
    res.json({ success: true, data: replyRes.data });
  } catch(err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── DM LOG ───────────────────────────────────────────────────────────────────
app.get("/api/dm-log/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM dm_log WHERE ig_user_id=$1 ORDER BY sent_at DESC LIMIT 50",
      [req.params.userId]
    );
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK VERIFY ───────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─── WEBHOOK EVENTS ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const body      = JSON.stringify(req.body);
  const expected  = "sha256=" + crypto.createHmac("sha256", IG_APP_SECRET).update(body).digest("hex");

  if (signature !== expected) {
    console.log("❌ Invalid webhook signature");
    return res.sendStatus(403);
  }

  const event = req.body;
  console.log("📩 Webhook received:", JSON.stringify(event).slice(0,200));

  await logWebhook(event.object || "unknown", event);

  if (event.object === "instagram") {
    for (const entry of (event.entry || [])) {
      for (const change of (entry.changes || [])) {
        await handleInstagramEvent(change, entry);
      }
      for (const msg of (entry.messaging || [])) {
        await handleDMEvent(msg, entry);
      }
    }
  }

  res.sendStatus(200);
});

// ─── KEYWORD AUTO-DM ──────────────────────────────────────────────────────────
async function handleInstagramEvent(change, entry) {
  const { field, value } = change;
  if (field === "comments") {
    console.log(`💬 Comment from @${value.from?.username}: "${value.text}"`);
    await processKeywordDM(value, entry.id);
  }
}

async function handleDMEvent(msg, entry) {
  if (msg.message && !msg.message.is_echo) {
    console.log(`✉️ DM from ${msg.sender.id}: "${msg.message.text}"`);
    await processIncomingDM(msg, entry.id);
  }
}

async function processKeywordDM(comment, pageId) {
  const keywords = {
    "price":    "Hey! Thanks for your interest 🎁 Here's our exclusive pricing: tap.bio/pricing",
    "discount": "Use code SAVE20 for 20% off! 🛍️",
    "link":     "Here's the link 🔗 tap.bio/store — shop now!",
    "collab":   "Love to collab! Fill this form 📝 tap.bio/collab",
    "shipping": "We ship across India in 3-5 days 🚚 Free above ₹999!",
  };

  const text = (comment.text || "").toLowerCase();
  const users = await getAllUsers();
  const user  = users.find(u => u.ig_user_id === pageId);
  if (!user) return;

  const fullUser = await getUser(user.ig_user_id);
  for (const [kw, reply] of Object.entries(keywords)) {
    if (text.includes(kw)) {
      console.log(`🔑 Keyword "${kw}" → DMing ${comment.from?.id}`);
      try {
        await axios.post(
          `https://graph.instagram.com/v21.0/${fullUser.ig_user_id}/messages`,
          { recipient: { id: comment.from?.id }, message: { text: reply } },
          { headers: { "Authorization": `Bearer ${fullUser.access_token}` } }
        );
        await logDM(fullUser.ig_user_id, comment.from?.id, reply, "auto-sent");
        console.log(`✅ Auto-DM sent for "${kw}"`);
      } catch(err) {
        console.error(`❌ Auto-DM failed:`, err.response?.data);
      }
      break;
    }
  }
}

async function processIncomingDM(msg, pageId) {
  const users    = await getAllUsers();
  const userInfo = users.find(u => u.ig_user_id === pageId);
  if (!userInfo) return;

  const fullUser   = await getUser(userInfo.ig_user_id);
  const welcomeMsg = `Hey! 👋 Thanks for reaching out to @${fullUser.username}! We'll get back to you shortly. Check our store: tap.bio/store 🛍️`;

  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/${fullUser.ig_user_id}/messages`,
      { recipient: { id: msg.sender.id }, message: { text: welcomeMsg } },
      { headers: { "Authorization": `Bearer ${fullUser.access_token}` } }
    );
    await logDM(fullUser.ig_user_id, msg.sender.id, welcomeMsg, "auto-welcome");
  } catch(err) {
    console.error("❌ Auto-reply failed:", err.response?.data);
  }
}

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
app.post("/api/refresh-token/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const refreshRes = await axios.get(
      `https://graph.instagram.com/refresh_access_token` +
      `?grant_type=ig_refresh_token&access_token=${user.access_token}`
    );

    await pool.query(
      "UPDATE users SET access_token=$1, updated_at=NOW() WHERE ig_user_id=$2",
      [refreshRes.data.access_token, req.params.userId]
    );
    res.json({ success: true, expiresIn: refreshRes.data.expires_in });
  } catch(err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 InstantDM Backend v2.0 running on port ${PORT}`);
  console.log(`📱 IG App ID: ${IG_APP_ID}`);
  console.log(`🔗 OAuth URL: ${REDIRECT_URI}`);
  console.log(`🗄️  Database: PostgreSQL`);
});
