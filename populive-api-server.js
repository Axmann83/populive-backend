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
const { handleCheckin } = require('./populive-checkin-logic');
const {
  sendInteraction, trackProfileView, sendRosa, respondToRosa, attemptGuess, respondToSuperlike, getReceivedRoses,
} = require('./populive-interactions-logic');
const { sendMessage, getMessages, setChatKeepPreference } = require('./populive-chat-logic');
const { startScheduler } = require('./populive-scheduler');
const {
  createProfile, setProfilePhoto, completeOnboarding, requireCompletedOnboarding,
} = require('./populive-profile-onboarding');
const { generateVenueReport } = require('./populive-venue-insights');
const { joinSquad } = require('./populive-connector-engine');
const { getLocalRanking, getGlobalRanking, getUserRankingSummary } = require('./populive-ranking-queries');

const app = express();
app.use(cors()); // permette al frontend (su un altro indirizzo) di chiamare questo backend
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


// ------------------------------------------------------------
// MIDDLEWARE — verifica che l'utente esista e abbia completato
// l'onboarding, PRIMA di eseguire qualunque azione "vera"
// dell'app. Non tocca handleCheckin/sendRosa/ecc: si mette davanti.
// ------------------------------------------------------------
async function requireOnboarded(req, res, next) {
  const userId = req.headers['x-user-id']; // in produzione: da un token di sessione vero, non un header semplice
  if (!userId) return res.status(401).json({ success: false, reason: 'missing_user' });

  const check = await requireCompletedOnboarding(userId, { db });
  if (!check.allowed) return res.status(403).json({ success: false, reason: check.reason });

  req.userId = userId;
  next();
}


// ------------------------------------------------------------
// PROFILO / ONBOARDING (nessun requireOnboarded qui, ovviamente:
// è proprio il percorso PER diventare onboarded)
// ------------------------------------------------------------
app.post('/api/profile', async (req, res) => {
  const { displayName, bio, hashtagNames } = req.body;
  const result = await createProfile({ displayName, bio, hashtagNames }, { db });
  res.json(result);
});

app.post('/api/profile/:userId/photo', async (req, res) => {
  const result = await setProfilePhoto({ userId: req.params.userId, photoUrl: req.body.photoUrl }, { db });
  res.json(result);
});

app.post('/api/profile/:userId/onboarding', async (req, res) => {
  const result = await completeOnboarding({ userId: req.params.userId, consentChoices: req.body }, { db });
  res.json(result);
});


