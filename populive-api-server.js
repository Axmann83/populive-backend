/**
 * ============================================================
 * POPULIVE — SERVER API
 * ============================================================
 * Questo è il "collante": prende tutta la logica che abbiamo già
 * scritto (funzioni pure, senza sapere nulla del web) e la espone
 * come indirizzi HTTP veri che il frontend può chiamare con una
 * richiesta fetch(). Ogni endpoint fa tre cose, sempre nello stesso
 * ordine: legge cosa manda il frontend → chiama la funzione di
 * logica già scritta → risponde con il risultato.
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { createDb } = require('./populive-db-adapter');
const Redis = require('ioredis');

const { setupWebSocket } = require('./populive-websocket-rooms');
const { handleCheckin, createVirtualVenue, getAllVenuesForMap } = require('./populive-checkin-logic');
const {
  sendInteraction, trackProfileView, respondToPulse, attemptGuess, respondToSuperlike, getReceivedPulses, getPulseBalance,
} = require('./populive-interactions-logic');
const { initiatePulsePurchase, initiatePurchase, initiateVenuePulseCreditsPurchase, handleStripeWebhook } = require('./populive-payments-logic');
const { sendMessage, getMessages, setChatKeepPreference } = require('./populive-chat-logic');
const { startScheduler } = require('./populive-scheduler');
const {
  createProfile, setProfilePhoto, updateProfileDetails, completeOnboarding, requireCompletedOnboarding, getPublicProfile,
} = require('./populive-profile-onboarding');
const { generateVenueReport, getPopularVenuesNow, getVenueHistoricalCheckins, getCommissionsReport, getVenueFullSettings } = require('./populive-venue-insights');
const { joinSquad, awardTableSpendingBonusByVenue, updateVenueSpendingConfig } = require('./populive-connector-engine');
const { getLocalRanking, getGlobalRanking, getUserRankingSummary, getWelcomeBackSummary, searchUsersByHashtag } = require('./populive-ranking-queries');
const { createMission, getAllMissions, getMissionsNearUser, completeMission, getMissionPreview } = require('./populive-missions-logic');
const { requestOtp, verifyOtp, verifyToken } = require('./populive-auth-logic');

const app = express();
app.use(cors()); // permette al frontend (su un altro indirizzo) di chiamare questo backend

// ------------------------------------------------------------
// WEBHOOK STRIPE — deve stare QUI, PRIMA di express.json() qui
// sotto. Stripe firma il corpo "grezzo" della richiesta per
// dimostrare che il messaggio arriva davvero da loro — se lo
// lasciassimo passare prima dal parser JSON generale, quel corpo
// verrebbe già trasformato in un oggetto e la firma non
// combacerebbe più con niente. Ogni altro endpoint dell'app
// continua invece a usare JSON normalmente, come sempre.
// ------------------------------------------------------------
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

// Connessioni ai due database, condivise da tutte le richieste
// (si aprono una volta all'avvio, non a ogni singola chiamata).
const db = createDb(process.env.DATABASE_URL);
const redis = new Redis(process.env.REDIS_URL);
const io = setupWebSocket(httpServer, { redis, db });

// Piccola utility ripetuta in ogni endpoint: le tre dipendenze che
// tutte le funzioni di logica si aspettano di ricevere.
const deps = { db, redis, io };

/**
 * "Avvolgitore" per ogni endpoint — invece di scrivere un try/catch
 * dentro OGNI singola funzione (facile da dimenticare, e infatti
 * l'abbiamo dimenticato più volte), avvolgiamo qui ogni handler UNA
 * volta sola: se la funzione dentro lancia un errore per qualunque
 * motivo, viene automaticamente intercettato e passato al gestore
 * di errori globale in fondo al file — mai più un crash che il
 * frontend vede come "errore di rete" senza sapere cosa sia successo
 * davvero.
 */
function ah(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}


