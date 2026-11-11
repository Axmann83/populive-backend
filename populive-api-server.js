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
const {
  handleCheckin,
  createVirtualVenue,
  getAllVenuesForMap,
  evaluateLocationPing,
  leaveVenue,
  getCurrentCheckin,
} = require('./populive-checkin-logic');
const {
  sendInteraction,
  trackProfileView,
  respondToPulse,
  respondToSuperlike,
  getReceivedPulses,
  getSentPulses,
  sendPulse,
  getInteractionHistory,
  getUnseenNotificationCount,
  markNotificationsSeen,
  dismissNotification,
  clearAllNotifications,
  dismissPulseView,
  clearAllPulseViews,
  getPermanentlyBlockedPairUserIds,
  getPendingReceivedInteractions,
  getSentInteractionsHistory,
  getUnseenLikeCenterCount,
  markLikeCenterSeen,
} = require('./populive-interactions-logic');
const {
  blockUser,
  blockUserInConversation,
  unblockUser,
  getBlockedUsers,
  getUserBlockPairIds,
  createReport,
  listReports,
  resolveReport,
  unsuspendUser,
} = require('./populive-moderation-logic');
const {
  getVerificationStatus,
  startVerification,
  submitVerification,
  listPendingVerifications,
  reviewVerification,
} = require('./populive-verification-logic');
const {
  initiateNightPulsePurchase,
  syncPendingNightPurchases,
  initiatePurchase,
  appReturnTarget,
  handleStripeWebhook,
} = require('./populive-payments-logic');
const { getPulseNightInfo } = require('./populive-pulse-nights');
const {
  sendMessage,
  getMessages,
  deleteConversationForUser,
  getMyActiveConversations,
  markConversationRead,
  getUnreadChatCount,
  openAdminChat,
} = require('./populive-chat-logic');
const { startScheduler } = require('./populive-scheduler');
const {
  createProfile,
  setProfilePhoto,
  setProfilePhotos,
  updateProfileDetails,
  completeOnboarding,
  requireCompletedOnboarding,
  getPublicProfile,
  findUserByPhone,
  setInstantInfluencerStatus,
  setProfessionalConnectorStatus,
} = require('./populive-profile-onboarding');
const {
  generateVenueReport,
  getPopularVenuesNow,
  getVenueHistoricalCheckins,
  getCommissionsReport,
  getVenueFullSettings,
  getVenueDrinks,
  addVenueDrink,
  updateVenueDrink,
  removeVenueDrink,
} = require('./populive-venue-insights');
const {
  joinSquad,
  awardTableSpendingBonusByVenue,
  updateVenueSpendingConfig,
  claimTableAsProfessionalConnector,
  setTableLock,
} = require('./populive-connector-engine');
const {
  getLocalRanking,
  getGlobalRanking,
  getUserRankingSummary,
  getWelcomeBackSummary,
  searchUsersByHashtag,
  checkLocalRankingThreshold,
} = require('./populive-ranking-queries');
const {
  createMission,
  getAllMissions,
  getMissionsNearUser,
  completeMission,
  getMissionPreview,
} = require('./populive-missions-logic');
const { requestOtp, verifyOtp, verifyToken, deleteAccount } = require('./populive-auth-logic');
const { registerPushToken, unregisterPushToken } = require('./populive-push');

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

  // Account sospeso (B2): fuori anche prima di finire l'onboarding.
  const suspended = await db.query(`SELECT 1 FROM users WHERE id = $1 AND suspended_at IS NOT NULL`, [userId]);
  if (suspended) return res.status(403).json({ success: false, reason: 'account_suspended' });

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
app.post(
  '/api/auth/request-otp',
  ah(async (req, res) => {
    const { phoneNumber } = req.body;
    const result = await requestOtp({ phoneNumber }, { db });
    res.json(result);
  })
);

app.post(
  '/api/auth/verify-otp',
  ah(async (req, res) => {
    const { phoneNumber, code } = req.body;
    const result = await verifyOtp({ phoneNumber, code }, { db });
    res.json(result);
  })
);

// Usato quando l'app si riapre con un token già salvato — dice
// se quel token è ancora valido e se l'onboarding è completo,
// senza richiedere che l'onboarding sia già fatto (a differenza
// di requireOnboarded).
app.get(
  '/api/auth/me',
  requireAuthOnly,
  ah(async (req, res) => {
    const user = await db.query(`SELECT id, onboarding_completed FROM users WHERE id = $1`, [req.userId]);
    if (!user) return res.json({ success: false, reason: 'user_not_found' });
    res.json({ success: true, userId: user.id, onboardingCompleted: user.onboarding_completed });
  })
);

app.get(
  '/api/auth/is-architect',
  requireAuthOnly,
  ah(async (req, res) => {
    const architect = await db.query(`SELECT user_id FROM architects WHERE user_id = $1`, [req.userId]);
    res.json({ success: true, isArchitect: !!architect });
  })
);

// PR professionista (19/9) — usato da CheckinRadar.jsx per decidere
// se mostrare il bottone "Sono il PR di questo tavolo". Flag mai
// auto-attivabile, settata solo da dashboard (v. endpoint dedicato
// più sotto).
app.get(
  '/api/auth/is-professional-connector',
  requireAuthOnly,
  ah(async (req, res) => {
    const user = await db.query(`SELECT is_professional_connector FROM users WHERE id = $1`, [req.userId]);
    res.json({ success: true, isProfessionalConnector: !!(user && user.is_professional_connector) });
  })
);

// ------------------------------------------------------------
// NOTIFICHE PUSH (ottobre 2026, D3) — il token Firebase del
// dispositivo. L'app lo registra a ogni avvio dopo il login e lo
// cancella al logout. Basta un token valido: anche durante
// l'onboarding il dispositivo è già di quella persona.
// ------------------------------------------------------------
app.post(
  '/api/push/token',
  requireAuthOnly,
  ah(async (req, res) => {
    const { token, platform } = req.body;
    const result = await registerPushToken({ userId: req.userId, token, platform }, { db });
    res.json(result);
  })
);