// ------------------------------------------------------------
// CHECK-IN
// ------------------------------------------------------------
app.post('/api/checkin', requireOnboarded, async (req, res) => {
  const { venueId } = req.body;
  const result = await handleCheckin({ userId: req.userId, venueId }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// INTERAZIONI (Like / Superlike / visite profilo)
// ------------------------------------------------------------
app.post('/api/interactions/send', requireOnboarded, async (req, res) => {
  const { receiverId, arenaSessionId, type } = req.body; // type: 'like' | 'superlike'
  const result = await sendInteraction({ senderId: req.userId, receiverId, arenaSessionId, type }, deps);
  res.json(result);
});

app.post('/api/profile-views', requireOnboarded, async (req, res) => {
  const { viewedUserId, arenaSessionId } = req.body;
  const result = await trackProfileView({ viewerId: req.userId, viewedUserId, arenaSessionId }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// ROSE
// ------------------------------------------------------------
app.get('/api/users/:userId/roses', requireOnboarded, async (req, res) => {
  const roses = await getReceivedRoses({ userId: req.params.userId }, deps);
  res.json({ success: true, roses });
});

app.post('/api/roses/send', requireOnboarded, async (req, res) => {
  const { receiverId, arenaSessionId, drinkProductId, tier } = req.body;
  const result = await sendRosa({
    senderId: req.userId, receiverId, arenaSessionId, drinkProductId, tier,
  }, deps);
  res.json(result);
});

app.post('/api/roses/:rosaId/respond', requireOnboarded, async (req, res) => {
  const { action } = req.body; // 'accept' | 'reject' | 'ignore'
  const result = await respondToRosa({
    rosaId: req.params.rosaId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
});

app.post('/api/roses/:rosaId/guess', requireOnboarded, async (req, res) => {
  const { guessedUserId } = req.body;
  const result = await attemptGuess({
    rosaId: req.params.rosaId, receiverId: req.userId, guessedUserId,
  }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// REPORT PER I LOCALI (v. populive-venue-insights.js)
// ------------------------------------------------------------
app.get('/api/venues/:venueId/report', async (req, res) => {
  // NOTA: in produzione questo endpoint va protetto — solo il
  // team o il proprietario autenticato del locale specifico deve
  // poterlo chiamare, non chiunque conosca l'indirizzo.
  const { fromDate, toDate } = req.query;
  const result = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
  res.json(result);
});


// ------------------------------------------------------------
// TAVOLO — "Aggancia il tuo tavolo" (bottone dentro l'app, non un
// secondo link/QR esterno — fotocamera nativa dell'app che legge
// il QR fisico sul tavolo e collega la sessione corrente)
// ------------------------------------------------------------
app.post('/api/table/join', requireOnboarded, async (req, res) => {
  const { tableQrCode, arenaSessionId, wantsToBeConnector } = req.body;
  // wantsToBeConnector: risposta alla domanda "vuoi essere il Top
  // Connector di questo tavolo?", mostrata dal frontend SOLO se
  // questo è il primo scan di questo QR (tavolo non ancora agganciato
  // da nessuno) — il frontend lo sa perché può controllare prima con
  // una GET se il tavolo esiste già, o semplicemente mostrare sempre
  // la domanda e il backend la ignora se il tavolo esiste già.
  const result = await joinSquad({
    connectorId: undefined,  // lascia decidere a joinSquad in base allo stato del tavolo
    memberId: req.userId,
    arenaSessionId,
    tableQrCode,
    wantsToBeConnector,
  }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// CLASSIFICHE (locale e globale) — sola lettura, derivate sempre
// dallo stesso points_ledger, mai una tabella separata da tenere
// sincronizzata a mano.
// ------------------------------------------------------------
app.get('/api/arenas/:arenaSessionId/ranking', async (req, res) => {
  const ranking = await getLocalRanking({ arenaSessionId: req.params.arenaSessionId }, { db });
  res.json({ success: true, ranking });
});

app.get('/api/ranking/global', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const ranking = await getGlobalRanking({ limit }, { db });
  res.json({ success: true, ranking });
});

app.get('/api/users/:userId/ranking-summary', async (req, res) => {
  const { arenaSessionId } = req.query;
  const viewerId = req.headers['x-user-id']; // chi sta guardando, per rispettare show_ranking_on_profile
  const summary = await getUserRankingSummary({ userId: req.params.userId, arenaSessionId, viewerId }, { db });
  res.json({ success: true, summary });
});


// ------------------------------------------------------------
// DRINK DISPONIBILI IN UN LOCALE (per la schermata di invio Rosa)
// ------------------------------------------------------------
app.get('/api/venues/:venueId/drinks', async (req, res) => {
  const drinks = await db.queryAll(`
    SELECT dp.id, dp.name, dp.base_price_cents, dp.sponsor_discount_cents, bs.name AS sponsor_name
    FROM venue_drink_catalog vdc
    JOIN drink_products dp ON dp.id = vdc.drink_product_id
    LEFT JOIN brand_sponsors bs ON bs.id = dp.brand_sponsor_id
    WHERE vdc.venue_id = $1 AND dp.is_active = true
    ORDER BY dp.base_price_cents ASC
  `, [req.params.venueId]);
  res.json({ success: true, drinks });
});


// ------------------------------------------------------------
// RISCATTO REALE AL BANCONE — chiamato dal telefono del CLIENTE
// nel momento in cui il bartender stesso tocca il sigillo attivo
// sul suo schermo. Non serve nessun dispositivo o account separato
// per lo staff: il tocco del bartender sul telefono del cliente è
// insieme la verifica antifrode (il flash dimostra che è dal vivo)
// e la conferma di riscatto — un solo gesto, zero attrito operativo
// per il locale.
// ------------------------------------------------------------
app.post('/api/roses/:rosaId/redeem', async (req, res) => {
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
});
// ------------------------------------------------------------
// CANDIDATI PER IL MINIGIOCO ROSA+LIKE — profili di base di chi
// ha fatto check-in in questa Arena (nome, foto), usati per la
// schermata "indovina chi ti ha inviato la Rosa".
// ------------------------------------------------------------
app.get('/api/arenas/:arenaSessionId/guess-candidates', async (req, res) => {
  const candidates = await db.queryAll(`
    SELECT DISTINCT u.id AS user_id, u.display_name, u.avatar_emoji, u.photo_url
    FROM checkins c
    JOIN users u ON u.id = c.user_id
    WHERE c.arena_session_id = $1
  `, [req.params.arenaSessionId]);
  res.json({ success: true, candidates });
});


// ------------------------------------------------------------
// RISPOSTA A UN SUPERLIKE SEMPLICE — accetta/rifiuta/lascia in sospeso
// ------------------------------------------------------------
app.post('/api/interactions/:interactionId/respond', requireOnboarded, async (req, res) => {
  const { action } = req.body;
  const result = await respondToSuperlike({
    interactionId: req.params.interactionId, receiverId: req.userId, action,
  }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// CHAT 1-A-1 — invio e lettura messaggi, sempre solo tra i due
// partecipanti della conversazione
// ------------------------------------------------------------
app.post('/api/chat/:conversationId/messages', requireOnboarded, async (req, res) => {
  const { body } = req.body;
  const result = await sendMessage({
    conversationId: req.params.conversationId, senderId: req.userId, body,
  }, deps);
  res.json(result);
});

app.get('/api/chat/:conversationId/messages', requireOnboarded, async (req, res) => {
  const result = await getMessages({
    conversationId: req.params.conversationId, requesterId: req.userId,
  }, deps);
  res.json(result);
});

app.post('/api/chat/:conversationId/keep-preference', requireOnboarded, async (req, res) => {
  const { wantsKeep } = req.body;
  const result = await setChatKeepPreference({
    conversationId: req.params.conversationId, userId: req.userId, wantsKeep,
  }, deps);
  res.json(result);
});


// ------------------------------------------------------------
// IMPOSTAZIONI — richiamabili in ogni momento (a differenza del
// consenso di onboarding, visto una sola volta) per cambiare idea
// liberamente su privacy e autopresentazione.
// ------------------------------------------------------------
app.get('/api/profile/:userId/settings', requireOnboarded, async (req, res) => {
  const user = await db.query(`
    SELECT show_ranking_on_profile, sponsored_missions_enabled,
           appears_in_historical_search, receive_roses_enabled, contact_filter
    FROM users WHERE id = $1
  `, [req.params.userId]);
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
});

app.post('/api/profile/:userId/settings', requireOnboarded, async (req, res) => {
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
    req.params.userId,
  ]);

  res.json({ success: true });
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