// ------------------------------------------------------------
// MIDDLEWARE — verifica che l'utente esista e abbia completato
// l'onboarding, PRIMA di eseguire qualunque azione "vera"
// dell'app. Non tocca handleCheckin/sendPulse/ecc: si mette davanti.
// ------------------------------------------------------------
async function requireOnboarded(req, res, next) {
  // Ora l'identità arriva da un token firmato (JWT), mai più da un
  // header che chiunque poteva scrivere a mano per "diventare" un
  // altro utente — chiuso il buco di sicurezza che avevamo dall'inizio.
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

/**
 * Versione "leggera" dello stesso controllo, usata SOLO nel breve
 * momento tra il login e il completamento dell'onboarding — qui
 * basta un token valido, non serve ancora aver finito la
 * registrazione (altrimenti nessun nuovo utente potrebbe mai
 * completarla).
 */
async function requireAuthOnly(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, reason: 'missing_token' });

  const { valid, userId } = verifyToken(token);
  if (!valid) return res.status(401).json({ success: false, reason: 'invalid_or_expired_token' });

  req.userId = userId;
  next();
}

/**
 * Controllo d'accesso alla DASHBOARD — richiede prima un token
 * valido (stesso identico login di sempre, nessun account separato
 * da gestire), poi verifica che quella persona sia davvero uno dei
 * 5 ARCHITETTI (i veri co-fondatori) — MAI i Founder (fino a 100
 * persone col braccialetto fisico, privilegi automatici in-app ma
 * nessun accesso alla dashboard, tabella completamente diversa:
 * founder_bracelets). Due ruoli, due tabelle, da non confondere.
 */
async function requireArchitect(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, reason: 'missing_token' });

  const { valid, userId } = verifyToken(token);
  if (!valid) return res.status(401).json({ success: false, reason: 'invalid_or_expired_token' });

  const architect = await db.query(`SELECT user_id FROM architects WHERE user_id = $1`, [userId]);
  if (!architect) return res.status(403).json({ success: false, reason: 'not_an_architect' });

  req.userId = userId;
  next();
}


// ------------------------------------------------------------
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

// Usato quando l'app si riapre con un token già salvato — dice
// se quel token è ancora valido e se l'onboarding è completo,
// senza richiedere che l'onboarding sia già fatto (a differenza
// di requireOnboarded).
app.get('/api/auth/me', requireAuthOnly, ah(async (req, res) => {
  const user = await db.query(`SELECT id, onboarding_completed FROM users WHERE id = $1`, [req.userId]);
  if (!user) return res.json({ success: false, reason: 'user_not_found' });
  res.json({ success: true, userId: user.id, onboardingCompleted: user.onboarding_completed });
}));

app.get('/api/auth/is-architect', requireAuthOnly, ah(async (req, res) => {
  const architect = await db.query(`SELECT user_id FROM architects WHERE user_id = $1`, [req.userId]);
  res.json({ success: true, isArchitect: !!architect });
}));


// ------------------------------------------------------------
// PROFILO / ONBOARDING — richiede un token valido (sei loggato),
// ma NON ancora onboarding_completed (è proprio quello che stiamo
// per completare qui).
// ------------------------------------------------------------
app.post('/api/profile', requireAuthOnly, ah(async (req, res) => {
  const { displayName, bio, hashtagNames, genderForStats } = req.body;
  const result = await createProfile({ userId: req.userId, displayName, bio, hashtagNames, genderForStats }, { db });
  res.json(result);
}));

app.post('/api/profile/:userId/photo', requireAuthOnly, ah(async (req, res) => {
  const result = await setProfilePhoto({ userId: req.userId, photoUrl: req.body.photoUrl }, { db });
  res.json(result);
}));

app.post('/api/profile/:userId/edit', requireOnboarded, ah(async (req, res) => {
  const { bio, hashtagNames } = req.body;
  const result = await updateProfileDetails({ userId: req.userId, bio, hashtagNames }, { db });
  res.json(result);
}));