app.delete(
  '/api/push/token',
  requireAuthOnly,
  ah(async (req, res) => {
    const result = await unregisterPushToken({ userId: req.userId, token: req.body.token }, { db });
    res.json(result);
  })
);

// ------------------------------------------------------------
// PROFILO / ONBOARDING — richiede un token valido (sei loggato),
// ma NON ancora onboarding_completed (è proprio quello che stiamo
// per completare qui).
// ------------------------------------------------------------
app.post(
  '/api/profile',
  requireAuthOnly,
  ah(async (req, res) => {
    const { displayName, bio, hashtagNames, genderForStats } = req.body;
    const result = await createProfile({ userId: req.userId, displayName, bio, hashtagNames, genderForStats }, { db });
    res.json(result);
  })
);

app.post(
  '/api/profile/:userId/photo',
  requireAuthOnly,
  ah(async (req, res) => {
    const result = await setProfilePhoto({ userId: req.userId, photoUrl: req.body.photoUrl }, { db });
    res.json(result);
  })
);

// Galleria vera, fino a 6 foto (18/9) — il frontend manda sempre
// l'elenco COMPLETO e già ordinato (gestisce da solo in locale
// aggiunte/rimozioni/riordino prima di salvare), sostituisce quanto
// c'era prima. SEMPRE req.userId dal token, mai il pezzo di indirizzo.
app.post(
  '/api/profile/:userId/photos',
  requireAuthOnly,
  ah(async (req, res) => {
    const result = await setProfilePhotos({ userId: req.userId, photoUrls: req.body.photoUrls }, { db });
    res.json(result);
  })
);

// Cancellazione account (12/9) — richiesta obbligatoria di Apple/
// Google. Come ogni azione "sul proprio account", SEMPRE req.userId
// dal token, mai il pezzo di indirizzo che chiunque potrebbe
// cambiare a mano per cancellare l'account di un altro.
app.delete(
  '/api/profile/me',
  requireAuthOnly,
  ah(async (req, res) => {
    const result = await deleteAccount({ userId: req.userId }, { db });
    res.json(result);
  })
);

app.post(
  '/api/profile/:userId/edit',
  requireOnboarded,
  ah(async (req, res) => {
    const { bio, hashtagNames } = req.body;
    const result = await updateProfileDetails({ userId: req.userId, bio, hashtagNames }, { db });
    res.json(result);
  })
);

app.post(
  '/api/profile/:userId/location',
  requireAuthOnly,
  ah(async (req, res) => {
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

    await db.query(
      `
    UPDATE users SET last_latitude = $1, last_longitude = $2, location_updated_at = now()
    WHERE id = $3
  `,
      [latitude, longitude, req.userId]
    );

    res.json({ success: true });
  })
);

app.post(
  '/api/profile/:userId/onboarding',
  requireAuthOnly,
  ah(async (req, res) => {
    const result = await completeOnboarding({ userId: req.userId, consentChoices: req.body }, { db });
    res.json(result);
  })
);

// ------------------------------------------------------------
// CHECK-IN
// ------------------------------------------------------------
app.post(
  '/api/checkin',
  requireOnboarded,
  ah(async (req, res) => {
    // resumeSessionId solo dalla ripresa automatica all'avvio dell'app,
    // mai da un QR vero (v. handleCheckin, bug B8).
    const { venueId, resumeSessionId } = req.body;
    const result = await handleCheckin({ userId: req.userId, venueId, resumeSessionId }, deps);
    res.json(result);
  })
);

// Serata in cui si risulta dentro adesso (D14): all'avvio, se l'app non
// ne ricorda nessuna, riprende questa (v. getCurrentCheckin).
app.get(
  '/api/checkin/current',
  requireOnboarded,
  ah(async (req, res) => {
    res.json(await getCurrentCheckin({ userId: req.userId }, deps));
  })
);

// Pulsante "Esci dal locale" (ottobre 2026, D14): chiudere l'app non
// fa più uscire dalla serata, quindi chi se ne va lo dice da qui.
app.post(
  '/api/checkin/leave',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await leaveVenue({ userId: req.userId, arenaSessionId: req.body.arenaSessionId }, deps);
    res.json(result);
  })
);

// Geofencing (18/9) — il telefono chiama questo endpoint quando
// l'app torna in primo piano, mandando la posizione ATTUALE una
// tantum (mai in background continuo). Se si è allontanato troppo
// dal locale, il check-in decade da solo — vedi il commento in
// populive-checkin-logic.js per il perché delle scelte fatte.
app.post(
  '/api/checkin/location-ping',
  requireOnboarded,
  ah(async (req, res) => {
    const { arenaSessionId, latitude, longitude } = req.body;
    const result = await evaluateLocationPing({ userId: req.userId, arenaSessionId, latitude, longitude }, deps);
    res.json(result);
  })
);

app.get(
  '/api/dashboard/missions',
  requireArchitect,
  ah(async (req, res) => {
    const missions = await getAllMissions({}, { db });
    res.json({ success: true, missions });
  })
);

app.post(
  '/api/dashboard/missions',
  requireArchitect,
  ah(async (req, res) => {
    const { sponsorName, venueId, claimText, bonusPoints, radiusMeters, hashtagFilter, dateFrom, dateTo } = req.body;
    const result = await createMission(
      { sponsorName, venueId, claimText, bonusPoints, radiusMeters, hashtagFilter, dateFrom, dateTo },
      { db }
    );
    res.json(result);
  })
);

app.get(
  '/api/missions/near-me',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await getMissionsNearUser({ userId: req.userId }, { db });
    res.json(result);
  })
);

app.get(
  '/api/missions/:missionId',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await getMissionPreview({ missionId: req.params.missionId }, { db });
    res.json(result);
  })
);

app.post(
  '/api/missions/:missionId/complete',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await completeMission({ missionId: req.params.missionId, userId: req.userId }, deps);
    res.json(result);
  })
);

