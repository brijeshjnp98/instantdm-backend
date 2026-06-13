const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const IG_APP_ID      = process.env.IG_APP_ID     || "2185081322252768";
const IG_APP_SECRET  = process.env.IG_APP_SECRET  || "b67f98897773f981fdcd8bedfffdf4f1";
const REDIRECT_URI   = process.env.REDIRECT_URI   || "https://YOUR_RAILWAY_URL/auth/callback";
const FRONTEND_URL   = process.env.FRONTEND_URL   || "https://YOUR_RAILWAY_URL";
const WEBHOOK_VERIFY = process.env.WEBHOOK_VERIFY || "instantdm_webhook_secret_123";

// In-memory store (production mein use MongoDB/Redis)
const tokenStore = {};       // { userId: { accessToken, igUserId, username, ... } }
const dmQueue    = [];       // pending DMs to send
const webhookLog = [];       // received webhook events

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ InstantDM Backend Running",
    version: "1.0.0",
    endpoints: [
      "GET  /auth/instagram        → Start OAuth",
      "GET  /auth/callback         → OAuth callback",
      "GET  /api/profile/:userId   → Get IG profile",
      "GET  /api/conversations/:userId → Get DM inbox",
      "POST /api/send-dm           → Send a DM",
      "GET  /api/comments/:userId/:mediaId → Get post comments",
      "POST /webhook               → Receive IG events",
      "GET  /webhook               → Verify webhook",
    ]
  });
});

// ─── STEP 1: START INSTAGRAM OAUTH ───────────────────────────────────────────
// Frontend calls this → redirects user to Instagram login
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

  res.redirect(authUrl);
});