app.post('/api/profile/:userId/location', requireAuthOnly, ah(async (req, res) => {
  const { latitude, longitude } = req.body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.json({ success: false, reason: 'invalid_coordinates' });
  }

  // Controllo VERO lato server, non solo lato frontend — salviamo
  // la posizione SOLO se il consenso alle missioni sponsorizzate è
  // davvero attivo in questo momento, a prescindere da cosa mandi
  // il client. Se qualcuno lo disattiva, la posizione smette di
  // aggiornarsi anche se per qualche motivo arrivasse comunque una
  // richiesta dal telefono.
  const user = await db.query(`SELECT sponsored_missions_enabled FROM users WHERE id = $1`, [req.userId]);
  if (!user?.sponsored_missions_enabled) {
    return res.json({ success: false, reason: 'consent_not_active' });
  }

  await db.query(`
    UPDATE users SET last_latitude = $1, last_longitude = $2, location_updated_at = now()
    WHERE id = $3
  `, [latitude, longitude, req.userId]);

  res.json({ success: true });
}));

app.post('/api/profile/:userId/onboarding', requireAuthOnly, ah(async (req, res) => {
  const result = await completeOnboarding({ userId: req.userId, consentChoices: req.body }, { db });
  res.json(result);
}));


// ------------------------------------------------------------
// CHECK-IN
// ------------------------------------------------------------
app.post('/api/checkin', requireOnboarded, ah(async (req, res) => {
  const { venueId } = req.body;
  const result = await handleCheckin({ userId: req.userId, venueId }, deps);
  res.json(result);
}));

app.get('/api/dashboard/missions', requireArchitect, ah(async (req, res) => {
  const missions = await getAllMissions({}, { db });
  res.json({ success: true, missions });
}));

app.post('/api/dashboard/missions', requireArchitect, ah(async (req, res) => {
  const { sponsorName, venueId, claimText, bonusPoints, radiusMeters, hashtagFilter, dateFrom, dateTo } = req.body;
  const result = await createMission({ sponsorName, venueId, claimText, bonusPoints, radiusMeters, hashtagFilter, dateFrom, dateTo }, { db });
  res.json(result);
}));

app.get('/api/missions/near-me', requireOnboarded, ah(async (req, res) => {
  const result = await getMissionsNearUser({ userId: req.userId }, { db });
  res.json(result);
}));

app.get('/api/missions/:missionId', requireOnboarded, ah(async (req, res) => {
  const result = await getMissionPreview({ missionId: req.params.missionId }, { db });
  res.json(result);
}));

app.post('/api/missions/:missionId/complete', requireOnboarded, ah(async (req, res) => {
  const result = await completeMission({ missionId: req.params.missionId, userId: req.userId }, deps);
  res.json(result);
}));


// ------------------------------------------------------------
// PROFILO PUBBLICO — quello mostrato a schermo intero quando si
// tocca qualcuno nel radar (foto, nome, hashtag, badge di sessione).
// ------------------------------------------------------------
app.get('/api/users/:userId/public-profile', requireOnboarded, ah(async (req, res) => {
  const { arenaSessionId } = req.query;
  const result = await getPublicProfile({ userId: req.params.userId, arenaSessionId }, { db });
  res.json(result);
}));


// ------------------------------------------------------------
// INTERAZIONI (Like / Superlike / visite profilo)
// ------------------------------------------------------------
app.post('/api/interactions/send', requireOnboarded, ah(async (req, res) => {
  const { receiverId, arenaSessionId, type, viaHistoricalBoard } = req.body; // type: 'like' | 'superlike'
  const result = await sendInteraction({ senderId: req.userId, receiverId, arenaSessionId, type, viaHistoricalBoard }, deps);
  res.json(result);
}));