// ------------------------------------------------------------
// PROFILO PUBBLICO — quello mostrato a schermo intero quando si
// tocca qualcuno nel radar (foto, nome, hashtag, badge di sessione).
// ------------------------------------------------------------
app.get(
  '/api/users/:userId/public-profile',
  requireOnboarded,
  ah(async (req, res) => {
    const { arenaSessionId } = req.query;
    const result = await getPublicProfile({ userId: req.params.userId, arenaSessionId, viewerId: req.userId }, { db });
    res.json(result);
  })
);

// ------------------------------------------------------------
// INTERAZIONI (Like / Superlike / visite profilo)
// ------------------------------------------------------------
app.post(
  '/api/interactions/send',
  requireOnboarded,
  ah(async (req, res) => {
    const { receiverId, arenaSessionId, type, viaHistoricalBoard } = req.body; // type: 'like' | 'superlike'
    const result = await sendInteraction(
      { senderId: req.userId, receiverId, arenaSessionId, type, viaHistoricalBoard },
      deps
    );
    res.json(result);
  })
);

app.post(
  '/api/profile-views',
  requireOnboarded,
  ah(async (req, res) => {
    const { viewedUserId, arenaSessionId, viaHistoricalBoard } = req.body;
    const result = await trackProfileView(
      { viewerId: req.userId, viewedUserId, arenaSessionId, viaHistoricalBoard },
      deps
    );
    res.json(result);
  })
);

// ------------------------------------------------------------
// PULSE
// ------------------------------------------------------------
// Pulse della serata (M11): prezzo, chiusura e saldo di chi chiede.
app.get(
  '/api/arena-sessions/:arenaSessionId/pulse-night',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await getPulseNightInfo({ userId: req.userId, arenaSessionId: req.params.arenaSessionId }, { db });
    res.json(result);
  })
);

// Compra N Pulse per la serata in cui si è dentro: risponde con
// l'indirizzo della pagina di pagamento di Stripe (o accredita subito
// per gli account di prova).
app.post(
  '/api/pulse-purchases',
  requireOnboarded,
  ah(async (req, res) => {
    const { arenaSessionId, quantity, appReturn } = req.body;
    const result = await initiateNightPulsePurchase(
      { userId: req.userId, arenaSessionId, quantity: Number(quantity), appReturn: appReturn === true },
      deps
    );
    res.json(result);
  })
);

// Ritorno da Stripe nell'app iOS (B18): Stripe arriva qui e noi
// rimandiamo a populive://app/?…, che chiude la pagina di pagamento
// nell'app (ASWebAuthenticationSession). Senza accesso: porta solo
// l'esito, il controllo vero lo fa /api/pulse-purchases/sync.
app.get('/api/app-return', (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  const target = appReturnTarget(query);
  if (!target) return res.status(400).send('Indirizzo non valido');
  res.redirect(302, target);
});

// Ritorno da Stripe: controlla gli acquisti ancora in attesa.
app.post(
  '/api/pulse-purchases/sync',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await syncPendingNightPurchases({ userId: req.userId, since: req.body?.since }, deps);
    res.json(result);
  })
);

app.get(
  '/api/users/:userId/blocked-pairs',
  requireOnboarded,
  ah(async (req, res) => {
    // Solo il proprietario può vedere la propria lista — usiamo
    // sempre req.userId (dal token verificato), mai l'URL scritto a mano.
    const blockedUserIds = await getPermanentlyBlockedPairUserIds({ userId: req.userId }, deps);
    // Solo i blocchi manuali (B2): le classifiche li tolgono, i
    // rifiuti no (lì restano come prima).
    const userBlockedIds = await getUserBlockPairIds({ userId: req.userId }, deps);
    res.json({ success: true, blockedUserIds, userBlockedIds });
  })
);

app.get(
  '/api/users/:userId/pulses',
  requireOnboarded,
  ah(async (req, res) => {
    // Le Pulse ricevute sono dati privati (mittente, drink scelto) —
    // SOLO il proprietario può vederle, mai un ID scritto a mano
    // nell'indirizzo. Usiamo sempre req.userId (dal token verificato),
    // ignorando qualunque cosa sia scritta nell'URL.
    const pulses = await getReceivedPulses({ userId: req.userId }, deps);
    res.json({ success: true, pulses });
  })
);

app.get(
  '/api/users/:userId/sent-pulses',
  requireOnboarded,
  ah(async (req, res) => {
    const pulses = await getSentPulses({ userId: req.userId }, deps);
    res.json({ success: true, pulses });
  })
);

app.post(
  '/api/pulses/send',
  requireOnboarded,
  ah(async (req, res) => {
    const { receiverId, arenaSessionId } = req.body;
    const result = await sendPulse({ senderId: req.userId, receiverId, arenaSessionId }, deps);
    res.json(result);
  })
);

// ------------------------------------------------------------
// CATALOGO ACQUISTI GENERICO — Premium, crediti Like/Superlike
// extra, badge Verificato, e qualunque cosa si aggiunga in futuro.
// Stesso motore di pagamento della Pulse, generalizzato.
// ------------------------------------------------------------
app.get(
  '/api/products',
  ah(async (req, res) => {
    const products = await db.queryAll(`
    SELECT id, sku, display_name, description, price_cents, product_type, effect_config
    FROM iap_products WHERE is_active = true ORDER BY price_cents ASC
  `);
    res.json({ success: true, products });
  })
);

app.post(
  '/api/dashboard/products/:productId/price',
  requireArchitect,
  ah(async (req, res) => {
    const { priceCents } = req.body;
    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      return res.json({ success: false, reason: 'invalid_price' });
    }
    await db.query(`UPDATE iap_products SET price_cents = $1 WHERE id = $2`, [priceCents, req.params.productId]);
    res.json({ success: true });
  })
);

