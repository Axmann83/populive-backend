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
        receive_roses_enabled = $3,
        contact_filter = $4,
        privacy_policy_version_accepted = $5,
        privacy_policy_accepted_at = now(),
        terms_version_accepted = $6,
        terms_accepted_at = now()
    WHERE id = $7
  `, [
    consentChoices.sponsoredMissionsEnabled ?? false,
    consentChoices.appearsInHistoricalSearch ?? true,
    consentChoices.receiveRosesEnabled ?? true,
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
// richiede un utente pienamente attivo (check-in, invio Rosa,
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
async function getPublicProfile({ userId, arenaSessionId }, { db }) {
  const profile = await db.query(`
    SELECT display_name, photo_url, avatar_emoji, bio, instant_influencer_category
    FROM users WHERE id = $1
  `, [userId]);

  if (!profile) return { success: false, reason: 'user_not_found' };

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
    isTopSpender = !!spenderRow?.is_top_spender;
  }

  const founderRow = await db.query(`SELECT 1 FROM founder_bracelets WHERE user_id = $1`, [userId]);

  return {
    success: true,
    profile: {
      userId,
      displayName: profile.display_name,
      photoUrl: profile.photo_url,
      avatarEmoji: profile.avatar_emoji || '🙂',
      bio: profile.bio,
      hashtags: hashtagRows.map((h) => h.name),
      isTopConnector,
      isTopSpender,
      isFounder: !!founderRow,
      instantInfluencerCategory: profile.instant_influencer_category || null,
      sponsoredProducts,
    },
  };
}

module.exports = {
  createProfile,
  setProfilePhoto,
  attachHashtags,
  updateProfileDetails,
  completeOnboarding,
  requireCompletedOnboarding,
  getPublicProfile,
};