app.post('/api/profile-views', requireOnboarded, ah(async (req, res) => {
  const { viewedUserId, arenaSessionId, viaHistoricalBoard } = req.body;
  const result = await trackProfileView({ viewerId: req.userId, viewedUserId, arenaSessionId, viaHistoricalBoard }, deps);
  res.json(result);
}));


// ------------------------------------------------------------
// PULSE
// ------------------------------------------------------------
app.get('/api/users/:userId/pulse-balance', requireOnboarded, ah(async (req, res) => {
  const result = await getPulseBalance({ userId: req.userId }, { db });
  res.json(result);
}));

app.get('/api/users/:userId/pulses', requireOnboarded, ah(async (req, res) => {
  // Le Pulse ricevute sono dati privati (mittente, drink scelto) —
  // SOLO il proprietario può vederle, mai un ID scritto a mano
  // nell'indirizzo. Usiamo sempre req.userId (dal token verificato),
  // ignorando qualunque cosa sia scritta nell'URL.
  const pulses = await getReceivedPulses({ userId: req.userId }, deps);
  res.json({ success: true, pulses });
}));

app.post('/api/pulses/send', requireOnboarded, ah(async (req, res) => {
  const { receiverId, arenaSessionId, drinkProductId, tier } = req.body;
  const result = await initiatePulsePurchase({
    senderId: req.userId, receiverId, arenaSessionId, drinkProductId, tier,
  }, deps);
  res.json(result);
}));

// ------------------------------------------------------------
// CATALOGO ACQUISTI GENERICO — Premium, crediti Like/Superlike
// extra, badge Verificato, e qualunque cosa si aggiunga in futuro.
// Stesso motore di pagamento della Pulse, generalizzato.
// ------------------------------------------------------------
app.get('/api/products', ah(async (req, res) => {
  const products = await db.queryAll(`
    SELECT id, sku, display_name, description, price_cents, product_type, effect_config
    FROM iap_products WHERE is_active = true ORDER BY price_cents ASC
  `);
  res.json({ success: true, products });
}));

app.post('/api/dashboard/products/:productId/price', requireArchitect, ah(async (req, res) => {
  const { priceCents } = req.body;
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    return res.json({ success: false, reason: 'invalid_price' });
  }
  await db.query(`UPDATE iap_products SET price_cents = $1 WHERE id = $2`, [priceCents, req.params.productId]);
  res.json({ success: true });
}));

app.get('/api/dashboard/search-by-hashtag', requireArchitect, ah(async (req, res) => {
  const { hashtag } = req.query;
  if (!hashtag) return res.json({ success: false, reason: 'hashtag_required' });
  const people = await searchUsersByHashtag({ hashtag }, { db });
  res.json({ success: true, people });
}));

app.post('/api/dashboard/venues/:venueId/spending-config', requireArchitect, ah(async (req, res) => {
  const { thresholdCents, bonusPoints } = req.body;
  if (!Number.isInteger(thresholdCents) || thresholdCents <= 0 || !Number.isInteger(bonusPoints) || bonusPoints <= 0) {
    return res.json({ success: false, reason: 'invalid_values' });
  }
  const result = await updateVenueSpendingConfig({ venueId: req.params.venueId, thresholdCents, bonusPoints }, { db });
  res.json(result);
}));

app.post('/api/dashboard/award-table-spending', requireArchitect, ah(async (req, res) => {
  const { venueId, tableQrCode, spentCents } = req.body;
  if (!venueId || !tableQrCode || !Number.isInteger(spentCents) || spentCents <= 0) {
    return res.json({ success: false, reason: 'invalid_values' });
  }
  const result = await awardTableSpendingBonusByVenue({ venueId, tableQrCode, spentCents }, deps);
  res.json(result);
}));

app.get('/api/dashboard/venues/:venueId/full-settings', requireArchitect, ah(async (req, res) => {
  const result = await getVenueFullSettings({ venueId: req.params.venueId }, { db });
  res.json(result);
}));

app.get('/api/dashboard/commissions', requireArchitect, ah(async (req, res) => {
  const report = await getCommissionsReport({}, { db });
  res.json({ success: true, report });
}));