app.get(
  '/api/dashboard/search-by-hashtag',
  requireArchitect,
  ah(async (req, res) => {
    const { hashtag } = req.query;
    if (!hashtag) return res.json({ success: false, reason: 'hashtag_required' });
    const people = await searchUsersByHashtag({ hashtag }, { db });
    res.json({ success: true, people });
  })
);

app.get(
  '/api/dashboard/find-user-by-phone',
  requireArchitect,
  ah(async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.json({ success: false, reason: 'phone_required' });
    const result = await findUserByPhone({ phoneNumber: phone }, { db });
    res.json(result);
  })
);

app.post(
  '/api/dashboard/users/:userId/instant-influencer',
  requireArchitect,
  ah(async (req, res) => {
    const { category, products } = req.body;
    const result = await setInstantInfluencerStatus({ userId: req.params.userId, category, products }, { db });
    res.json(result);
  })
);

// PR professionista (19/9) — unico modo per attivarla, mai
// auto-attivabile dall'utente stesso (v. ProfessionalConnectorSection
// in Dashboard.jsx, stesso pattern di ricerca per telefono già usato
// per Instant Influencer qui sopra).
app.post(
  '/api/dashboard/users/:userId/professional-connector',
  requireArchitect,
  ah(async (req, res) => {
    const { isProfessionalConnector } = req.body;
    const result = await setProfessionalConnectorStatus(
      {
        userId: req.params.userId,
        isProfessionalConnector: !!isProfessionalConnector,
      },
      { db }
    );
    res.json(result);
  })
);

// Messaggio diretto degli Architetti dalla classifica, senza match
// (26/8) — endpoint SOLO dashboard, mai richiamato dall'app normale;
// la vera sicurezza sta nel middleware requireArchitect, non nel
// fatto che il frontend lo chiami solo da un certo punto.
app.post(
  '/api/dashboard/users/:userId/start-chat',
  requireArchitect,
  ah(async (req, res) => {
    const result = await openAdminChat({ architettoId: req.userId, targetUserId: req.params.userId }, { db, io });
    res.json({ success: true, ...result });
  })
);

app.post(
  '/api/dashboard/venues/:venueId/spending-config',
  requireArchitect,
  ah(async (req, res) => {
    const { thresholdCents, bonusPoints } = req.body;
    if (
      !Number.isInteger(thresholdCents) ||
      thresholdCents <= 0 ||
      !Number.isInteger(bonusPoints) ||
      bonusPoints <= 0
    ) {
      return res.json({ success: false, reason: 'invalid_values' });
    }
    const result = await updateVenueSpendingConfig(
      { venueId: req.params.venueId, thresholdCents, bonusPoints },
      { db }
    );
    res.json(result);
  })
);

app.post(
  '/api/dashboard/venues/:venueId/ranking-threshold',
  requireArchitect,
  ah(async (req, res) => {
    const { minUsers } = req.body;
    if (!Number.isInteger(minUsers) || minUsers < 1) {
      return res.json({ success: false, reason: 'invalid_value' });
    }
    await db.query(`UPDATE venues SET min_users_for_local_ranking = $1 WHERE id = $2`, [minUsers, req.params.venueId]);
    res.json({ success: true });
  })
);

app.get(
  '/api/dashboard/venues/:venueId/drinks',
  requireArchitect,
  ah(async (req, res) => {
    const drinks = await getVenueDrinks({ venueId: req.params.venueId }, { db });
    res.json({ success: true, drinks });
  })
);

app.post(
  '/api/dashboard/venues/:venueId/drinks',
  requireArchitect,
  ah(async (req, res) => {
    const { name, basePriceCents } = req.body;
    const result = await addVenueDrink({ venueId: req.params.venueId, name, basePriceCents }, { db });
    res.json(result);
  })
);

app.put(
  '/api/dashboard/drinks/:drinkId',
  requireArchitect,
  ah(async (req, res) => {
    const { name, basePriceCents } = req.body;
    const result = await updateVenueDrink({ drinkProductId: req.params.drinkId, name, basePriceCents }, { db });
    res.json(result);
  })
);

app.delete(
  '/api/dashboard/venues/:venueId/drinks/:drinkId',
  requireArchitect,
  ah(async (req, res) => {
    const result = await removeVenueDrink({ venueId: req.params.venueId, drinkProductId: req.params.drinkId }, { db });
    res.json(result);
  })
);

app.post(
  '/api/dashboard/award-table-spending',
  requireArchitect,
  ah(async (req, res) => {
    const { venueId, tableQrCode, spentCents } = req.body;
    if (!venueId || !tableQrCode || !Number.isInteger(spentCents) || spentCents <= 0) {
      return res.json({ success: false, reason: 'invalid_values' });
    }
    const result = await awardTableSpendingBonusByVenue({ venueId, tableQrCode, spentCents }, deps);
    res.json(result);
  })
);

app.get(
  '/api/dashboard/venues/:venueId/full-settings',
  requireArchitect,
  ah(async (req, res) => {
    const result = await getVenueFullSettings({ venueId: req.params.venueId }, { db });
    res.json(result);
  })
);

app.get(
  '/api/dashboard/commissions',
  requireArchitect,
  ah(async (req, res) => {
    const report = await getCommissionsReport({}, { db });
    res.json({ success: true, report });
  })
);

app.post(
  '/api/dashboard/venues/:venueId/commission',
  requireArchitect,
  ah(async (req, res) => {
    const { commissionVenuePct } = req.body;
    if (!Number.isInteger(commissionVenuePct) || commissionVenuePct < 0 || commissionVenuePct > 100) {
      return res.json({ success: false, reason: 'invalid_percentage' });
    }
    await db.query(`UPDATE venues SET commission_venue_pct = $1 WHERE id = $2`, [
      commissionVenuePct,
      req.params.venueId,
    ]);
    res.json({ success: true });
  })
);

