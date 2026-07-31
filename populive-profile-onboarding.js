/**
 * ============================================================
 * POPULIVE — CREAZIONE PROFILO (primo accesso)
 * ============================================================
 */

const MAX_HASHTAGS_PER_USER = 5;

const ALLOWED_GENDER_VALUES = ['male', 'female', 'other'];

async function createProfile({ userId, displayName, bio, hashtagNames, genderForStats }, { db }) {

  if (!displayName || displayName.trim().length < 2) {
    return { success: false, reason: 'display_name_required' };
  }
  if (hashtagNames && hashtagNames.length > MAX_HASHTAGS_PER_USER) {
    return { success: false, reason: 'too_many_hashtags', max: MAX_HASHTAGS_PER_USER };
  }
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
  completeOnboarding,
  requireCompletedOnboarding,
  getPublicProfile,
};