app.post('/api/dashboard/venues/:venueId/commission', requireArchitect, ah(async (req, res) => {
  const { commissionVenuePct } = req.body;
  if (!Number.isInteger(commissionVenuePct) || commissionVenuePct < 0 || commissionVenuePct > 100) {
    return res.json({ success: false, reason: 'invalid_percentage' });
  }
  await db.query(`UPDATE venues SET commission_venue_pct = $1 WHERE id = $2`, [commissionVenuePct, req.params.venueId]);
  res.json({ success: true });
}));

app.post('/api/dashboard/venues/:venueId/pulse-prices', requireArchitect, ah(async (req, res) => {
  const { singlePriceCents, bundle5PriceCents } = req.body;
  // Entrambi facoltativi — un Architetto può impostare solo uno dei
  // due se è quello che ha concordato con il locale, l'altro resta
  // vuoto (null) finché non viene impostato a sua volta.
  await db.query(`
    UPDATE venues SET pulse_price_cents = $1, pulse_bundle_5_price_cents = $2 WHERE id = $3
  `, [singlePriceCents || null, bundle5PriceCents || null, req.params.venueId]);
  res.json({ success: true });
}));

app.post('/api/dashboard/venues/:venueId/arena-hours', requireArchitect, ah(async (req, res) => {
  const { openTime, closeTime } = req.body;
  if (!openTime || !closeTime) {
    return res.json({ success: false, reason: 'both_times_required' });
  }
  await db.query(`
    UPDATE venues SET default_open_time = $1, default_close_time = $2 WHERE id = $3
  `, [openTime, closeTime, req.params.venueId]);
  res.json({ success: true });
}));

app.post('/api/purchases/initiate', requireOnboarded, ah(async (req, res) => {
  const { productId, arenaSessionId } = req.body;
  const result = await initiatePurchase({ userId: req.userId, productId, arenaSessionId }, { db });
  res.json(result);
}));

app.get('/api/venues/:venueId/pulse-prices', ah(async (req, res) => {
  const venue = await db.query(`
    SELECT pulse_price_cents, pulse_bundle_5_price_cents FROM venues WHERE id = $1
  `, [req.params.venueId]);
  if (!venue) return res.json({ success: false, reason: 'venue_not_found' });
  res.json({
    success: true,
    singlePriceCents: venue.pulse_price_cents,
    bundle5PriceCents: venue.pulse_bundle_5_price_cents,
  });
}));

app.post('/api/venues/:venueId/pulse-credits/purchase', requireOnboarded, ah(async (req, res) => {
  const { quantity } = req.body;
  const result = await initiateVenuePulseCreditsPurchase({ userId: req.userId, venueId: req.params.venueId, quantity }, { db });
  res.json(result);
}));