app.post(
  '/api/dashboard/venues/:venueId/pulse-prices',
  requireArchitect,
  ah(async (req, res) => {
    // Prezzo di una Pulse (M11, N1): quello predefinito del locale
    // (da cui nasce ogni serata nuova) e/o quello della serata in
    // corso. Le Pulse già comprate tengono il prezzo pagato.
    const { defaultPriceCents, tonightPriceCents } = req.body;
    const isValidPrice = (v) => Number.isInteger(v) && v >= 50 && v <= 100000;
    if (defaultPriceCents == null && tonightPriceCents == null) {
      return res.json({ success: false, reason: 'price_required' });
    }
    if (
      (defaultPriceCents != null && !isValidPrice(defaultPriceCents)) ||
      (tonightPriceCents != null && !isValidPrice(tonightPriceCents))
    ) {
      return res.json({ success: false, reason: 'invalid_price' });
    }
    if (defaultPriceCents != null) {
      await db.query(`UPDATE venues SET pulse_price_cents = $1 WHERE id = $2`, [defaultPriceCents, req.params.venueId]);
    }
    let tonightUpdated = false;
    if (tonightPriceCents != null) {
      const row = await db.query(
        `
      UPDATE arena_sessions SET pulse_price_cents = $1
      WHERE venue_id = $2 AND closed_at IS NULL AND pulses_expired_at IS NULL AND pulse_deadline > now()
      RETURNING id
    `,
        [tonightPriceCents, req.params.venueId]
      );
      tonightUpdated = !!row;
    }
    res.json({ success: true, tonightUpdated });
  })
);

app.post(
  '/api/dashboard/venues/:venueId/arena-hours',
  requireArchitect,
  ah(async (req, res) => {
    const { openTime, closeTime } = req.body;
    if (!openTime || !closeTime) {
      return res.json({ success: false, reason: 'both_times_required' });
    }
    await db.query(
      `
    UPDATE venues SET default_open_time = $1, default_close_time = $2 WHERE id = $3
  `,
      [openTime, closeTime, req.params.venueId]
    );
    // La chiusura della serata in corso segue l'orario nuovo: è quella
    // in cui scadono le Pulse (M11). Solo se non sono già scadute.
    await db.query(
      `
    UPDATE arena_sessions SET pulse_deadline = pulse_deadline_for(venue_id, session_date), pulse_reminder_sent_at = NULL
    WHERE venue_id = $1 AND closed_at IS NULL AND pulses_expired_at IS NULL
  `,
      [req.params.venueId]
    );
    res.json({ success: true });
  })
);

app.post(
  '/api/purchases/initiate',
  requireOnboarded,
  ah(async (req, res) => {
    const { productId, arenaSessionId, appReturn } = req.body;
    const result = await initiatePurchase(
      { userId: req.userId, productId, arenaSessionId, appReturn: appReturn === true },
      { db }
    );
    res.json(result);
  })
);

app.post(
  '/api/pulses/:pulseId/respond',
  requireOnboarded,
  ah(async (req, res) => {
    const { action } = req.body; // 'accept' | 'reject' | 'ignore'
    const result = await respondToPulse(
      {
        pulseId: req.params.pulseId,
        receiverId: req.userId,
        action,
      },
      deps
    );
    res.json(result);
  })
);

// ------------------------------------------------------------
// REPORT PER I LOCALI (v. populive-venue-insights.js)
// ------------------------------------------------------------
app.get(
  '/api/venues/:venueId/report',
  // Protetto dal 5/11/2026: prima rispondeva a chiunque conoscesse
  // l'indirizzo, con dati commerciali del locale (arrivi, permanenza,
  // drink, presenze, ritorni). Oggi solo gli Architetti; quando i
  // proprietari dei locali avranno un accesso loro, andrà aperto anche
  // a chi gestisce QUEL locale.
  requireArchitect,
  ah(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const result = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
    res.json(result);
  })
);

// ------------------------------------------------------------
// TAVOLO — "Aggancia il tuo tavolo" (bottone dentro l'app, non un
// secondo link/QR esterno — fotocamera nativa dell'app che legge
// il QR fisico sul tavolo e collega la sessione corrente)
// ------------------------------------------------------------
app.post(
  '/api/table/join',
  requireOnboarded,
  ah(async (req, res) => {
    const { tableQrCode, arenaSessionId, wantsToBeConnector } = req.body;
    const result = await joinSquad(
      {
        connectorId: undefined, // lascia decidere a joinSquad in base allo stato del tavolo
        memberId: req.userId,
        arenaSessionId,
        tableQrCode,
        wantsToBeConnector,
      },
      deps
    );
    res.json(result);
  })
);

// PR professionista che gestisce più tavoli (19/9) — si dichiara
// Connector di UN tavolo senza diventarne membro (v.
// claimTableAsProfessionalConnector in populive-connector-engine.js).
// Riservato a chi ha is_professional_connector = true.
app.post(
  '/api/table/claim-as-professional',
  requireOnboarded,
  ah(async (req, res) => {
    const { tableQrCode, arenaSessionId } = req.body;
    const result = await claimTableAsProfessionalConnector(
      {
        connectorId: req.userId,
        arenaSessionId,
        tableQrCode,
      },
      { db }
    );
    res.json(result);
  })
);

// Chiudi/riapri un tavolo (19/9) — solo il suo Connector vero può
// farlo, verificato dentro setTableLock.
app.post(
  '/api/table/lock',
  requireOnboarded,
  ah(async (req, res) => {
    const { tableQrCode, arenaSessionId, locked } = req.body;
    const result = await setTableLock(
      {
        requestingUserId: req.userId,
        arenaSessionId,
        tableQrCode,
        locked: !!locked,
      },
      deps
    );
    res.json(result);
  })
);

