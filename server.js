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
const IG_APP_ID      = process.env.IG_APP_ID      || "981987564633538";
const IG_APP_SECRET  = process.env.IG_APP_SECRET  || "b67f98897773f981fdcd8bedfffdf4f1";
const REDIRECT_URI   = process.env.REDIRECT_URI   || "https://instantdm-backend.onrender.com/auth/callback";
const FRONTEND_URL   = process.env.FRONTEND_URL   || "https://instantdm-backend.onrender.com";
const WEBHOOK_VERIFY = process.env.WEBHOOK_VERIFY || "instantdm_webhook_secret_123";
const DATABASE_URL   = process.env.DATABASE_URL   || "";

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        ig_user_id   TEXT PRIMARY KEY,
        username     TEXT,
        name         TEXT,
        bio          TEXT,
        followers    INTEGER DEFAULT 0,
        following    INTEGER DEFAULT 0,
        posts        INTEGER DEFAULT 0,
        profile_pic  TEXT,
        account_type TEXT,
        access_token TEXT,
        connected_at TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id           SERIAL PRIMARY KEY,
        ig_user_id   TEXT REFERENCES users(ig_user_id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        media_id     TEXT,
        media_url    TEXT,
        media_caption TEXT,
        keywords     TEXT[],
        dm_message   TEXT NOT NULL,
        link_url     TEXT,
        link_label   TEXT,
        reply_comment BOOLEAN DEFAULT false,
        comment_reply TEXT,
        like_comment  BOOLEAN DEFAULT false,
        max_dms       INTEGER DEFAULT 0,
        status        TEXT DEFAULT 'active',
        dm_count      INTEGER DEFAULT 0,
        trigger_count INTEGER DEFAULT 0,
        created_at    TIMESTAMP DEFAULT NOW(),
        expires_at    TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS campaign_logs (
        id           SERIAL PRIMARY KEY,
        campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        ig_user_id   TEXT,
        commenter_id TEXT,
        commenter_username TEXT,
        comment_text TEXT,
        keyword_matched TEXT,
        dm_sent      BOOLEAN DEFAULT false,
        comment_liked BOOLEAN DEFAULT false,
        comment_replied BOOLEAN DEFAULT false,
        created_at   TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dm_log (
        id           SERIAL PRIMARY KEY,
        ig_user_id   TEXT,
        recipient_id TEXT,
        message      TEXT,
        status       TEXT,
        campaign_id  INTEGER,
        sent_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id          SERIAL PRIMARY KEY,
        event_type  TEXT,
        payload     JSONB,
        received_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS link_clicks (
        id           SERIAL PRIMARY KEY,
        campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        ig_user_id   TEXT,
        recipient_id TEXT,
        target_url   TEXT,
        clicked_at   TIMESTAMP DEFAULT NOW()
      );
    `);
    // Migration: add link columns if missing (for existing deployments)
    await pool.query(`
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_url TEXT;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_label TEXT;
    `).catch(()=>{});
    console.log("✅ Database ready!");
  } catch(err) {
    console.error("❌ DB init error:", err.message);
  }
}
initDB();

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function saveUser(data) {
  await pool.query(`
    INSERT INTO users (ig_user_id,username,name,bio,followers,following,posts,profile_pic,account_type,access_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (ig_user_id) DO UPDATE SET
      username=EXCLUDED.username, name=EXCLUDED.name, bio=EXCLUDED.bio,
      followers=EXCLUDED.followers, following=EXCLUDED.following, posts=EXCLUDED.posts,
      profile_pic=EXCLUDED.profile_pic, access_token=EXCLUDED.access_token, updated_at=NOW()
  `, [data.igUserId,data.username,data.name,data.bio,data.followers,data.following,data.posts,data.profilePic,data.accountType,data.accessToken]);
}

async function getUser(igUserId) {
  const r = await pool.query("SELECT * FROM users WHERE ig_user_id=$1", [igUserId]);
  return r.rows[0] || null;
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "✅ InstantDM Backend v3.0",
  db: "PostgreSQL",
  features: ["OAuth","Campaigns","Webhooks","Auto-DM","Analytics"]
}));

// ─── OAUTH ────────────────────────────────────────────────────────────────────
app.get("/auth/instagram", (req, res) => {
  const scopes = ["instagram_business_basic","instagram_business_manage_messages","instagram_business_manage_comments","instagram_business_content_publish"].join(",");
  const authUrl = `https://www.instagram.com/oauth/authorize?client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scopes}&response_type=code&enable_fb_login=0&force_authentication=0`;
  console.log("[OAuth] Redirecting to:", authUrl);
  res.redirect(authUrl);
});
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?error=${error}`);
  try {
    const tokenRes = await axios.post("https://api.instagram.com/oauth/access_token",
      new URLSearchParams({ client_id:IG_APP_ID, client_secret:IG_APP_SECRET, grant_type:"authorization_code", redirect_uri:REDIRECT_URI, code }),
      { headers: {"Content-Type":"application/x-www-form-urlencoded"} }
    );
    const { access_token:shortToken, user_id:igUserId } = tokenRes.data;
    console.log("[OAuth Callback] Exchanging shortToken for long-lived token...");
    const longRes = await axios.get(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${IG_APP_ID}&client_secret=${IG_APP_SECRET}&fb_exchange_token=${shortToken}`);
    const longToken = longRes.data.access_token;
    console.log("[OAuth Callback] Long-lived token response status:", longRes.status);
    let profile = { id:igUserId, username:"user_"+igUserId, name:"", biography:"", followers_count:0, follows_count:0, media_count:0, profile_picture_url:"", account_type:"BUSINESS" };
    try {
      const pRes = await axios.get(`https://graph.instagram.com/v21.0/me?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,account_type&access_token=${longToken}`);
      profile = { ...profile, ...pRes.data };
    } catch(e) { console.log("⚠️ Profile fetch partial:", e.message); }
    await saveUser({ igUserId:String(igUserId), username:profile.username, name:profile.name||profile.username, bio:profile.biography||"", followers:profile.followers_count||0, following:profile.follows_count||0, posts:profile.media_count||0, profilePic:profile.profile_picture_url||"", accountType:profile.account_type||"BUSINESS", accessToken:longToken });
    console.log(`✅ Connected: @${profile.username}`);
    res.redirect(`${FRONTEND_URL}?connected=true&userId=${igUserId}&username=${profile.username}&followers=${profile.followers_count||0}`);
  } catch(err) {
    console.error("❌ OAuth Error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?error=oauth_failed&details=${encodeURIComponent(JSON.stringify(err.response?.data||{}))}`);
  }
});