// ─── STEP 2: OAUTH CALLBACK ───────────────────────────────────────────────────
// Instagram redirects here after user logs in
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}?error=${error}`);
  }

  try {
    // Exchange code for short-lived token
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

    const { access_token: shortToken, user_id: igUserId } = tokenRes.data;

    // Exchange for long-lived token (60 days)
    const longRes = await axios.get(
      `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${IG_APP_SECRET}` +
      `&access_token=${shortToken}`
    );

    const longToken = longRes.data.access_token;

    // Fetch profile
    const profileRes = await axios.get(
      `https://graph.instagram.com/v21.0/${igUserId}` +
      `?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,account_type` +
      `&access_token=${longToken}`
    );

    const profile = profileRes.data;

    // Store token
    tokenStore[igUserId] = {
      accessToken:  longToken,
      igUserId,
      username:     profile.username,
      name:         profile.name,
      bio:          profile.biography,
      followers:    profile.followers_count,
      following:    profile.follows_count,
      posts:        profile.media_count,
      profilePic:   profile.profile_picture_url,
      accountType:  profile.account_type,
      connectedAt:  new Date().toISOString(),
    };

    console.log(`✅ Connected: @${profile.username} (${igUserId})`);

    // Redirect to frontend with userId
    res.redirect(`${FRONTEND_URL}?connected=true&userId=${igUserId}&username=${profile.username}`);

  } catch (err) {
    console.error("OAuth Error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?error=oauth_failed&details=${encodeURIComponent(JSON.stringify(err.response?.data || {}))}`);
  }
});

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
app.get("/api/profile/:userId", (req, res) => {
  const user = tokenStore[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not connected" });
  const { accessToken, ...profile } = user; // don't expose token
  res.json(profile);
});

// ─── GET ALL CONNECTED USERS ──────────────────────────────────────────────────
app.get("/api/users", (req, res) => {
  const users = Object.values(tokenStore).map(({ accessToken, ...u }) => u);
  res.json(users);
});

// ─── GET DM CONVERSATIONS (INBOX) ────────────────────────────────────────────
app.get("/api/conversations/:userId", async (req, res) => {
  const user = tokenStore[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const convsRes = await axios.get(
      `https://graph.instagram.com/v21.0/${user.igUserId}/conversations` +
      `?fields=id,participants,messages{id,message,from,created_time},updated_time` +
      `&access_token=${user.accessToken}`
    );

    res.json(convsRes.data);
  } catch (err) {
    console.error("Conversations Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── SEND DM ──────────────────────────────────────────────────────────────────
app.post("/api/send-dm", async (req, res) => {
  const { userId, recipientId, message } = req.body;
  const user = tokenStore[userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const sendRes = await axios.post(
      `https://graph.instagram.com/v21.0/${user.igUserId}/messages`,
      {
        recipient: { id: recipientId },
        message:   { text: message },
      },
      {
        headers: { "Authorization": `Bearer ${user.accessToken}` }
      }
    );

    console.log(`📨 DM sent to ${recipientId}: "${message}"`);
    res.json({ success: true, messageId: sendRes.data.message_id });
  } catch (err) {
    console.error("Send DM Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── GET COMMENTS ON A POST ───────────────────────────────────────────────────
app.get("/api/comments/:userId/:mediaId", async (req, res) => {
  const user = tokenStore[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const commRes = await axios.get(
      `https://graph.instagram.com/v21.0/${req.params.mediaId}/comments` +
      `?fields=id,text,username,timestamp,from` +
      `&access_token=${user.accessToken}`
    );
    res.json(commRes.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── REPLY TO COMMENT ─────────────────────────────────────────────────────────
app.post("/api/reply-comment", async (req, res) => {
  const { userId, commentId, message } = req.body;
  const user = tokenStore[userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const replyRes = await axios.post(
      `https://graph.instagram.com/v21.0/${commentId}/replies`,
      { message },
      { params: { access_token: user.accessToken } }
    );
    res.json({ success: true, data: replyRes.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── GET MEDIA POSTS ──────────────────────────────────────────────────────────
app.get("/api/media/:userId", async (req, res) => {
  const user = tokenStore[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const mediaRes = await axios.get(
      `https://graph.instagram.com/v21.0/${user.igUserId}/media` +
      `?fields=id,caption,media_type,thumbnail_url,media_url,timestamp,like_count,comments_count,permalink` +
      `&access_token=${user.accessToken}`
    );
    res.json(mediaRes.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── WEBHOOK VERIFICATION (Meta calls this to verify) ─────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY) {
    console.log("✅ Webhook verified by Meta!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─── WEBHOOK EVENTS RECEIVER ──────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const body      = JSON.stringify(req.body);

  // Verify signature from Meta
  const expected = "sha256=" + crypto
    .createHmac("sha256", IG_APP_SECRET)
    .update(body)
    .digest("hex");

  if (signature !== expected) {
    console.log("❌ Invalid webhook signature");
    return res.sendStatus(403);
  }

  const event = req.body;
  webhookLog.unshift({ ...event, receivedAt: new Date().toISOString() });
  if (webhookLog.length > 100) webhookLog.pop();

  console.log("📩 Webhook received:", JSON.stringify(event, null, 2));

  // Process each entry
  if (event.object === "instagram") {
    event.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        handleInstagramEvent(change, entry);
      });
      entry.messaging?.forEach(msg => {
        handleDMEvent(msg, entry);
      });
    });
  }

  res.sendStatus(200);
});

// ─── HANDLE INSTAGRAM EVENTS ──────────────────────────────────────────────────
async function handleInstagramEvent(change, entry) {
  const { field, value } = change;

  if (field === "comments") {
    console.log(`💬 New comment from @${value.from?.username}: "${value.text}"`);
    // Auto-DM based on keywords
    await processCommentForKeywords(value, entry.id);
  }

  if (field === "mentions") {
    console.log(`📢 Mentioned in a post/story`);
  }
}

async function handleDMEvent(msg, entry) {
  if (msg.message && !msg.message.is_echo) {
    console.log(`✉️ New DM from ${msg.sender.id}: "${msg.message.text}"`);
    // Auto-reply logic here
    await processIncomingDM(msg, entry.id);
  }
}

// ─── KEYWORD AUTO-DM PROCESSOR ────────────────────────────────────────────────
// When someone comments a keyword → send them a DM
async function processCommentForKeywords(comment, pageId) {
  const keywords = {
    "price":    "Hey! Thanks for your interest 🎁 Here's our exclusive pricing just for you: tap.bio/pricing",
    "discount": "Use code SAVE20 for 20% off your next order! 🛍️",
    "link":     "Here's the link you asked for 🔗 tap.bio/store — shop now!",
    "collab":   "Love to collab! Fill this quick form 📝 tap.bio/collab",
    "shipping": "We ship across India in 3-5 days 🚚 Free shipping above ₹999!",
  };

  const commentText = (comment.text || "").toLowerCase();
  const user = Object.values(tokenStore).find(u => u.igUserId === pageId);
  if (!user) return;

  for (const [keyword, reply] of Object.entries(keywords)) {
    if (commentText.includes(keyword)) {
      console.log(`🔑 Keyword "${keyword}" found → sending DM to ${comment.from?.id}`);
      try {
        await axios.post(
          `https://graph.instagram.com/v21.0/${user.igUserId}/messages`,
          {
            recipient: { id: comment.from?.id },
            message:   { text: reply },
          },
          { headers: { "Authorization": `Bearer ${user.accessToken}` } }
        );
        console.log(`✅ Auto-DM sent for keyword "${keyword}"`);
      } catch (err) {
        console.error(`❌ Auto-DM failed:`, err.response?.data || err.message);
      }
      break;
    }
  }
}

// ─── INCOMING DM AUTO-REPLY ───────────────────────────────────────────────────
async function processIncomingDM(msg, pageId) {
  const user = Object.values(tokenStore).find(u => u.igUserId === pageId);
  if (!user) return;

  const text = (msg.message?.text || "").toLowerCase();

  // Welcome reply for first message
  const welcomeMsg = `Hey! 👋 Thanks for reaching out to ${user.name || user.username}! We'll get back to you shortly. In the meantime, check out our store: tap.bio/store 🛍️`;

  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/${user.igUserId}/messages`,
      {
        recipient: { id: msg.sender.id },
        message:   { text: welcomeMsg },
      },
      { headers: { "Authorization": `Bearer ${user.accessToken}` } }
    );
    console.log(`✅ Auto-reply sent to ${msg.sender.id}`);
  } catch (err) {
    console.error(`❌ Auto-reply failed:`, err.response?.data);
  }
}

// ─── WEBHOOK LOG VIEWER ───────────────────────────────────────────────────────
app.get("/api/webhook-log", (req, res) => {
  res.json(webhookLog.slice(0, 20));
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
app.post("/api/refresh-token/:userId", async (req, res) => {
  const user = tokenStore[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not connected" });

  try {
    const refreshRes = await axios.get(
      `https://graph.instagram.com/refresh_access_token` +
      `?grant_type=ig_refresh_token` +
      `&access_token=${user.accessToken}`
    );
    tokenStore[req.params.userId].accessToken = refreshRes.data.access_token;
    res.json({ success: true, expiresIn: refreshRes.data.expires_in });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 InstantDM Backend running on port ${PORT}`);
  console.log(`📱 App ID: ${IG_APP_ID}`);
  console.log(`🔗 OAuth URL: ${REDIRECT_URI}`);
});