// ------------------------------------------------------------
// CLASSIFICHE (locale e globale) — sola lettura, derivate sempre
// dallo stesso points_ledger, mai una tabella separata da tenere
// sincronizzata a mano.
// ------------------------------------------------------------
// Dall'11/11 le classifiche richiedono l'accesso (decisione dell'utente):
// prima nomi e punti erano visibili a chiunque.
app.get(
  '/api/arenas/:arenaSessionId/ranking',
  requireOnboarded,
  ah(async (req, res) => {
    const { hashtag, gender } = req.query;
    const threshold = await checkLocalRankingThreshold({ arenaSessionId: req.params.arenaSessionId }, { db });
    if (threshold.belowThreshold) {
      return res.json({
        success: true,
        belowThreshold: true,
        currentCount: threshold.currentCount,
        minRequired: threshold.minRequired,
        ranking: [],
      });
    }
    const ranking = await getLocalRanking({ arenaSessionId: req.params.arenaSessionId, hashtag, gender }, { db });
    res.json({ success: true, belowThreshold: false, ranking });
  })
);

app.get(
  '/api/ranking/global',
  requireOnboarded,
  ah(async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const { hashtag, gender } = req.query;
    const ranking = await getGlobalRanking({ limit, hashtag, gender }, { db });
    res.json({ success: true, ranking });
  })
);

app.get(
  '/api/users/:userId/ranking-summary',
  requireOnboarded,
  ah(async (req, res) => {
    const { arenaSessionId } = req.query;
    // Chi guarda serve al proprietario, che vede sempre i suoi dati veri.
    const summary = await getUserRankingSummary(
      { userId: req.params.userId, arenaSessionId, viewerId: req.userId },
      { db }
    );
    res.json({ success: true, summary });
  })
);

app.get(
  '/api/users/:userId/welcome-back',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await getWelcomeBackSummary({ userId: req.userId }, { db });
    res.json(result);
  })
);

app.get(
  '/api/dashboard/venue-report/:venueId',
  requireArchitect,
  ah(async (req, res) => {
    // Se non indicate, l'intervallo di default è "ultimi 30 giorni" —
    // abbastanza per un pitch commerciale vero, senza dover
    // specificare nulla la prima volta che si apre il report.
    const toDate = req.query.toDate || new Date().toISOString().slice(0, 10);
    const fromDate = req.query.fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const report = await generateVenueReport({ venueId: req.params.venueId, fromDate, toDate }, { db });
    res.json({ success: true, report, fromDate, toDate });
  })
);

app.get(
  '/api/venues/map',
  ah(async (req, res) => {
    const venues = await getAllVenuesForMap({}, { db });
    res.json({ success: true, venues });
  })
);

app.post(
  '/api/venues/create',
  requireOnboarded,
  ah(async (req, res) => {
    const { name, area, latitude, longitude, venueType, minUsersForLocalRanking } = req.body;
    const result = await createVirtualVenue(
      { name, area, latitude, longitude, venueType, minUsersForLocalRanking },
      { db }
    );
    res.json(result);
  })
);

app.get(
  '/api/feature-flags',
  ah(async (req, res) => {
    // Pubblico, senza login — l'app deve poter sapere cosa mostrare
    // ancora prima che la persona faccia il login (es. nella
    // schermata di ingresso stessa).
    const flags = await db.queryAll(`SELECT feature_key, is_enabled FROM feature_flags`);
    const map = {};
    flags.forEach((f) => {
      map[f.feature_key] = f.is_enabled;
    });
    res.json({ success: true, flags: map });
  })
);

app.post(
  '/api/dashboard/feature-flags/:key',
  requireArchitect,
  ah(async (req, res) => {
    const { isEnabled } = req.body;
    await db.query(`UPDATE feature_flags SET is_enabled = $1 WHERE feature_key = $2`, [!!isEnabled, req.params.key]);
    res.json({ success: true });
  })
);

app.get(
  '/api/venues/popular-now',
  ah(async (req, res) => {
    const venues = await getPopularVenuesNow({}, { db });
    res.json({ success: true, venues });
  })
);

app.get(
  '/api/venues/:venueId/historical-checkins',
  requireOnboarded,
  ah(async (req, res) => {
    const people = await getVenueHistoricalCheckins({ venueId: req.params.venueId, requesterId: req.userId }, { db });
    res.json({ success: true, people });
  })
);

