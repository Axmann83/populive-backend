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
 * ============================================================
 */

const MAX_HASHTAGS_PER_USER = 5;

// Ora l'utente esiste GIÀ nel database dal momento della verifica
// OTP (solo con il numero di telefono, tutto il resto vuoto) —
// questa funzione AGGIORNA quella riga, non ne crea una nuova.
async function createProfile({ userId, displayName, bio, hashtagNames }, { db }) {

  if (!displayName || displayName.trim().length < 2) {
    return { success: false, reason: 'display_name_required' };
  }
  if (hashtagNames && hashtagNames.length > MAX_HASHTAGS_PER_USER) {
    return { success: false, reason: 'too_many_hashtags', max: MAX_HASHTAGS_PER_USER };
  }

  const user = await db.query(`
    UPDATE users SET display_name = $1, bio = $2
    WHERE id = $3
    RETURNING id
  `, [displayName.trim(), bio || null, userId]);

  if (!user) return { success: false, reason: 'user_not_found' };

  if (hashtagNames && hashtagNames.length > 0) {
    await attachHashtags(user.id, hashtagNames, { db });
  }

  return { success: true, userId: user.id, onboardingCompleted: false };
}

async function setProfilePhoto({ userId, photoUrl }, { db }) {
  await db.query(`UPDATE users SET photo_url = $1 WHERE id = $2`, [photoUrl, userId]);
  return { success: true };
}

async function attachHashtags(userId, hashtagNames, { db }) {
  for (const rawName of hashtagNames) {
    const name = normalizeHashtag(rawName);
    if (!name) continue;

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

function normalizeHashtag(raw) {
  const cleaned = raw.trim().toLowerCase().replace(/^#/, '');
  if (!cleaned || cleaned.length > 30) return null;
  return `#${cleaned}`;
}


async function completeOnboarding({ userId, consentChoices }, { db }) {
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


async function requireCompletedOnboarding(userId, { db }) {
  const user = await db.query(`
    SELECT onboarding_completed FROM users WHERE id = $1
  `, [userId]);

  if (!user) return { allowed: false, reason: 'user_not_found' };
  if (!user.onboarding_completed) return { allowed: false, reason: 'onboarding_incomplete' };
  return { allowed: true };
}

module.exports = {
  createProfile,
  setProfilePhoto,
  attachHashtags,
  completeOnboarding,
  requireCompletedOnboarding,
};
