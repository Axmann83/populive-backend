/**
 * ============================================================
 * POPULIVE — SERVER API
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { createDb } = require('./populive-db-adapter');
const Redis = require('ioredis');

const { setupWebSocket } = require('./populive-websocket-rooms');
const { handleCheckin } = require('./populive-checkin-logic');
const {
  sendInteraction, trackProfileView, respondToRosa, attemptGuess, respondToSuperlike, getReceivedRoses,
} = require('./populive-interactions-logic');
const { initiateRosaPurchase, initiatePurchase, handleStripeWebhook } = require('./populive-payments-logic');
const { sendMessage, getMessages, setChatKeepPreference } = require('./populive-chat-logic');
const { startScheduler } = require('./populive-scheduler');
const {
  createProfile, setProfilePhoto, completeOnboarding, requireCompletedOnboarding, getPublicProfile,
} = require('./populive-profile-onboarding');
const { generateVenueReport } = require('./populive-venue-insights');
const { joinSquad } = require('./populive-connector-engine');
const { getLocalRanking, getGlobalRanking, getUserRankingSummary } = require('./populive-ranking-queries');
const { requestOtp, verifyOtp, verifyToken } = require('./populive-auth-logic');

const app = express();
app.use(cors());

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await handleStripeWebhook(req.body, req.headers['stripe-signature'], { db, redis, io });
    res.sendStatus(result.statusCode);
  } catch (err) {
    console.error('[stripe webhook] errore:', err);
    res.sendStatus(500);
  }
});

app.use(express.json());

const httpServer = http.createServer(app);

const db = createDb(process.env.DATABASE_URL);
const redis = new Redis(process.env.REDIS_URL);
const io = setupWebSocket(httpServer, { redis, db });

const deps = { db, redis, io };

function ah(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function requireOnboarded(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, reason: 'missing_token' });

  const { valid, userId } = verifyToken(token);
  if (!valid) return res.status(401).json({ success: false, reason: 'invalid_or_expired_token' });

  const check = await requireCompletedOnboarding(userId, { db });
  if (!check.allowed) return res.status(403).json({ success: false, reason: check.reason });

  req.userId = userId;
  next();
}

async function requireAuthOnly(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, reason: 'missing_token' });

  const { valid, userId } = verifyToken(token);
  if (!valid) return res.status(401).json({ success: false, reason: 'invalid_or_expired_token' });

  req.userId = userId;
  next();
}

app.post('/api/auth/request-otp', ah(async (req, res) => {
  const { phoneNumber } = req.body;
  const result = await requestOtp({ phoneNumber }, { db });
  res.json(result);
}));

app.post('/api/auth/verify-otp', ah(async (req, res) => {
  const { phoneNumber, code } = req.body;
  const result = await verifyOtp({ phoneNumber, code }, { db });
  res.json(result);
}));

app.get('/api/auth/me', requireAuthOnly, ah(async (req, res) => {
  const user = await db.query(`SELECT id, onboarding_completed FROM users WHERE id = $1`, [req.userId]);
  if (!user) return res.json({ success: false, reason: 'user_not_found' });
  res.json({ success: true, userId: user.id, onboardingCompleted: user.onboarding_completed });
}));

app.post('/api/profile', requireAuthOnly, ah(async (req, res) => {
  const { displayName, bio, hashtagNames } = req.body;
  const result = await createProfile({ userId: req.userId, displayName, bio, hashtagNames }, { db });
  res.json(result);
}));

app.post('/api/profile/:userId/photo', requireAuthOnly, ah(async (req, res) => {
  const result = await setProfilePhoto({ userId: req.userId, photoUrl: req.body.photoUrl }, { db });
  res.json(result);
}));

app.post('/api/profile/:userId/onboarding', requireAuthOnly, ah(async (req, res) => {
  const result = await completeOnboarding({ userId: req.userId, consentChoices: req.body }, { db });
  res.json(result);
}));

app.post('/api/checkin', requireOnboarded, ah(async (req, res) => {
  const { venueId } = req.body;
  const result = await handleCheckin({ userId: req.userId, venueId }, deps);
  res.json(result);
}));

app.get('/api/users/:userId/public-profile', requireOnboarded, ah(async (req, res) => {
  const { arenaSessionId } = req.query;
  const result = await getPublicProfile({ userId: req.params.userId, arenaSessionId }, { db });
  res.json(result);
}));

app.post('/api/interactions/send', requireOnboarded, ah(async (req, res) => {
  const { receiverId, arenaSessionId, type } = req.body;
  const result = await sendInteraction({ senderId: req.userId, receiverId, arenaSessionId, type }, deps);
  res.json(result);
}));

app.post('/api/profile-views', requireOnboarded, ah(async (req, res) => {
  const { viewedUserId, arenaSessionId } = req.body;
  const result = await trackProfileView({ viewerId: req.userId, viewedUserId, arenaSessionId }, deps);
  res.json(result);
}));

app.get('/api/users/:userId/roses', requireOnboarded, ah(async (req, res) => {
  const roses = await getReceivedRoses({ userId: req.userId }, deps);
  res.json({ success: true, roses });
}));

app.post('/api/roses/send', requireOnboarded, ah(async (req, res) => {
  const { receiverId, arenaSessionId, drinkProductId, tier } = req.body;
  const result = await initiateRosaPurchase({
    senderId: req.userId, receiverId, arenaSessionId, drinkProductId, tier,
  }, deps);
  res.json(result);
}));

app.get('/api/products', ah(async (req, res) => {
  const products = await db.queryAll(`
    SELECT id, sku, display_name, description, price_cents, product_type
    FROM iap_products WHERE is_active = true ORDER BY price_cents ASC
  `);
  res.json({ success: true, products });
}));

app.post('/api/purchases/initiate', requireOnboarded, ah(async (req, res) => {
  const { productId, arenaSessionId } = req.body;
  const result = await initiatePurchase({ userId: req.userId, productId, arenaSessionId }, { db });
  res.json(result);
}));

app.post('/api/roses/:rosaId/respond', requireOnboarded, ah(async (req, res) => {
  const { action } = req.body;
  const result = await respondToRosa({
    rosaId: req.params.rosaId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
}));

app.post('/api/roses/:rosaId/guess', requireOnboarded, ah(async (req, res) => {
  const { guessedUserId } = req.body;
  const result = await attemptGuess({
    rosaId: req.params.rosaId, receiverId: req.userId, guessedUserId,
  }, deps);
  res.json(result);
}));

app.get('/api/venues/:venueId/report', ah(async (req, res) => {
  const { fromDate, toDate } = req.query;
  const result = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
  res.json(result);
}));

app.post('/api/table/join', requireOnboarded, ah(async (req, res) => {
  const { tableQrCode, arenaSessionId, wantsToBeConnector } = req.body;
  const result = await joinSquad({
    connectorId: undefined,
    memberId: req.userId,
    arenaSessionId,
    tableQrCode,
    wantsToBeConnector,
  }, deps);
  res.json(result);
}));

app.get('/api/arenas/:arenaSessionId/ranking', ah(async (req, res) => {
  const ranking = await getLocalRanking({ arenaSessionId: req.params.arenaSessionId }, { db });
  res.json({ success: true, ranking });
}));

app.get('/api/ranking/global', ah(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const ranking = await getGlobalRanking({ limit }, { db });
  res.json({ success: true, ranking });
}));

app.get('/api/users/:userId/ranking-summary', ah(async (req, res) => {
  const { arenaSessionId } = req.query;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const { valid, userId: viewerId } = token ? verifyToken(token) : { valid: false };
  const summary = await getUserRankingSummary({ userId: req.params.userId, arenaSessionId, viewerId: valid ? viewerId : null }, { db });
  res.json({ success: true, summary });
}));

app.get('/api/venues/:venueId/drinks', ah(async (req, res) => {
  const drinks = await db.queryAll(`
    SELECT dp.id, dp.name, dp.base_price_cents, dp.sponsor_discount_cents, bs.name AS sponsor_name
    FROM venue_drink_catalog vdc
    JOIN drink_products dp ON dp.id = vdc.drink_product_id
    LEFT JOIN brand_sponsors bs ON bs.id = dp.brand_sponsor_id
    WHERE vdc.venue_id = $1 AND dp.is_active = true
    ORDER BY dp.base_price_cents ASC
  `, [req.params.venueId]);
  res.json({ success: true, drinks });
}));

app.post('/api/roses/:rosaId/redeem', ah(async (req, res) => {
  const { redeemCode } = req.body;

  const rosa = await db.query(`
    SELECT * FROM roses WHERE id = $1 AND redeem_code = $2 AND status = 'accepted'
  `, [req.params.rosaId, redeemCode]);

  if (!rosa) {
    return res.json({ success: false, reason: 'invalid_code_or_already_redeemed' });
  }
  if (rosa.redeem_expires_at && new Date(rosa.redeem_expires_at) < new Date()) {
    return res.json({ success: false, reason: 'code_expired' });
  }

  await db.query(`UPDATE roses SET status = 'redeemed' WHERE id = $1`, [req.params.rosaId]);
  res.json({ success: true });
}));

app.get('/api/arenas/:arenaSessionId/guess-candidates', ah(async (req, res) => {
  const candidates = await db.queryAll(`
    SELECT DISTINCT u.id AS user_id, u.display_name, u.avatar_emoji, u.photo_url
    FROM checkins c
    JOIN users u ON u.id = c.user_id
    WHERE c.arena_session_id = $1
  `, [req.params.arenaSessionId]);
  res.json({ success: true, candidates });
}));

app.post('/api/interactions/:interactionId/respond', requireOnboarded, ah(async (req, res) => {
  const { action } = req.body;
  const result = await respondToSuperlike({
    interactionId: req.params.interactionId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
}));

app.post('/api/chat/:conversationId/messages', requireOnboarded, ah(async (req, res) => {
  const { body } = req.body;
  const result = await sendMessage({
    conversationId: req.params.conversationId, senderId: req.userId, body,
  }, deps);
  res.json(result);
}));

app.get('/api/chat/:conversationId/messages', requireOnboarded, ah(async (req, res) => {
  const result = await getMessages({
    conversationId: req.params.conversationId, requesterId: req.userId,
  }, deps);
  res.json(result);
}));

app.post('/api/chat/:conversationId/keep-preference', requireOnboarded, ah(async (req, res) => {
  const { wantsKeep } = req.body;
  const result = await setChatKeepPreference({
    conversationId: req.params.conversationId, userId: req.userId, wantsKeep,
  }, deps);
  res.json(result);
}));

app.get('/api/profile/:userId/settings', requireOnboarded, ah(async (req, res) => {
  const user = await db.query(`
    SELECT show_ranking_on_profile, sponsored_missions_enabled,
           appears_in_historical_search, receive_roses_enabled, contact_filter
    FROM users WHERE id = $1
  `, [req.userId]);
  if (!user) return res.json({ success: false, reason: 'user_not_found' });

  res.json({
    success: true,
    settings: {
      showRankingOnProfile: user.show_ranking_on_profile,
      sponsoredMissionsEnabled: user.sponsored_missions_enabled,
      appearsInHistoricalSearch: user.appears_in_historical_search,
      receiveRosesEnabled: user.receive_roses_enabled,
      contactFilter: user.contact_filter,
    },
  });
}));

app.post('/api/profile/:userId/settings', requireOnboarded, ah(async (req, res) => {
  const {
    showRankingOnProfile, sponsoredMissionsEnabled,
    appearsInHistoricalSearch, receiveRosesEnabled, contactFilter,
  } = req.body;

  await db.query(`
    UPDATE users SET
      show_ranking_on_profile = $1,
      sponsored_missions_enabled = $2,
      appears_in_historical_search = $3,
      receive_roses_enabled = $4,
      contact_filter = $5
    WHERE id = $6
  `, [
    showRankingOnProfile, sponsoredMissionsEnabled,
    appearsInHistoricalSearch, receiveRosesEnabled, contactFilter,
    req.userId,
  ]);

  res.json({ success: true });
}));

app.use((err, req, res, next) => {
  console.error('[errore non gestito]', err);
  res.status(500).json({ success: false, reason: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`PopuLive API in ascolto sulla porta ${PORT}`);
  startScheduler({ db, redis, io });
  console.log('Motore a orari avviato.');
});
