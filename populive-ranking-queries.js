/**
 * ============================================================
 * POPULIVE — LETTURA CLASSIFICHE (locale e globale)
 * ============================================================
 * Finora avevamo scritto solo la logica che GENERA punti
 * (points_ledger). Qui li leggiamo aggregati, in due modi:
 *   - Locale: somma filtrata per una singola arena_session
 *   - Globale: somma di TUTTA la storia di un utente
 * Nessuna tabella "classifica" separata da mantenere sincronizzata:
 * entrambe le viste derivano dalla stessa tabella points_ledger,
 * quindi non possono mai andare "fuori sincrono" tra loro.
 * ============================================================
 */

async function getLocalRanking({ arenaSessionId, hashtag, gender }, { db }) {
  // Stessi filtri facoltativi della classifica globale — utili
  // soprattutto nelle prime serate test, per premiare a fine serata
  // il ragazzo/la ragazza più popolare tra un pubblico specifico
  // (es. #nightlife), o per un accordo con un brand di settore.
  const conditions = [];
  const params = [arenaSessionId];
  let paramIndex = 2;

  let hashtagJoin = '';
  if (hashtag) {
    hashtagJoin = `
      JOIN user_hashtags uh ON uh.user_id = u.id
      JOIN hashtags h ON h.id = uh.hashtag_id AND LOWER(h.name) = LOWER($${paramIndex})
    `;
    params.push(hashtag.replace(/^#/, '').trim());
    paramIndex++;
  }

  if (gender) {
    conditions.push(`u.gender_for_stats = $${paramIndex}`);
    params.push(gender);
    paramIndex++;
  }

  const extraWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  const rows = await db.queryAll(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.avatar_emoji,
      u.photo_url,
      COALESCE(SUM(pl.points), 0) AS local_points,
      cs.is_top_connector,
      ss.is_top_spender
    FROM users u
    ${hashtagJoin}
    LEFT JOIN points_ledger pl
      ON pl.user_id = u.id
      AND pl.arena_session_id = $1
      AND pl.counts_toward_local = true
    LEFT JOIN connector_status cs
      ON cs.user_id = u.id AND cs.arena_session_id = $1
    LEFT JOIN spender_status ss
      ON ss.user_id = u.id AND ss.arena_session_id = $1
    JOIN checkins c
      ON c.user_id = u.id AND c.arena_session_id = $1
    WHERE true ${extraWhere}
    GROUP BY u.id, u.display_name, u.avatar_emoji, u.photo_url, cs.is_top_connector, ss.is_top_spender
    ORDER BY local_points DESC
  `, params);

  // Stesso interruttore condiviso ("Big Spender" in dashboard) — un
  // solo controllo qui invece che dentro ogni riga della query.
  const bigSpenderFlag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'big_spender'`);
  const bigSpenderEnabled = bigSpenderFlag ? bigSpenderFlag.is_enabled : true;

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    displayName: r.display_name,
    avatarEmoji: r.avatar_emoji,
    photoUrl: r.photo_url,
    points: parseInt(r.local_points),
    isTopConnector: !!r.is_top_connector,
    isTopSpender: bigSpenderEnabled && !!r.is_top_spender,
  }));
}