// ─── PROFILE ──────────────────────────────────────────────────────────────────
app.get("/api/profile/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error:"User not found" });
    const { access_token, ...profile } = user;
    res.json(profile);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/users", async (req, res) => {
  try {
    const r = await pool.query("SELECT ig_user_id,username,name,followers,posts,profile_pic,connected_at FROM users");
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ─── MEDIA ────────────────────────────────────────────────────────────────────
app.get("/api/media/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error:"User not found" });
    const r = await axios.get(`https://graph.instagram.com/v21.0/${user.ig_user_id}/media?fields=id,caption,media_type,thumbnail_url,media_url,timestamp,like_count,comments_count,permalink&access_token=${user.access_token}`);
    res.json(r.data);
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ─── CAMPAIGNS CRUD ───────────────────────────────────────────────────────────

// Create campaign
app.post("/api/campaigns", async (req, res) => {
  const { userId, name, mediaId, mediaUrl, mediaCaption, keywords, dmMessage, linkUrl, linkLabel, replyComment, commentReply, likeComment, maxDms, expiresAt } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO campaigns (ig_user_id,name,media_id,media_url,media_caption,keywords,dm_message,link_url,link_label,reply_comment,comment_reply,like_comment,max_dms,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [userId, name, mediaId||null, mediaUrl||null, mediaCaption||null, keywords||[], dmMessage, linkUrl||null, linkLabel||null, replyComment||false, commentReply||null, likeComment||false, maxDms||0, expiresAt||null]);
    console.log(`📣 Campaign created: "${name}" by ${userId}`);
    res.json({ success:true, campaign:r.rows[0] });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Get all campaigns for user
app.get("/api/campaigns/:userId", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, 
        COUNT(cl.id) as total_logs,
        COUNT(CASE WHEN cl.dm_sent THEN 1 END) as dms_sent
      FROM campaigns c
      LEFT JOIN campaign_logs cl ON cl.campaign_id = c.id
      WHERE c.ig_user_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [req.params.userId]);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Get single campaign with logs
app.get("/api/campaigns/:userId/:campaignId", async (req, res) => {
  try {
    const camp = await pool.query("SELECT * FROM campaigns WHERE id=$1 AND ig_user_id=$2", [req.params.campaignId, req.params.userId]);
    if (!camp.rows.length) return res.status(404).json({ error:"Campaign not found" });
    const logs = await pool.query("SELECT * FROM campaign_logs WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 50", [req.params.campaignId]);
    res.json({ campaign:camp.rows[0], logs:logs.rows });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Update campaign status
app.patch("/api/campaigns/:campaignId", async (req, res) => {
  const { status, dmMessage, keywords, linkUrl, linkLabel, replyComment, commentReply, likeComment, maxDms } = req.body;
  try {
    const updates = [];
    const vals    = [];
    let idx = 1;
    if (status      !== undefined) { updates.push(`status=$${idx++}`);          vals.push(status); }
    if (dmMessage   !== undefined) { updates.push(`dm_message=$${idx++}`);       vals.push(dmMessage); }
    if (keywords    !== undefined) { updates.push(`keywords=$${idx++}`);         vals.push(keywords); }
    if (linkUrl     !== undefined) { updates.push(`link_url=$${idx++}`);         vals.push(linkUrl); }
    if (linkLabel   !== undefined) { updates.push(`link_label=$${idx++}`);       vals.push(linkLabel); }
    if (replyComment!== undefined) { updates.push(`reply_comment=$${idx++}`);   vals.push(replyComment); }
    if (commentReply!== undefined) { updates.push(`comment_reply=$${idx++}`);   vals.push(commentReply); }
    if (likeComment !== undefined) { updates.push(`like_comment=$${idx++}`);    vals.push(likeComment); }
    if (maxDms      !== undefined) { updates.push(`max_dms=$${idx++}`);         vals.push(maxDms); }
    vals.push(req.params.campaignId);
    const r = await pool.query(`UPDATE campaigns SET ${updates.join(",")} WHERE id=$${idx} RETURNING *`, vals);
    res.json({ success:true, campaign:r.rows[0] });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Delete campaign
app.delete("/api/campaigns/:campaignId", async (req, res) => {
  try {
    await pool.query("DELETE FROM campaigns WHERE id=$1", [req.params.campaignId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Campaign analytics
app.get("/api/campaigns/:campaignId/analytics", async (req, res) => {
  try {
    const camp = await pool.query("SELECT * FROM campaigns WHERE id=$1", [req.params.campaignId]);
    const logs = await pool.query(`
      SELECT 
        COUNT(*) as total_triggers,
        COUNT(CASE WHEN dm_sent THEN 1 END) as dms_sent,
        COUNT(CASE WHEN comment_liked THEN 1 END) as comments_liked,
        COUNT(CASE WHEN comment_replied THEN 1 END) as comments_replied,
        array_agg(DISTINCT keyword_matched) as keywords_triggered,
        MIN(created_at) as first_trigger,
        MAX(created_at) as last_trigger
      FROM campaign_logs WHERE campaign_id=$1
    `, [req.params.campaignId]);
    const recent = await pool.query("SELECT * FROM campaign_logs WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 20", [req.params.campaignId]);
    res.json({ campaign:camp.rows[0], stats:logs.rows[0], recent:recent.rows });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ─── SEND DM ──────────────────────────────────────────────────────────────────
app.post("/api/send-dm", async (req, res) => {
  const { userId, recipientId, message, campaignId } = req.body;
  try {
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error:"User not found" });
    const r = await axios.post(
      `https://graph.instagram.com/v21.0/${user.ig_user_id}/messages`,
      { recipient:{ id:recipientId }, message:{ text:message } },
      { headers:{ Authorization:`Bearer ${user.access_token}` } }
    );
    await pool.query("INSERT INTO dm_log (ig_user_id,recipient_id,message,status,campaign_id) VALUES ($1,$2,$3,$4,$5)",
      [userId, recipientId, message, "sent", campaignId||null]);
    if (campaignId) {
      await pool.query("UPDATE campaigns SET dm_count=dm_count+1 WHERE id=$1", [campaignId]);
    }
    res.json({ success:true, messageId:r.data.message_id });
  } catch(err) {
    await pool.query("INSERT INTO dm_log (ig_user_id,recipient_id,message,status) VALUES ($1,$2,$3,$4)",
      [userId, recipientId, message, "failed"]).catch(()=>{});
    res.status(500).json({ error:err.response?.data||err.message });
  }
});

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────
app.get("/api/conversations/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error:"User not found" });
    const r = await axios.get(`https://graph.instagram.com/v21.0/${user.ig_user_id}/conversations?fields=id,participants,messages{id,message,from,created_time},updated_time&access_token=${user.access_token}`);
    res.json(r.data);
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ─── DM LOG ───────────────────────────────────────────────────────────────────
app.get("/api/dm-log/:userId", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM dm_log WHERE ig_user_id=$1 ORDER BY sent_at DESC LIMIT 100", [req.params.userId]);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ─── LINK CLICK TRACKING & REDIRECT ──────────────────────────────────────────
// Short link: /r/:campaignId?u=<target>&r=<recipientId>
app.get("/r/:campaignId", async (req, res) => {
  const { u, r } = req.query;
  const campaignId = req.params.campaignId;
  const target = u ? decodeURIComponent(u) : null;

  if (!target) return res.status(400).send("Missing target URL");

  try {
    const camp = await pool.query("SELECT ig_user_id FROM campaigns WHERE id=$1", [campaignId]);
    const igUserId = camp.rows[0]?.ig_user_id || null;

    await pool.query(
      "INSERT INTO link_clicks (campaign_id, ig_user_id, recipient_id, target_url) VALUES ($1,$2,$3,$4)",
      [campaignId, igUserId, r||null, target]
    );
    console.log(`🔗 Link click: campaign=${campaignId} recipient=${r} → ${target}`);
  } catch(err) {
    console.error("Click tracking error:", err.message);
  }

  // Ensure URL has protocol
  let finalUrl = target;
  if (!/^https?:\/\//i.test(finalUrl)) finalUrl = "https://" + finalUrl;

  res.redirect(302, finalUrl);
});

// ─── OVERALL ANALYTICS (Dashboard) ───────────────────────────────────────────
app.get("/api/analytics/:userId", async (req, res) => {
  const { userId } = req.params;
  const { range } = req.query; // '7d' | '30d' | '90d'
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;

  try {
    // Overall totals
    const totals = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM dm_log WHERE ig_user_id=$1 AND status='sent') as dms_sent,
        (SELECT COUNT(*) FROM dm_log WHERE ig_user_id=$1 AND status='failed') as dms_failed,
        (SELECT COUNT(*) FROM campaign_logs WHERE ig_user_id=$1) as total_triggers,
        (SELECT COUNT(*) FROM campaign_logs WHERE ig_user_id=$1 AND comment_liked=true) as comments_liked,
        (SELECT COUNT(*) FROM campaign_logs WHERE ig_user_id=$1 AND comment_replied=true) as auto_replies,
        (SELECT COUNT(*) FROM link_clicks WHERE ig_user_id=$1) as link_clicks,
        (SELECT COUNT(*) FROM campaigns WHERE ig_user_id=$1 AND status='active') as active_campaigns,
        (SELECT COUNT(DISTINCT commenter_id) FROM campaign_logs WHERE ig_user_id=$1) as unique_users_reached
    `, [userId]);

    // Daily DM activity (last N days)
    const dailyDms = await pool.query(`
      SELECT DATE(sent_at) as date, COUNT(*) as count
      FROM dm_log
      WHERE ig_user_id=$1 AND status='sent' AND sent_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(sent_at)
      ORDER BY date ASC
    `, [userId]);

    // Daily link clicks
    const dailyClicks = await pool.query(`
      SELECT DATE(clicked_at) as date, COUNT(*) as count
      FROM link_clicks
      WHERE ig_user_id=$1 AND clicked_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(clicked_at)
      ORDER BY date ASC
    `, [userId]);

    // Campaign-wise breakdown
    const campaignBreakdown = await pool.query(`
      SELECT 
        c.id, c.name, c.status,
        COUNT(cl.id) as triggers,
        COUNT(CASE WHEN cl.dm_sent THEN 1 END) as dms_sent,
        COUNT(CASE WHEN cl.comment_liked THEN 1 END) as likes,
        COUNT(CASE WHEN cl.comment_replied THEN 1 END) as replies,
        (SELECT COUNT(*) FROM link_clicks lc WHERE lc.campaign_id=c.id) as clicks
      FROM campaigns c
      LEFT JOIN campaign_logs cl ON cl.campaign_id = c.id
      WHERE c.ig_user_id=$1
      GROUP BY c.id, c.name, c.status
      ORDER BY dms_sent DESC
      LIMIT 10
    `, [userId]);

    // Top keywords triggered
    const topKeywords = await pool.query(`
      SELECT keyword_matched, COUNT(*) as hits
      FROM campaign_logs
      WHERE ig_user_id=$1 AND keyword_matched IS NOT NULL
      GROUP BY keyword_matched
      ORDER BY hits DESC
      LIMIT 6
    `, [userId]);

    // Recent activity feed (mixed: DMs + clicks)
    const recentActivity = await pool.query(`
      (SELECT 'dm' as type, commenter_username as username, keyword_matched as detail, created_at
       FROM campaign_logs WHERE ig_user_id=$1 AND dm_sent=true ORDER BY created_at DESC LIMIT 10)
      UNION ALL
      (SELECT 'click' as type, NULL as username, target_url as detail, clicked_at as created_at
       FROM link_clicks WHERE ig_user_id=$1 ORDER BY clicked_at DESC LIMIT 10)
      ORDER BY created_at DESC LIMIT 15
    `, [userId]);

    const t = totals.rows[0];
    const dmsSent     = parseInt(t.dms_sent)     || 0;
    const linkClicks  = parseInt(t.link_clicks)  || 0;
    const triggers    = parseInt(t.total_triggers) || 0;

    res.json({
      totals: {
        dmsSent,
        dmsFailed:       parseInt(t.dms_failed) || 0,
        totalTriggers:   triggers,
        commentsLiked:   parseInt(t.comments_liked) || 0,
        autoReplies:     parseInt(t.auto_replies) || 0,
        linkClicks,
        activeCampaigns: parseInt(t.active_campaigns) || 0,
        uniqueUsersReached: parseInt(t.unique_users_reached) || 0,
        clickThroughRate: dmsSent > 0 ? +((linkClicks/dmsSent)*100).toFixed(1) : 0,
        successRate:      triggers > 0 ? +((dmsSent/triggers)*100).toFixed(1) : 0,
      },
      dailyDms:    dailyDms.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      dailyClicks: dailyClicks.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
      campaigns: campaignBreakdown.rows.map(r => ({
        id: r.id, name: r.name, status: r.status,
        triggers: parseInt(r.triggers)||0, dmsSent: parseInt(r.dms_sent)||0,
        likes: parseInt(r.likes)||0, replies: parseInt(r.replies)||0, clicks: parseInt(r.clicks)||0,
      })),
      topKeywords: topKeywords.rows.map(r => ({ keyword: r.keyword_matched, hits: parseInt(r.hits) })),
      recentActivity: recentActivity.rows,
    });
  } catch(err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK VERIFY ───────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode":mode, "hub.verify_token":token, "hub.challenge":challenge } = req.query;
  if (mode==="subscribe" && token===WEBHOOK_VERIFY) {
    console.log("✅ Webhook verified!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── WEBHOOK EVENTS ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const sig      = req.headers["x-hub-signature-256"];
  const body     = JSON.stringify(req.body);
  const expected = "sha256="+crypto.createHmac("sha256",IG_APP_SECRET).update(body).digest("hex");
  if (sig !== expected) return res.sendStatus(403);

  const event = req.body;
  await pool.query("INSERT INTO webhook_events (event_type,payload) VALUES ($1,$2)", [event.object||"unknown", JSON.stringify(event)]).catch(()=>{});

  if (event.object === "instagram") {
    for (const entry of (event.entry||[])) {
      for (const change of (entry.changes||[])) {
        if (change.field === "comments") {
          await processComment(change.value, entry.id);
        }
      }
      for (const msg of (entry.messaging||[])) {
        if (msg.message && !msg.message.is_echo) {
          await processIncomingDM(msg, entry.id);
        }
      }
    }
  }
  res.sendStatus(200);
});

// ─── COMMENT PROCESSOR ────────────────────────────────────────────────────────
async function processComment(comment, pageId) {
  console.log(`💬 Comment from @${comment.from?.username}: "${comment.text}" on media ${comment.media?.id}`);

  try {
    // Find user
    const users = await pool.query("SELECT ig_user_id FROM users WHERE ig_user_id=$1", [pageId]);
    if (!users.rows.length) return;
    const userId = users.rows[0].ig_user_id;
    const user   = await getUser(userId);
    if (!user) return;

    const commentText = (comment.text||"").toLowerCase().trim();
    const mediaId     = comment.media?.id;

    // Find matching active campaigns for this post or all posts
    const campaigns = await pool.query(`
      SELECT * FROM campaigns 
      WHERE ig_user_id=$1 
      AND status='active'
      AND (media_id=$2 OR media_id IS NULL)
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (max_dms=0 OR dm_count < max_dms)
    `, [userId, mediaId]);

    for (const campaign of campaigns.rows) {
      const keywords = campaign.keywords || [];
      let matchedKeyword = null;

      // Check keywords
      if (keywords.length === 0) {
        matchedKeyword = "any"; // No keyword = trigger on all comments
      } else {
        for (const kw of keywords) {
          if (commentText.includes(kw.toLowerCase())) {
            matchedKeyword = kw;
            break;
          }
        }
      }

      if (!matchedKeyword) continue;

      console.log(`🎯 Campaign "${campaign.name}" matched keyword "${matchedKeyword}"`);

      // Check if already DMed this user for this campaign
      const alreadyDMed = await pool.query(
        "SELECT id FROM campaign_logs WHERE campaign_id=$1 AND commenter_id=$2 AND dm_sent=true",
        [campaign.id, comment.from?.id]
      );
      if (alreadyDMed.rows.length > 0) {
        console.log(`⏭️ Already DMed ${comment.from?.username} for this campaign`);
        continue;
      }

      // Generate trackable link if link_url is set
      let trackableLink = "";
      if (campaign.link_url) {
        trackableLink = `${FRONTEND_URL}/r/${campaign.id}?u=${encodeURIComponent(campaign.link_url)}&r=${encodeURIComponent(comment.from?.id||"")}`;
      }

      // Personalize message
      let personalizedMsg = (campaign.dm_message||"")
        .replace("{name}", comment.from?.username||"there")
        .replace("{username}", "@"+(comment.from?.username||"user"))
        .replace("{keyword}", matchedKeyword)
        .replace("{link}", trackableLink||"");

      // Auto-append link if set and not already referenced via {link}
      if (campaign.link_url && !(campaign.dm_message||"").includes("{link}")) {
        const label = campaign.link_label || "👉";
        personalizedMsg = `${personalizedMsg}\n\n${label} ${trackableLink}`;
      }

      let dmSent           = false;
      let commentLiked     = false;
      let commentReplied   = false;

      // 1. Send DM
      try {
        await axios.post(
          `https://graph.instagram.com/v21.0/${user.ig_user_id}/messages`,
          { recipient:{ id:comment.from?.id }, message:{ text:personalizedMsg } },
          { headers:{ Authorization:`Bearer ${user.access_token}` } }
        );
        dmSent = true;
        console.log(`✅ Auto-DM sent to @${comment.from?.username}`);
        await pool.query("UPDATE campaigns SET dm_count=dm_count+1, trigger_count=trigger_count+1 WHERE id=$1", [campaign.id]);
      } catch(e) {
        console.error(`❌ DM failed:`, e.response?.data?.error?.message||e.message);
      }

      // 2. Like comment (if enabled)
      if (campaign.like_comment && comment.id) {
        try {
          await axios.post(
            `https://graph.instagram.com/v21.0/${comment.id}/likes`,
            {},
            { params:{ access_token:user.access_token } }
          );
          commentLiked = true;
          console.log(`❤️ Comment liked`);
        } catch(e) { console.error("Like failed:", e.message); }
      }

      // 3. Reply to comment (if enabled)
      if (campaign.reply_comment && campaign.comment_reply && comment.id) {
        try {
          await axios.post(
            `https://graph.instagram.com/v21.0/${comment.id}/replies`,
            { message: campaign.comment_reply },
            { params:{ access_token:user.access_token } }
          );
          commentReplied = true;
          console.log(`💬 Comment reply sent`);
        } catch(e) { console.error("Reply failed:", e.message); }
      }

      // Log it
      await pool.query(`
        INSERT INTO campaign_logs (campaign_id,ig_user_id,commenter_id,commenter_username,comment_text,keyword_matched,dm_sent,comment_liked,comment_replied)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [campaign.id, userId, comment.from?.id, comment.from?.username, comment.text, matchedKeyword, dmSent, commentLiked, commentReplied]);
    }
  } catch(err) {
    console.error("❌ processComment error:", err.message);
  }
}

// ─── INCOMING DM PROCESSOR ────────────────────────────────────────────────────
async function processIncomingDM(msg, pageId) {
  const user = await getUser(pageId).catch(()=>null);
  if (!user) return;
  const welcome = `Hey! 👋 Thanks for reaching out to @${user.username}! We'll get back to you shortly. Check our store: tap.bio/store 🛍️`;
  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/${user.ig_user_id}/messages`,
      { recipient:{ id:msg.sender.id }, message:{ text:welcome } },
      { headers:{ Authorization:`Bearer ${user.access_token}` } }
    );
  } catch(e) { console.error("Auto-reply failed:", e.response?.data); }
}

// ─── COMMENTS ON POST ─────────────────────────────────────────────────────────
app.get("/api/comments/:userId/:mediaId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error:"User not found" });
    const r = await axios.get(`https://graph.instagram.com/v21.0/${req.params.mediaId}/comments?fields=id,text,username,timestamp,from&access_token=${user.access_token}`);
    res.json(r.data);
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
app.post("/api/refresh-token/:userId", async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    if (!user) return res.status(404).json({ error:"Not found" });
    const r = await axios.get(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${user.access_token}`);
    await pool.query("UPDATE users SET access_token=$1,updated_at=NOW() WHERE ig_user_id=$2", [r.data.access_token, req.params.userId]);
    res.json({ success:true, expiresIn:r.data.expires_in });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 InstantDM Backend v3.0 on port ${PORT}`);
  console.log(`📱 IG App ID: ${IG_APP_ID}`);
  console.log(`🔗 OAuth: ${REDIRECT_URI}`);
});