app.post('/api/pulses/:pulseId/respond', requireOnboarded, ah(async (req, res) => {
  const { action } = req.body; // 'accept' | 'reject' | 'ignore'
  const result = await respondToPulse({
    pulseId: req.params.pulseId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
}));

app.post('/api/pulses/:pulseId/guess', requireOnboarded, ah(async (req, res) => {
  const { guessedUserId } = req.body;
  const result = await attemptGuess({
    pulseId: req.params.pulseId, receiverId: req.userId, guessedUserId,
  }, deps);
  res.json(result);
}));


// ------------------------------------------------------------
// REPORT PER I LOCALI (v. populive-venue-insights.js)
// ------------------------------------------------------------
app.get('/api/venues/:venueId/report', ah(async (req, res) => {
  // NOTA: in produzione questo endpoint va protetto — solo il
  // team o il proprietario autenticato del locale specifico deve
  // poterlo chiamare, non chiunque conosca l'indirizzo.
  const { fromDate, toDate } = req.query;
  const result = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
  res.json(result);
}));


// ------------------------------------------------------------
// TAVOLO — "Aggancia il tuo tavolo" (bottone dentro l'app, non un
// secondo link/QR esterno — fotocamera nativa dell'app che legge
// il QR fisico sul tavolo e collega la sessione corrente)
// ------------------------------------------------------------
app.post('/api/table/join', requireOnboarded, ah(async (req, res) => {
  const { tableQrCode, arenaSessionId, wantsToBeConnector } = req.body;
  const result = await joinSquad({
    connectorId: undefined,  // lascia decidere a joinSquad in base allo stato del tavolo
    memberId: req.userId,
    arenaSessionId,
    tableQrCode,
    wantsToBeConnector,
  }, deps);
  res.json(result);
}));


// ------------------------------------------------------------
// CLASSIFICHE (locale e globale) — sola lettura, derivate sempre
// dallo stesso points_ledger, mai una tabella separata da tenere
// sincronizzata a mano.
// ------------------------------------------------------------
app.get('/api/arenas/:arenaSessionId/ranking', ah(async (req, res) => {
  const { hashtag, gender } = req.query;
  const ranking = await getLocalRanking({ arenaSessionId: req.params.arenaSessionId, hashtag, gender }, { db });
  res.json({ success: true, ranking });
}));

app.get('/api/ranking/global', ah(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const { hashtag, gender } = req.query;
  const ranking = await getGlobalRanking({ limit, hashtag, gender }, { db });
  res.json({ success: true, ranking });
}));

app.get('/api/users/:userId/ranking-summary', ah(async (req, res) => {
  const { arenaSessionId } = req.query;
  // Controllo "morbido": se c'è un token valido sappiamo chi guarda
  // (utile per il proprietario, che deve vedere sempre i suoi dati
  // veri), ma non blocchiamo la richiesta se manca — guardare una
  // classifica resta possibile anche senza login.
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const { valid, userId: viewerId } = token ? verifyToken(token) : { valid: false };
  const summary = await getUserRankingSummary({ userId: req.params.userId, arenaSessionId, viewerId: valid ? viewerId : null }, { db });
  res.json({ success: true, summary });
}));

app.get('/api/users/:userId/welcome-back', requireOnboarded, ah(async (req, res) => {
  const result = await getWelcomeBackSummary({ userId: req.userId }, { db });
  res.json(result);
}));

app.get('/api/dashboard/venue-report/:venueId', requireArchitect, ah(async (req, res) => {
  // Se non indicate, l'intervallo di default è "ultimi 30 giorni" —
  // abbastanza per un pitch commerciale vero, senza dover
  // specificare nulla la prima volta che si apre il report.
  const toDate = req.query.toDate || new Date().toISOString().slice(0, 10);
  const fromDate = req.query.fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const report = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
  res.json({ success: true, report, fromDate, toDate });
}));

app.get('/api/venues/map', ah(async (req, res) => {
  const venues = await getAllVenuesForMap({}, { db });
  res.json({ success: true, venues });
}));

app.post('/api/venues/create', requireOnboarded, ah(async (req, res) => {
  const { name, area, latitude, longitude, venueType } = req.body;
  const result = await createVirtualVenue({ name, area, latitude, longitude, venueType }, { db });
  res.json(result);
}));

app.get('/api/feature-flags', ah(async (req, res) => {
  // Pubblico, senza login — l'app deve poter sapere cosa mostrare
  // ancora prima che la persona faccia il login (es. nella
  // schermata di ingresso stessa).
  const flags = await db.queryAll(`SELECT feature_key, is_enabled FROM feature_flags`);
  const map = {};
  flags.forEach((f) => { map[f.feature_key] = f.is_enabled; });
  res.json({ success: true, flags: map });
}));

app.post('/api/dashboard/feature-flags/:key', requireArchitect, ah(async (req, res) => {
  const { isEnabled } = req.body;
  await db.query(`UPDATE feature_flags SET is_enabled = $1 WHERE feature_key = $2`, [!!isEnabled, req.params.key]);
  res.json({ success: true });
}));

app.get('/api/venues/popular-now', ah(async (req, res) => {
  const venues = await getPopularVenuesNow({}, { db });
  res.json({ success: true, venues });
}));

app.get('/api/venues/:venueId/historical-checkins', requireOnboarded, ah(async (req, res) => {
  const people = await getVenueHistoricalCheckins({ venueId: req.params.venueId, requesterId: req.userId }, { db });
  res.json({ success: true, people });
}));


// ------------------------------------------------------------
// DRINK DISPONIBILI IN UN LOCALE (per la schermata di invio Pulse)
// ------------------------------------------------------------
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


// ------------------------------------------------------------
// RISCATTO REALE AL BANCONE — chiamato dal telefono del CLIENTE
// nel momento in cui il bartender stesso tocca il sigillo attivo
// sul suo schermo. Non serve nessun dispositivo o account separato
// per lo staff: il tocco del bartender sul telefono del cliente è
// insieme la verifica antifrode (il flash dimostra che è dal vivo)
// e la conferma di riscatto — un solo gesto, zero attrito operativo
// per il locale.
// ------------------------------------------------------------
app.post('/api/pulses/:pulseId/redeem', ah(async (req, res) => {
  const { redeemCode, venueId } = req.body;

  // Il locale del riscatto è OBBLIGATORIO — e ora deve corrispondere
  // ESATTAMENTE al locale in cui il Pulse è stato ricevuto: chi lo
  // riceve deve spenderlo lì o perderlo, non può portarselo dietro
  // in un altro locale. Più semplice per la contabilità (nessun
  // dubbio su a chi girare la commissione) e un incentivo in più
  // per il locale (chi non vuole perdere il regalo deve consumare
  // lì prima di andarsene altrove).
  if (!venueId) {
    return res.json({ success: false, reason: 'venue_required_for_redeem' });
  }

  const pulse = await db.query(`
    SELECT p.*, a.venue_id AS origin_venue_id
    FROM pulses p
    JOIN arena_sessions a ON a.id = p.arena_session_id
    WHERE p.id = $1 AND p.redeem_code = $2
  `, [req.params.pulseId, redeemCode]);

  if (!pulse) {
    return res.json({ success: false, reason: 'invalid_code_or_already_redeemed' });
  }
  if (pulse.status === 'expired') {
    return res.json({ success: false, reason: 'pulse_expired_changed_venue' });
  }
  if (pulse.status !== 'accepted') {
    return res.json({ success: false, reason: 'invalid_code_or_already_redeemed' });
  }
  if (pulse.redeem_expires_at && new Date(pulse.redeem_expires_at) < new Date()) {
    return res.json({ success: false, reason: 'code_expired' });
  }
  if (pulse.origin_venue_id !== venueId) {
    return res.json({ success: false, reason: 'wrong_venue', originVenueId: pulse.origin_venue_id });
  }

  await db.query(`
    UPDATE pulses SET status = 'redeemed', redeemed_venue_id = $1 WHERE id = $2
  `, [venueId, req.params.pulseId]);
  res.json({ success: true });
}));

// ------------------------------------------------------------
// CANDIDATI PER IL MINIGIOCO PULSE+LIKE — profili di base di chi
// ha fatto check-in in questa Arena (nome, foto), usati per la
// schermata "indovina chi ti ha inviato la Pulse".
// ------------------------------------------------------------
app.get('/api/arenas/:arenaSessionId/guess-candidates', ah(async (req, res) => {
  const candidates = await db.queryAll(`
    SELECT DISTINCT u.id AS user_id, u.display_name, u.avatar_emoji, u.photo_url
    FROM checkins c
    JOIN users u ON u.id = c.user_id
    WHERE c.arena_session_id = $1
  `, [req.params.arenaSessionId]);
  res.json({ success: true, candidates });
}));


// ------------------------------------------------------------
// RISPOSTA A UN SUPERLIKE SEMPLICE — accetta/rifiuta/lascia in sospeso
// ------------------------------------------------------------
app.post('/api/interactions/:interactionId/respond', requireOnboarded, ah(async (req, res) => {
  const { action } = req.body;
  const result = await respondToSuperlike({
    interactionId: req.params.interactionId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
}));


// ------------------------------------------------------------
// CHAT 1-A-1 — invio e lettura messaggi, sempre solo tra i due
// partecipanti della conversazione
// ------------------------------------------------------------
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


// ------------------------------------------------------------
// IMPOSTAZIONI — richiamabili in ogni momento (a differenza del
// consenso di onboarding, visto una sola volta) per cambiare idea
// liberamente su privacy e autopresentazione.
// ------------------------------------------------------------
app.get('/api/profile/:userId/settings', requireOnboarded, ah(async (req, res) => {
  // Le tue impostazioni sono tue soltanto — SEMPRE req.userId dal
  // token, mai il pezzo di indirizzo che chiunque potrebbe cambiare
  // a mano per leggere/scrivere le impostazioni di un altro.
  const user = await db.query(`
    SELECT show_ranking_on_profile, sponsored_missions_enabled,
           appears_in_historical_search, receive_pulses_enabled, contact_filter,
           ghost_mode_enabled
    FROM users WHERE id = $1
  `, [req.userId]);
  if (!user) return res.json({ success: false, reason: 'user_not_found' });

  res.json({
    success: true,
    settings: {
      showRankingOnProfile: user.show_ranking_on_profile,
      sponsoredMissionsEnabled: user.sponsored_missions_enabled,
      appearsInHistoricalSearch: user.appears_in_historical_search,
      receivePulsesEnabled: user.receive_pulses_enabled,
      contactFilter: user.contact_filter,
      ghostModeEnabled: user.ghost_mode_enabled,
    },
  });
}));

app.post('/api/profile/:userId/settings', requireOnboarded, ah(async (req, res) => {
  const {
    showRankingOnProfile, sponsoredMissionsEnabled,
    appearsInHistoricalSearch, receivePulsesEnabled, contactFilter,
    ghostModeEnabled,
  } = req.body;

  // Stessa protezione qui, ancora più importante: senza questo,
  // chiunque loggato avrebbe potuto RISCRIVERE le impostazioni di
  // un altro utente semplicemente cambiando l'ID nell'indirizzo.
  await db.query(`
    UPDATE users SET
      show_ranking_on_profile = $1,
      sponsored_missions_enabled = $2,
      appears_in_historical_search = $3,
      receive_pulses_enabled = $4,
      contact_filter = $5,
      ghost_mode_enabled = $6
    WHERE id = $7
  `, [
    showRankingOnProfile, sponsoredMissionsEnabled,
    appearsInHistoricalSearch, receivePulsesEnabled, contactFilter,
    ghostModeEnabled,
    req.userId,
  ]);

  res.json({ success: true });
}));


// ------------------------------------------------------------
// GESTORE DI ERRORI GLOBALE — l'ultimo pezzo del puzzle: qualunque
// errore catturato da "ah()" sopra arriva qui, invece che a Express
// di default (che risponderebbe con una pagina HTML illeggibile
// per il frontend, facendo credere a un problema di rete quando
// invece è un errore interno preciso). Da qui in poi, OGNI errore
// interno arriva al frontend come JSON vero, sempre.
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[errore non gestito]', err);
  res.status(500).json({ success: false, reason: 'internal_error' });
});


const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`PopuLive API in ascolto sulla porta ${PORT}`);
  // Il motore a orari parte insieme al server — gira per sempre in
  // background, controllando ogni pochi minuti se qualche Arena va
  // aperta o chiusa. Nessun intervento manuale necessario da qui in poi.
  startScheduler({ db, redis, io });
  console.log('Motore a orari avviato.');
});