// ------------------------------------------------------------
// RISCATTO REALE AL BANCONE — chiamato dal telefono del CLIENTE
// nel momento in cui il bartender stesso tocca il sigillo attivo
// sul suo schermo. Non serve nessun dispositivo o account separato
// per lo staff: il tocco del bartender sul telefono del cliente è
// insieme la verifica antifrode (il flash dimostra che è dal vivo)
// e la conferma di riscatto — un solo gesto, zero attrito operativo
// per il locale.
// ------------------------------------------------------------
app.post(
  '/api/pulses/:pulseId/redeem',
  // Dal novembre 2026 (M11) serve l'accesso, e la Pulse deve essere di
  // chi la riscatta: prima bastavano id e codice (v. "Sicurezza delle
  // rotte" in SPEC-bug-migliorie.md).
  requireOnboarded,
  ah(async (req, res) => {
    const { redeemCode, venueId } = req.body;

    // Il locale del riscatto è OBBLIGATORIO — e deve corrispondere
    // ESATTAMENTE al locale in cui il Pulse è stato ricevuto: chi lo
    // riceve può ritirarlo SOLO lì, non altrove, e solo entro la
    // chiusura del locale di quella serata (M11, novembre 2026; prima
    // restava ritirabile anche giorni dopo). Uscire e rientrare la
    // stessa sera non la fa perdere.
    if (!venueId) {
      return res.json({ success: false, reason: 'venue_required_for_redeem' });
    }

    const pulse = await db.query(
      `
    SELECT p.*, a.venue_id AS origin_venue_id, a.pulse_deadline > now() AS night_open
    FROM pulses p
    JOIN arena_sessions a ON a.id = p.arena_session_id
    WHERE p.id = $1 AND p.redeem_code = $2 AND p.receiver_id = $3
  `,
      [req.params.pulseId, redeemCode, req.userId]
    );

    if (!pulse) {
      return res.json({ success: false, reason: 'invalid_code_or_already_redeemed' });
    }
    // Scaduta alla chiusura del locale (M11), anche se lo scheduler non
    // l'ha ancora segnata.
    if (pulse.status === 'expired' || (pulse.status === 'accepted' && !pulse.night_open)) {
      return res.json({ success: false, reason: 'pulse_expired' });
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

    await db.query(
      `
    UPDATE pulses SET status = 'redeemed', redeemed_venue_id = $1 WHERE id = $2
  `,
      [venueId, req.params.pulseId]
    );
    res.json({ success: true });
  })
);

// ------------------------------------------------------------
// RISPOSTA A UN SUPERLIKE SEMPLICE — accetta/rifiuta/lascia in sospeso
// ------------------------------------------------------------
app.post(
  '/api/interactions/:interactionId/respond',
  requireOnboarded,
  ah(async (req, res) => {
    const { action } = req.body;
    const result = await respondToSuperlike(
      {
        interactionId: req.params.interactionId,
        receiverId: req.userId,
        action,
      },
      deps
    );
    res.json(result);
  })
);

// ------------------------------------------------------------
// CHAT 1-A-1 — invio e lettura messaggi, sempre solo tra i due
// partecipanti della conversazione
// ------------------------------------------------------------
app.post(
  '/api/chat/:conversationId/messages',
  requireOnboarded,
  ah(async (req, res) => {
    const { body } = req.body;
    const result = await sendMessage(
      {
        conversationId: req.params.conversationId,
        senderId: req.userId,
        body,
      },
      deps
    );
    res.json(result);
  })
);

app.get(
  '/api/users/:userId/active-chats',
  requireOnboarded,
  ah(async (req, res) => {
    // req.userId (dal token), mai quello scritto nell'indirizzo: la
    // risposta include l'anteprima dei messaggi.
    const conversations = await getMyActiveConversations({ userId: req.userId }, deps);
    res.json({ success: true, conversations });
  })
);

app.get(
  '/api/users/:userId/interaction-history',
  requireOnboarded,
  ah(async (req, res) => {
    // Dati sensibili (chi ha mandato cosa a chi) — SOLO il
    // proprietario può vederli, mai un ID scritto a mano nell'indirizzo.
    const history = await getInteractionHistory({ userId: req.userId }, deps);
    res.json({ success: true, history });
  })
);

app.get(
  '/api/users/:userId/pending-received-interactions',
  requireOnboarded,
  ah(async (req, res) => {
    const items = await getPendingReceivedInteractions({ userId: req.userId }, deps);
    res.json({ success: true, items });
  })
);

app.get(
  '/api/users/:userId/sent-interactions-history',
  requireOnboarded,
  ah(async (req, res) => {
    const items = await getSentInteractionsHistory({ userId: req.userId }, deps);
    res.json({ success: true, items });
  })
);

app.get(
  '/api/users/:userId/unseen-like-center-count',
  requireOnboarded,
  ah(async (req, res) => {
    const count = await getUnseenLikeCenterCount({ userId: req.userId }, deps);
    res.json({ success: true, count });
  })
);

app.post(
  '/api/users/:userId/mark-like-center-seen',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await markLikeCenterSeen({ userId: req.userId }, deps);
    res.json(result);
  })
);

app.get(
  '/api/users/:userId/unseen-notification-count',
  requireOnboarded,
  ah(async (req, res) => {
    const count = await getUnseenNotificationCount({ userId: req.userId }, deps);
    res.json({ success: true, count });
  })
);

app.post(
  '/api/users/:userId/mark-notifications-seen',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await markNotificationsSeen({ userId: req.userId }, deps);
    res.json(result);
  })
);

app.post(
  '/api/users/:userId/notifications/dismiss',
  requireOnboarded,
  ah(async (req, res) => {
    const { kind, entryId } = req.body;
    const result = await dismissNotification({ userId: req.userId, kind, entryId }, deps);
    res.json(result);
  })
);

app.post(
  '/api/users/:userId/notifications/clear-all',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await clearAllNotifications({ userId: req.userId }, deps);
    res.json(result);
  })
);

app.post(
  '/api/users/:userId/pulses/:pulseId/dismiss',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await dismissPulseView({ userId: req.userId, pulseId: req.params.pulseId }, deps);
    res.json(result);
  })
);

app.post(
  '/api/users/:userId/pulses/clear-all',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await clearAllPulseViews({ userId: req.userId }, deps);
    res.json(result);
  })
);

app.get(
  '/api/chat/:conversationId/messages',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await getMessages(
      {
        conversationId: req.params.conversationId,
        requesterId: req.userId,
      },
      deps
    );
    res.json(result);
  })
);

app.post(
  '/api/chat/:conversationId/mark-read',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await markConversationRead({ conversationId: req.params.conversationId, userId: req.userId }, deps);
    res.json(result);
  })
);

app.get(
  '/api/users/:userId/unread-chat-count',
  requireOnboarded,
  ah(async (req, res) => {
    const count = await getUnreadChatCount({ userId: req.userId }, deps);
    res.json({ success: true, count });
  })
);

// Elimina la chat solo per chi lo chiede (M4): v. deleteConversationForUser.
app.delete(
  '/api/chat/:conversationId',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await deleteConversationForUser(
      { conversationId: req.params.conversationId, userId: req.userId },
      deps
    );
    res.json(result);
  })
);

app.post(
  '/api/chat/:conversationId/block',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await blockUserInConversation(
      { conversationId: req.params.conversationId, blockerId: req.userId },
      deps
    );
    res.json(result);
  })
);

// ------------------------------------------------------------
// SEGNALAZIONI E BLOCCO (B2, novembre 2026) — v.
// populive-moderation-logic.js
// ------------------------------------------------------------
app.post(
  '/api/reports',
  requireOnboarded,
  ah(async (req, res) => {
    const { reportedUserId, context, conversationId, reason, details } = req.body || {};
    const result = await createReport(
      { reporterId: req.userId, reportedUserId, context, conversationId, reason, details },
      deps
    );
    res.json(result);
  })
);

app.get(
  '/api/blocks',
  requireOnboarded,
  ah(async (req, res) => {
    const blockedUsers = await getBlockedUsers({ userId: req.userId }, deps);
    res.json({ success: true, blockedUsers });
  })
);