async function getGlobalRanking({ limit = 100, hashtag, gender }, { db }) {
  // Filtri facoltativi — per rispondere a domande tipo "chi è il
  // più in alto tra chi ha #nightlife" o "solo donne". Nessuno dei
  // due è obbligatorio: passati entrambi vuoti, la query si
  // comporta esattamente come prima.
  const conditions = ['u.onboarding_completed = true']; // SEMPRE — mai mostrare righe "fantasma" (es. account pre-creati per Architetti/Founder/test, mai passati dalla registrazione vera)
  const params = [];
  let paramIndex = 1;

  let hashtagJoin = '';
  if (hashtag) {
    hashtagJoin = `
      JOIN user_hashtags uh ON uh.user_id = u.id
      JOIN hashtags h ON h.id = uh.hashtag_id AND LOWER(h.name) = LOWER($${paramIndex})
    `;
    params.push(hashtag.replace(/^#/, '').trim());
    paramIndex++;
  }

  if (gender) {
    conditions.push(`u.gender_for_stats = $${paramIndex}`);
    params.push(gender);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const rows = await db.queryAll(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.avatar_emoji,
      u.photo_url,
      COALESCE(SUM(pl.points), 0) AS global_points,
      fb.user_id IS NOT NULL AS is_founder
    FROM users u
    ${hashtagJoin}
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    LEFT JOIN founder_bracelets fb ON fb.user_id = u.id
    ${whereClause}
    GROUP BY u.id, u.display_name, u.avatar_emoji, u.photo_url, fb.user_id
    ORDER BY global_points DESC
    LIMIT $${paramIndex}
  `, params);

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    displayName: r.display_name,
    avatarEmoji: r.avatar_emoji,
    photoUrl: r.photo_url,
    points: parseInt(r.global_points),
    isFounder: r.is_founder,
  }));
}

/**
 * Posizione e punti di UN utente specifico — utile per mostrare
 * "tu sei #4" senza dover scaricare tutta la classifica quando
 * serve solo il proprio piazzamento (es. nella scheda profilo).
 * Usa query mirate (non scansiona l'intera classifica), quindi
 * resta veloce anche con centinaia di migliaia di utenti.
 */
async function getUserRankingSummary({ userId, arenaSessionId, viewerId }, { db }) {
  // Foto e nome servono sempre, a prescindere dal toggle di
  // autopresentazione (quello riguarda solo i NUMERI di classifica,
  // non l'identità visiva del profilo).
  const profile = await db.query(`SELECT display_name, photo_url, avatar_emoji FROM users WHERE id = $1`, [userId]);
  const displayName = profile?.display_name || null;
  const photoUrl = profile?.photo_url || null;
  const avatarEmoji = profile?.avatar_emoji || '🙂';

  // Se chi guarda non è il proprietario del profilo, rispettiamo la
  // sua scelta di autopresentazione — se ha disattivato la visibilità,
  // restituiamo un risultato "nascosto" invece dei numeri veri.
  if (viewerId && viewerId !== userId) {
    const prefs = await db.query(`SELECT show_ranking_on_profile FROM users WHERE id = $1`, [userId]);
    if (prefs && prefs.show_ranking_on_profile === false) {
      return { hidden: true, localRank: null, localPoints: null, globalRank: null, globalPoints: null, displayName, photoUrl, avatarEmoji };
    }
  }

  // Se non c'è ancora una sessione Arena (utente non ha fatto
  // check-in stasera), non ha senso interrogare la classifica
  // locale — passare una stringa vuota a una colonna UUID
  // manderebbe il database in errore. Saltiamo direttamente ai
  // dati globali, che esistono sempre.
  const hasValidSession = arenaSessionId && arenaSessionId.length > 0;

  let localPoints = 0;
  let localRankRow = { rank: null };
  if (hasValidSession) {
    const localPointsRow = await db.query(`
      SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
      WHERE user_id = $1 AND arena_session_id = $2 AND counts_toward_local = true
    `, [userId, arenaSessionId]);
    localPoints = parseInt(localPointsRow.total) || 0;

    localRankRow = await db.query(`
      SELECT COUNT(*) + 1 AS rank
      FROM (
        SELECT user_id, SUM(points) AS pts
        FROM points_ledger
        WHERE arena_session_id = $1 AND counts_toward_local = true
        GROUP BY user_id
        HAVING SUM(points) > $2
      ) higher_ranked
    `, [arenaSessionId, localPoints]);
  }

  const globalPointsRow = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE user_id = $1
  `, [userId]);
  const globalPoints = parseInt(globalPointsRow.total) || 0;

  const globalRankRow = await db.query(`
    SELECT COUNT(*) + 1 AS rank
    FROM (
      SELECT user_id, SUM(points) AS pts
      FROM points_ledger
      GROUP BY user_id
      HAVING SUM(points) > $1
    ) higher_ranked
  `, [globalPoints]);

  return {
    hidden: false,
    localRank: hasValidSession && localPoints > 0 ? parseInt(localRankRow.rank) : null,
    localPoints,
    globalRank: globalPoints > 0 ? parseInt(globalRankRow.rank) : null,
    globalPoints,
    displayName,
    photoUrl,
    avatarEmoji,
  };
}

/**
 * ============================================================
 * "BENTORNATO" — cosa è successo da quando la persona non
 * guardava l'app. Confronta lo stato attuale con l'ultima visita
 * registrata (users.last_seen_at), poi AGGIORNA quel timestamp a
 * ora — così la prossima volta il confronto riparte da qui, non
 * si accumula all'infinito.
 * ============================================================
 */
async function getWelcomeBackSummary({ userId }, { db }) {
  const user = await db.query(`SELECT last_seen_at FROM users WHERE id = $1`, [userId]);
  if (!user) return { success: false, reason: 'user_not_found' };

  const since = user.last_seen_at;

  const pointsRow = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
    WHERE user_id = $1 AND created_at > $2
  `, [userId, since]);
  const pointsEarned = parseInt(pointsRow.total) || 0;

  const newLikes = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'like' AND created_at > $2
  `, [userId, since]);

  const newSuperlikes = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'superlike' AND created_at > $2
  `, [userId, since]);

  const newPulses = await db.query(`
    SELECT COUNT(*) FROM pulses
    WHERE receiver_id = $1 AND created_at > $2
  `, [userId, since]);

  // Aggiorniamo ORA, non prima di aver letto tutto — altrimenti il
  // confronto sopra userebbe già il nuovo timestamp invece di quello
  // vero dell'ultima visita.
  await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);

  const hasNews = pointsEarned > 0 || newLikes > 0 || newSuperlikes > 0 || newPulses > 0;

  return {
    success: true,
    hasNews,
    pointsEarned,
    newLikes: parseInt(newLikes) || 0,
    newSuperlikes: parseInt(newSuperlikes) || 0,
    newPulses: parseInt(newPulses) || 0,
  };
}


/**
 * ============================================================
 * RICERCA PER HASHTAG — DASHBOARD ARCHITETTI
 * ============================================================
 * Estrae dalla classifica generale tutte le persone con un
 * determinato hashtag (es. "pr"), ordinate per punti — pensata
 * per fornire persone vere ai locali/brand che le richiedono (es.
 * "ci servono PR bravi a muovere gente"). A differenza della
 * classifica normale, include anche il numero di telefono — solo
 * qui, solo per gli Architetti, solo per poter davvero contattare
 * chi ha scelto di rendersi trovabile con quell'hashtag.
 * ============================================================
 */
async function searchUsersByHashtag({ hashtag, limit = 50 }, { db }) {
  const rows = await db.queryAll(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.phone_number,
      u.photo_url,
      u.avatar_emoji,
      u.is_verified,
      COALESCE(SUM(pl.points), 0) AS global_points,
      COALESCE(bool_or(cs.is_top_connector), false) AS was_ever_top_connector
    FROM users u
    JOIN user_hashtags uh ON uh.user_id = u.id
    JOIN hashtags h ON h.id = uh.hashtag_id AND LOWER(h.name) = LOWER($1)
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    LEFT JOIN connector_status cs ON cs.user_id = u.id
    WHERE u.onboarding_completed = true
    GROUP BY u.id, u.display_name, u.phone_number, u.photo_url, u.avatar_emoji, u.is_verified
    ORDER BY global_points DESC
    LIMIT $2
  `, [hashtag.replace(/^#/, '').trim(), limit]);

  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    phoneNumber: r.phone_number,
    photoUrl: r.photo_url,
    avatarEmoji: r.avatar_emoji || '🙂',
    isVerified: r.is_verified,
    isTopConnector: !!r.was_ever_top_connector,
    globalPoints: parseInt(r.global_points),
  }));
}

/**
 * SOGLIA MINIMA PER LA CLASSIFICA LOCALE — separata apposta da
 * getLocalRanking (che restituisce un semplice array, mai voluto
 * mescolare le due forme di risposta). Sotto soglia, meglio nessuna
 * classifica che una con una sola persona (demotivante) — ma questo
 * NON tocca in nessun modo Radar, interazioni o punti, che restano
 * identici (i punti vanno comunque alla classifica generale).
 */
async function checkLocalRankingThreshold({ arenaSessionId }, { db }) {
  const venueRow = await db.query(`
    SELECT v.min_users_for_local_ranking
    FROM arena_sessions a JOIN venues v ON v.id = a.venue_id
    WHERE a.id = $1
  `, [arenaSessionId]);
  const minRequired = venueRow?.min_users_for_local_ranking ?? 5;

  const checkinCountRow = await db.query(`
    SELECT COUNT(DISTINCT user_id) AS count FROM checkins WHERE arena_session_id = $1
  `, [arenaSessionId]);
  const currentCount = parseInt(checkinCountRow?.count) || 0;

  return { belowThreshold: currentCount < minRequired, currentCount, minRequired };
}

module.exports = { getLocalRanking, getGlobalRanking, getUserRankingSummary, getWelcomeBackSummary, searchUsersByHashtag, checkLocalRankingThreshold };
