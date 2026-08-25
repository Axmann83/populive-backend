/**
 * ============================================================
 * POPULIVE — CREAZIONE PROFILO (primo accesso)
 * ============================================================
 * Il flusso previsto, come deciso insieme:
 *   1) Dati base (nome, foto, bio) + hashtag di autotargetizzazione
 *   2) Schermata di consenso (base fissa uguale per tutti + bonus
 *      opzionali) — MAI saltabile
 *   3) Solo dopo aver visto ed espresso una scelta sul consenso,
 *      onboarding_completed diventa true
 *   4) Solo con onboarding_completed = true si può fare check-in
 *      (handleCheckin già scritto NON va toccato: aggiungiamo qui
 *      solo il controllo a monte, prima che quella funzione venga
 *      chiamata dal frontend)
 * ============================================================
 */

const MAX_HASHTAGS_PER_USER = 5; // valore indicativo, evita profili con 40 hashtag che rendono inutile il targeting

// Ora l'utente esiste GIÀ nel database dal momento della verifica
// OTP (solo con il numero di telefono, tutto il resto vuoto) —
// questa funzione AGGIORNA quella riga, non ne crea una nuova.
const ALLOWED_GENDER_VALUES = ['male', 'female', 'other'];

async function createProfile({ userId, displayName, bio, hashtagNames, genderForStats }, { db }) {

  if (!displayName || displayName.trim().length < 2) {
    return { success: false, reason: 'display_name_required' };
  }
  if (hashtagNames && hashtagNames.length > MAX_HASHTAGS_PER_USER) {
    return { success: false, reason: 'too_many_hashtags', max: MAX_HASHTAGS_PER_USER };
  }
  // Facoltativo per davvero: un valore non tra quelli ammessi (o
  // assente) diventa semplicemente NULL, mai un errore che blocca
  // la registrazione — nessuno deve sentirsi obbligato a rispondere.
  const validatedGender = ALLOWED_GENDER_VALUES.includes(genderForStats) ? genderForStats : null;

  const user = await db.query(`
    UPDATE users SET display_name = $1, bio = $2, gender_for_stats = $3
    WHERE id = $4
    RETURNING id
  `, [displayName.trim(), bio || null, validatedGender, userId]);

  if (!user) return { success: false, reason: 'user_not_found' };

  if (hashtagNames && hashtagNames.length > 0) {
    await attachHashtags(user.id, hashtagNames, { db });
  }

  return { success: true, userId: user.id, onboardingCompleted: false };
}

// La foto si carica separatamente (va prima su storage esterno,
// es. S3/Cloudinary, e SOLO l'indirizzo risultante si salva qui).
async function setProfilePhoto({ userId, photoUrl }, { db }) {
  await db.query(`UPDATE users SET photo_url = $1 WHERE id = $2`, [photoUrl, userId]);
  return { success: true };
}