app.post(
  '/api/users/:userId/block',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await blockUser({ blockerId: req.userId, blockedId: req.params.userId }, deps);
    res.json(result);
  })
);

app.delete(
  '/api/users/:userId/block',
  requireOnboarded,
  ah(async (req, res) => {
    const result = await unblockUser({ blockerId: req.userId, blockedId: req.params.userId }, deps);
    res.json(result);
  })
);

app.get(
  '/api/dashboard/reports',
  requireArchitect,
  ah(async (req, res) => {
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    res.json(await listReports({ status }, deps));
  })
);

// ------------------------------------------------------------
// BADGE VERIFICATO (lotto 9, 11/11): gratis, selfie con un gesto
// a caso, revisione di un Architetto (populive-verification-logic.js)
// ------------------------------------------------------------
app.get(
  '/api/verification',
  requireOnboarded,
  ah(async (req, res) => {
    res.json(await getVerificationStatus({ userId: req.userId }, deps));
  })
);

app.post(
  '/api/verification/start',
  requireOnboarded,
  ah(async (req, res) => {
    res.json(await startVerification({ userId: req.userId }, deps));
  })
);

app.post(
  '/api/verification/submit',
  requireOnboarded,
  ah(async (req, res) => {
    res.json(await submitVerification({ userId: req.userId, selfieUrl: req.body?.selfieUrl }, deps));
  })
);

app.get(
  '/api/dashboard/verifications',
  requireArchitect,
  ah(async (req, res) => {
    res.json(await listPendingVerifications({}, deps));
  })
);

app.post(
  '/api/dashboard/verifications/:requestId/review',
  requireArchitect,
  ah(async (req, res) => {
    const result = await reviewVerification(
      {
        requestId: req.params.requestId,
        architectId: req.userId,
        approve: req.body?.approve === true,
        rejectReason: req.body?.rejectReason,
      },
      deps
    );
    res.json(result);
  })
);

app.post(
  '/api/dashboard/reports/:reportId/resolve',
  requireArchitect,
  ah(async (req, res) => {
    const result = await resolveReport(
      { reportId: req.params.reportId, architectId: req.userId, action: req.body?.action },
      deps
    );
    res.json(result);
  })
);

app.post(
  '/api/dashboard/users/:userId/unsuspend',
  requireArchitect,
  ah(async (req, res) => {
    res.json(await unsuspendUser({ userId: req.params.userId }, deps));
  })
);

// ------------------------------------------------------------
// IMPOSTAZIONI — richiamabili in ogni momento (a differenza del
// consenso di onboarding, visto una sola volta) per cambiare idea
// liberamente su privacy e autopresentazione.
// ------------------------------------------------------------
app.get(
  '/api/profile/:userId/settings',
  requireOnboarded,
  ah(async (req, res) => {
    // Le tue impostazioni sono tue soltanto — SEMPRE req.userId dal
    // token, mai il pezzo di indirizzo che chiunque potrebbe cambiare
    // a mano per leggere/scrivere le impostazioni di un altro.
    const user = await db.query(
      `
    SELECT show_ranking_on_profile, sponsored_missions_enabled,
           appears_in_historical_search, receive_pulses_enabled, contact_filter,
           ghost_mode_enabled, haptic_notifications_enabled, photo_url, photo_urls
    FROM users WHERE id = $1
  `,
      [req.userId]
    );
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
        hapticNotificationsEnabled: user.haptic_notifications_enabled,
        photoUrl: user.photo_url,
        photoUrls: user.photo_urls || [],
      },
    });
  })
);

app.post(
  '/api/profile/:userId/settings',
  requireOnboarded,
  ah(async (req, res) => {
    const {
      showRankingOnProfile,
      sponsoredMissionsEnabled,
      appearsInHistoricalSearch,
      receivePulsesEnabled,
      contactFilter,
      ghostModeEnabled,
      hapticNotificationsEnabled,
    } = req.body;

    // Stessa protezione qui, ancora più importante: senza questo,
    // chiunque loggato avrebbe potuto RISCRIVERE le impostazioni di
    // un altro utente semplicemente cambiando l'ID nell'indirizzo.
    await db.query(
      `
    UPDATE users SET
      show_ranking_on_profile = $1,
      sponsored_missions_enabled = $2,
      appears_in_historical_search = $3,
      receive_pulses_enabled = $4,
      contact_filter = $5,
      ghost_mode_enabled = $6,
      haptic_notifications_enabled = $7
    WHERE id = $8
  `,
      [
        showRankingOnProfile,
        sponsoredMissionsEnabled,
        appearsInHistoricalSearch,
        receivePulsesEnabled,
        contactFilter,
        ghostModeEnabled,
        hapticNotificationsEnabled,
        req.userId,
      ]
    );

    res.json({ success: true });
  })
);

// ------------------------------------------------------------
// GESTORE DI ERRORI GLOBALE — l'ultimo pezzo del puzzle: qualunque
// errore catturato da "ah()" sopra arriva qui, invece che a Express
// di default (che risponderebbe con una pagina HTML illeggibile
// per il frontend, facendo credere a un problema di rete quando
// invece è un errore interno preciso). Da qui in poi, OGNI errore
// interno arriva al frontend come JSON vero, sempre.
// ------------------------------------------------------------
// eslint-disable-next-line no-unused-vars -- Express riconosce il gestore errori SOLO se ha 4 parametri
app.use((err, req, res, next) => {
  console.error('[errore non gestito]', err);
  res.status(500).json({ success: false, reason: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.info(`PopuLive API in ascolto sulla porta ${PORT}`);
  // Il motore a orari parte insieme al server — gira per sempre in
  // background, controllando ogni pochi minuti se qualche Arena va
  // aperta o chiusa. Nessun intervento manuale necessario da qui in poi.
  startScheduler({ db, redis, io });
  console.info('Motore a orari avviato.');
});