async function attachHashtags(userId, hashtagNames, { db }) {
  for (const rawName of hashtagNames) {
    const name = normalizeHashtag(rawName);
    if (!name) continue;

    // "Trova o crea" l'hashtag — se già esiste (es. altri lo usano
    // già) lo riusiamo, non ne creiamo uno duplicato.
    const hashtag = await db.query(`
      INSERT INTO hashtags (name) VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [name]);

    await db.query(`
      INSERT INTO user_hashtags (user_id, hashtag_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [userId, hashtag.id]);
  }
}

/**
 * ============================================================
 * MODIFICA PROFILO (dopo la registrazione, richiamabile in ogni
 * momento) — a differenza di attachHashtags (usata in fase di
 * registrazione, che si limita ad AGGIUNGERE), qui gli hashtag
 * vengono SOSTITUITI del tutto: se la persona ne toglie uno e
 * salva, deve sparire per davvero, non restare in aggiunta ai
 * nuovi.
 * ============================================================
 */
async function updateProfileDetails({ userId, bio, hashtagNames }, { db }) {
  if (hashtagNames && hashtagNames.length > MAX_HASHTAGS_PER_USER) {
    return { success: false, reason: 'too_many_hashtags', max: MAX_HASHTAGS_PER_USER };
  }

  await db.query(`UPDATE users SET bio = $1 WHERE id = $2`, [bio || null, userId]);

  // Ripartiamo puliti — cancelliamo i collegamenti vecchi prima di
  // scrivere quelli nuovi, così una rimozione vale davvero.
  await db.query(`DELETE FROM user_hashtags WHERE user_id = $1`, [userId]);

  if (hashtagNames && hashtagNames.length > 0) {
    await attachHashtags(userId, hashtagNames, { db });
  }

  return { success: true };
}

function normalizeHashtag(raw) {
  // "Fitness" e "#fitness" e " fitness " devono finire per essere
  // la STESSA riga in tabella, altrimenti il targeting per brand
  // si spezzetta in varianti inutili dello stesso concetto.
  const cleaned = raw.trim().toLowerCase().replace(/^#/, '');
  if (!cleaned || cleaned.length > 30) return null;
  return `#${cleaned}`;
}


// ------------------------------------------------------------
// SCHERMATA DI CONSENSO — il passaggio obbligatorio prima di
// poter usare l'app per davvero (mai saltabile, mai un malus
// per chi sceglie il minimo: solo bonus per chi condivide di più)
// ------------------------------------------------------------
async function completeOnboarding({ userId, consentChoices }, { db }) {
  // consentChoices arriva dal frontend con le scelte esplicite
  // dell'utente sulle opzioni bonus — es:
  // { sponsoredMissionsEnabled: true, appearsInHistoricalSearch: false, ... }
  // più privacyPolicyVersionAccepted/termsVersionAccepted (consenso
  // legale OBBLIGATORIO, verificato lato server prima di procedere —
  // non ci si fida solo del bottone disabilitato nel frontend).

  if (!consentChoices.privacyPolicyVersionAccepted || !consentChoices.termsVersionAccepted) {
    return { success: false, reason: 'legal_consent_missing' };
  }

  await db.query(`
    UPDATE users
    SET onboarding_completed = true,
        sponsored_missions_enabled = $1,
        appears_in_historical_search = $2,
        receive_pulses_enabled = $3,
        contact_filter = $4,
        privacy_policy_version_accepted = $5,
        privacy_policy_accepted_at = now(),
        terms_version_accepted = $6,
        terms_accepted_at = now()
    WHERE id = $7
  `, [
    consentChoices.sponsoredMissionsEnabled ?? false,
    consentChoices.appearsInHistoricalSearch ?? true,
    consentChoices.receivePulsesEnabled ?? true,
    consentChoices.contactFilter ?? 'everyone',
    consentChoices.privacyPolicyVersionAccepted,
    consentChoices.termsVersionAccepted,
    userId,
  ]);

  return { success: true };
}


// ------------------------------------------------------------
// IL "CANCELLO": nessuna azione reale nell'app prima di questo
// ------------------------------------------------------------
// Questa funzione va chiamata all'inizio di OGNI operazione che
// richiede un utente pienamente attivo (check-in, invio Pulse,
// like, superlike...). Non modifica handleCheckin già scritto:
// si inserisce PRIMA, come controllo di accesso.
async function requireCompletedOnboarding(userId, { db }) {
  const user = await db.query(`
    SELECT onboarding_completed FROM users WHERE id = $1
  `, [userId]);

  if (!user) return { allowed: false, reason: 'user_not_found' };
  if (!user.onboarding_completed) return { allowed: false, reason: 'onboarding_incomplete' };
  return { allowed: true };
}


/**
 * ============================================================
 * PROFILO PUBBLICO — quello che vede chi tocca una persona nel
 * radar: foto, nome, hashtag, e i badge di QUESTA sessione
 * (Connector/Spender sono per-serata, Founder è permanente).
 * Volutamente NON include dati privati (numero di telefono,
 * impostazioni, ecc.) — è pensato solo per essere mostrato ad
 * altri utenti.
 * ============================================================
 */
async function getPublicProfile({ userId, arenaSessionId, viewerId }, { db }) {
  const profile = await db.query(`
    SELECT display_name, photo_url, avatar_emoji, bio, instant_influencer_category,
           is_premium, premium_expires_at, is_verified
    FROM users WHERE id = $1
  `, [userId]);

  if (!profile) return { success: false, reason: 'user_not_found' };

  // Verifica in corso — se c'è una richiesta ancora "pending", il
  // frontend deve poterlo sapere per mostrare "in revisione" invece
  // di riproporre il bottone d'acquisto.
  let verificationPending = false;
  if (!profile.is_verified) {
    const pendingRow = await db.query(`
      SELECT 1 FROM verification_requests WHERE user_id = $1 AND status = 'pending'
    `, [userId]);
    verificationPending = !!pendingRow;
  }

  const hashtagRows = await db.queryAll(`
    SELECT h.name FROM hashtags h
    JOIN user_hashtags uh ON uh.hashtag_id = h.id
    WHERE uh.user_id = $1
  `, [userId]);

  // Prodotti sponsorizzati — recuperati solo se il profilo È
  // davvero un Instant Influencer, per non fare una query a vuoto
  // per il 99% dei profili che non lo sono.
  let sponsoredProducts = [];
  if (profile.instant_influencer_category) {
    const productRows = await db.queryAll(`
      SELECT product_name, product_url FROM instant_influencer_products
      WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC
    `, [userId]);
    sponsoredProducts = productRows.map((p) => ({ name: p.product_name, url: p.product_url }));
  }

  let isTopConnector = false;
  let isTopSpender = false;
  if (arenaSessionId) {
    const connectorRow = await db.query(`
      SELECT is_top_connector FROM connector_status
      WHERE user_id = $1 AND arena_session_id = $2
    `, [userId, arenaSessionId]);
    isTopConnector = !!connectorRow?.is_top_connector;

    const spenderRow = await db.query(`
      SELECT is_top_spender FROM spender_status
      WHERE user_id = $1 AND arena_session_id = $2
    `, [userId, arenaSessionId]);
    // Un solo interruttore ("Big Spender" in dashboard) spegne
    // questo dato ovunque nell'app — controllato qui alla lettura,
    // così funziona anche su dati vecchi già in tabella, non solo
    // sulle nuove conferme.
    const bigSpenderFlag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'big_spender'`);
    isTopSpender = (bigSpenderFlag ? bigSpenderFlag.is_enabled : true) && !!spenderRow?.is_top_spender;
  }

  // Un solo interruttore ("Instant Influencer" in dashboard) spegne
  // la pillola dorata ovunque nell'app — stesso principio già usato
  // per il Big Spender: controllato qui alla lettura, così vale sia
  // per la card nel Radar sia per il profilo completo, che passano
  // entrambi da questa stessa funzione.
  const instantInfluencerFlag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'instant_influencer'`);
  const instantInfluencerEnabled = instantInfluencerFlag ? instantInfluencerFlag.is_enabled : true;
  const finalInstantInfluencerCategory = instantInfluencerEnabled ? (profile.instant_influencer_category || null) : null;
  const finalSponsoredProducts = instantInfluencerEnabled ? sponsoredProducts : [];

  const founderRow = await db.query(`SELECT 1 FROM founder_bracelets WHERE user_id = $1`, [userId]);

  // "Ci siamo già incontrati" (25/8, idea nata parlando insieme di
  // cosa succede quando una chat non viene salvata) — solo per la
  // "vera seconda occasione": una chat GIÀ CHIUSA tra queste due
  // persone, mai mentre si sta ancora chattando attivamente (in
  // quel caso sarebbe ridondante, la conversazione è già lì). Se
  // esistono più match passati nel tempo, mostriamo solo il più
  // recente — un piccolo promemoria, non uno storico completo.
  let pastMatch = null;
  if (viewerId && viewerId !== userId) {
    const pastMatchRow = await db.query(`
      SELECT cc.created_at, v.name AS venue_name
      FROM chat_conversations cc
      JOIN arena_sessions a ON a.id = cc.arena_session_id
      JOIN venues v ON v.id = a.venue_id
      WHERE ((cc.user_a_id = $1 AND cc.user_b_id = $2) OR (cc.user_a_id = $2 AND cc.user_b_id = $1))
        AND cc.closed_at IS NOT NULL
      ORDER BY cc.created_at DESC
      LIMIT 1
    `, [userId, viewerId]);
    if (pastMatchRow) {
      pastMatch = { venueName: pastMatchRow.venue_name, matchedAt: pastMatchRow.created_at };
    }
  }

  return {
    success: true,
    profile: {
      userId,
      displayName: profile.display_name,
      photoUrl: profile.photo_url,
      avatarEmoji: profile.avatar_emoji || '🙂',
      isPremium: profile.is_premium || false,
      premiumExpiresAt: profile.premium_expires_at || null,
      isVerified: profile.is_verified || false,
      verificationPending,
      bio: profile.bio,
      hashtags: hashtagRows.map((h) => h.name),
      isTopConnector,
      isTopSpender,
      isFounder: !!founderRow,
      instantInfluencerCategory: finalInstantInfluencerCategory,
      sponsoredProducts: finalSponsoredProducts,
      pastMatch,
    },
  };
}

/**
 * ============================================================
 * INSTANT INFLUENCER — GESTIONE DA DASHBOARD
 * ============================================================
 * Prima si impostava tutto a mano su Supabase — ora dalla scheda
 * Persone della dashboard, stesso miglioramento già fatto per le
 * Missioni sponsorizzate. Resta comunque SOLO nelle mani degli
 * Architetti (nessun pannello per l'utente stesso, serve un vero
 * accordo brand da confermare a mano).
 * ============================================================
 */

/**
 * Trova un utente per numero di telefono — l'unico modo affidabile
 * di identificare con certezza LA persona giusta a cui assegnare lo
 * status (un nome potrebbe non essere univoco).
 */
async function findUserByPhone({ phoneNumber }, { db }) {
  const cleaned = phoneNumber.replace(/[^\d+]/g, '');
  const normalized = cleaned.startsWith('+') ? cleaned : cleaned.startsWith('39') ? `+${cleaned}` : `+39${cleaned}`;

  const user = await db.query(`
    SELECT id, display_name, photo_url, avatar_emoji, instant_influencer_category
    FROM users WHERE phone_number = $1
  `, [normalized]);

  if (!user) return { success: false, reason: 'user_not_found' };

  const productRows = await db.queryAll(`
    SELECT id, product_name, product_url FROM instant_influencer_products
    WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC
  `, [user.id]);

  return {
    success: true,
    user: {
      userId: user.id,
      displayName: user.display_name,
      photoUrl: user.photo_url,
      avatarEmoji: user.avatar_emoji || '🙂',
      instantInfluencerCategory: user.instant_influencer_category,
      products: productRows.map((p) => ({ name: p.product_name, url: p.product_url })),
    },
  };
}

/**
 * Imposta categoria + prodotti sponsorizzati — sostituisce SEMPRE
 * l'intera lista prodotti (più semplice e senza ambiguità che
 * calcolare differenze riga per riga per un elenco così corto).
 * Categoria vuota = toglie del tutto lo status (coerente con
 * l'idea di un accordo che può anche finire).
 */
async function setInstantInfluencerStatus({ userId, category, products }, { db }) {
  await db.query(`UPDATE users SET instant_influencer_category = $1 WHERE id = $2`, [category || null, userId]);

  await db.query(`DELETE FROM instant_influencer_products WHERE user_id = $1`, [userId]);

  if (category && products && products.length > 0) {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!p.name?.trim()) continue;
      await db.query(`
        INSERT INTO instant_influencer_products (user_id, product_name, product_url, sort_order)
        VALUES ($1, $2, $3, $4)
      `, [userId, p.name.trim(), p.url?.trim() || null, i]);
    }
  }

  return { success: true };
}

module.exports = {
  createProfile,
  setProfilePhoto,
  attachHashtags,
  updateProfileDetails,
  completeOnboarding,
  requireCompletedOnboarding,
  getPublicProfile,
  findUserByPhone,
  setInstantInfluencerStatus,
};
