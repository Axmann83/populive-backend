/**
 * ============================================================
 * POPULIVE — TOP CONNECTOR
 * ============================================================
 * Due motori, come da documento originale, entrambi SEMPRE
 * scoped alla singola arena_session — nessun vantaggio permanente.
 *
 *   A) Motore Fisico: Squad via QR — i punti dei membri si
 *      riflettono (in parte) al Connector.
 *   B) Motore Algoritmico: il Connector "scopre" un profilo con
 *      un voto; se quel profilo esplode entro una finestra di
 *      tempo, arriva un bonus retroattivo — QUESTO richiede un
 *      job schedulato reale, non è "una colonna in più" come
 *      stimato nel documento originale.
 * ============================================================
 */

const { awardPoints, BASE_POINTS } = require('./populive-points-engine');
const { ORGANIC_REFERENCE_SOURCES_SQL } = require('./populive-ranking-cap');

const SQUAD_REFLECTION_SHARE = 0.15; // quanto dei punti di un membro si riflette al Connector
const DISCOVERY_WINDOW_HOURS = 2;
const DISCOVERY_SURGE_THRESHOLD = 20; // punti guadagnati dal "discovered" per considerarlo un'esplosione
const CONNECTOR_TOP_PERCENTILE = 0.05; // top 5% dell'Arena
const SPENDER_TOP_PERCENTILE = 0.05;   // stesso principio, per la spesa al tavolo


// ------------------------------------------------------------
// TOP SPENDER — stesso principio del Top Connector: calcolato
// PER SESSIONE, mai un badge permanente. Si basa sui punti che
// arrivano da 'table_spending_threshold' in QUESTA arena_session.
// ------------------------------------------------------------
async function recalculateTopSpenders(arenaSessionId, { db }) {
  await db.query(`
    WITH spending_totals AS (
      SELECT user_id, SUM(points) AS spend_points
      FROM points_ledger
      WHERE arena_session_id = $1 AND source = 'table_spending_threshold'
      GROUP BY user_id
    ),
    ranked AS (
      SELECT user_id, PERCENT_RANK() OVER (ORDER BY spend_points DESC) AS pct
      FROM spending_totals
    )
    INSERT INTO spender_status (user_id, arena_session_id, is_top_spender)
    SELECT user_id, $1, (pct <= $2) FROM ranked
    ON CONFLICT (user_id, arena_session_id)
    DO UPDATE SET is_top_spender = EXCLUDED.is_top_spender
  `, [arenaSessionId, SPENDER_TOP_PERCENTILE]);
}

/**
 * Un solo punto di verità per l'interruttore "Big Spender" —
 * usato qui e negli altri due posti che calcolano isTopSpender
 * (populive-profile-onboarding.js, populive-ranking-queries.js),
 * così un solo interruttore in dashboard lo spegne ovunque nell'app
 * senza dover toccare quei file uno per uno.
 */
async function isBigSpenderEnabled({ db }) {
  const flag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'big_spender'`);
  return flag ? flag.is_enabled : true; // se manca la riga, di default acceso
}

async function getSpenderStatus({ userId, arenaSessionId }, { db }) {
  if (!(await isBigSpenderEnabled({ db }))) return { isTopSpender: false };
  const row = await db.query(`
    SELECT is_top_spender FROM spender_status
    WHERE user_id = $1 AND arena_session_id = $2
  `, [userId, arenaSessionId]);
  return { isTopSpender: row ? row.is_top_spender : false };
}

/**
 * Stesso identico principio di isBigSpenderEnabled qui sopra, per
 * coerenza voluta esplicitamente in dashboard — un solo interruttore
 * ("Top Connector" in dashboard) spegne il Motore Fisico (riflesso
 * punti Squad via QR) e il Motore Algoritmico (bonus scoperta) ovunque
 * nell'app, oltre al badge stesso in classifica/profilo (v. gli stessi
 * controlli duplicati in populive-ranking-queries.js,
 * populive-profile-onboarding.js e populive-points-engine.js — stesso
 * schema replicato di Big Spender, non un'unica funzione condivisa,
 * per evitare un giro di dipendenze circolari con questo file).
 */
async function isTopConnectorEnabled({ db }) {
  const flag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'top_connector'`);
  return flag ? flag.is_enabled : true; // se manca la riga, di default acceso (comportamento identico a oggi)
}


// ------------------------------------------------------------
// A) MOTORE FISICO — Squad via QR
// ------------------------------------------------------------

/**
 * Chi è OGGI il Connector di questo tavolo, guardando le DUE fonti
 * possibili (19/9) — mai una sola:
 *   1) table_connector_assignments — un PR PROFESSIONISTA può essersi
 *      pre-assegnato il tavolo prima ancora che arrivi il primo
 *      membro (v. claimTableAsProfessionalConnector sotto). Se
 *      esiste una riga qui, vince SEMPRE — nessun "primo che
 *      scansiona" può scavalcarla.
 *   2) squad_memberships — il comportamento "spontaneo" di sempre:
 *      il primo membro che ha accettato di diventare Connector.
 * Usata sia da joinSquad (per sapere a chi riflettere i punti) sia
 * da setTableLock (per verificare che chi blocca il tavolo sia
 * davvero il suo Connector).
 */
async function resolveTableConnectorId({ arenaSessionId, tableQrCode }, { db }) {
  const assigned = await db.query(`
    SELECT connector_id FROM table_connector_assignments
    WHERE arena_session_id = $1 AND table_qr_code = $2
  `, [arenaSessionId, tableQrCode]);
  if (assigned) return assigned.connector_id;

  const viaSquad = await db.query(`
    SELECT connector_id FROM squad_memberships
    WHERE arena_session_id = $1 AND table_qr_code = $2 AND connector_id IS NOT NULL
    LIMIT 1
  `, [arenaSessionId, tableQrCode]);
  return viaSquad ? viaSquad.connector_id : null;
}

async function joinSquad({ connectorId, memberId, arenaSessionId, tableQrCode, wantsToBeConnector }, { db, redis }) {
  if (connectorId === memberId) return { success: false, reason: 'cannot_join_own_squad' };

  // Tavolo chiuso dal suo Connector (19/9, idea dell'utente — evita
  // che chi passa semplicemente vicino al tavolo dopo che il gruppo
  // vero si è già formato possa infilarsi a prendere una fetta dei
  // bonus di squadra): nessun nuovo ingresso finché non viene
  // riaperto, chi era già dentro non viene toccato.
  if (tableQrCode && await isTableLocked({ arenaSessionId, tableQrCode }, { redis })) {
    return { success: false, reason: 'table_locked' };
  }

  // Se questo tavolo ha GIÀ un Connector confermato (qualcuno prima
  // ha risposto sì, oppure un PR professionista se lo è pre-assegnato
  // — v. resolveTableConnectorId sopra), si eredita — nessuna nuova
  // domanda per chi arriva dopo. MA se il tavolo esiste già senza un
  // Connector (il primo arrivato ha detto no, o semplicemente nessuno
  // l'ha ancora reclamato), il posto resta APERTO: chi arriva dopo può
  // ancora dire sì e diventare Connector (19/9, corretto un limite del
  // primo design — prima solo il PRIMISSIMO che scansionava aveva la
  // possibilità di scegliere, una pura questione di chi tira fuori
  // il telefono più in fretta, non di chi è davvero disposto a farlo).
  // Chi lo reclama in un secondo momento "adotta" anche chi si era
  // già agganciato prima di lui, aggiornando le loro righe.
  let resolvedConnectorId = connectorId;
  if (tableQrCode && resolvedConnectorId === undefined) {
    const currentConnectorId = await resolveTableConnectorId({ arenaSessionId, tableQrCode }, { db });

    if (currentConnectorId) {
      resolvedConnectorId = currentConnectorId;
    } else if (wantsToBeConnector) {
      // Nessuno ha ancora reclamato il ruolo per questo tavolo (primo
      // arrivo in assoluto, oppure chi è arrivato prima ha detto no)
      // — non serve essere GIÀ Top Connector: lo status vero (badge,
      // voto x1.5) arriva più tardi se i punti accumulati bastano,
      // questo è solo il momento in cui SCEGLIE di provarci.
      resolvedConnectorId = memberId;
      // Se il tavolo esisteva già ma senza Connector, chi arriva ora
      // e dice sì "adotta" retroattivamente chi si era già agganciato
      // prima di lui — la UPDATE non trova nulla da fare (nessun
      // effetto) se non esisteva ancora nessuna riga per il tavolo,
      // quindi è sicura da lanciare sempre, senza controllare prima.
      await db.query(`
        UPDATE squad_memberships SET connector_id = $1
        WHERE arena_session_id = $2 AND table_qr_code = $3 AND connector_id IS NULL
      `, [memberId, arenaSessionId, tableQrCode]);
    }
    // Se non esiste ancora nessuna riga per questo tavolo e questo
    // arrivo dice "no", resolvedConnectorId resta vuoto — il tavolo
    // aspetta semplicemente che arrivi qualcuno che dica sì.
  }

  await db.query(`
    INSERT INTO squad_memberships (connector_id, member_id, arena_session_id, table_qr_code)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (member_id, arena_session_id) DO NOTHING
  `, [resolvedConnectorId || null, memberId, arenaSessionId, tableQrCode || null]);

  return {
    success: true,
    linkedToConnector: !!resolvedConnectorId,
    // A chi ha appena chiesto di diventare Connector serve sapere se
    // ci è VERAMENTE riuscito (es. per mostrargli il bottone "chiudi
    // il tavolo") — linkedToConnector da solo non basta, è true anche
    // per un membro qualunque che ha semplicemente ereditato il
    // Connector di qualcun altro.
    isConnector: !!resolvedConnectorId && resolvedConnectorId === memberId,
  };
}

/**
 * ============================================================
 * PR PROFESSIONISTA — CONNECTOR DI PIÙ TAVOLI (19/9, idea dell'utente)
 * ============================================================
 * Un PR di professione gestisce spesso più tavoli nella stessa
 * serata — non ha senso obbligarlo a "sedersi" fisicamente a uno
 * solo di essi per poterne essere il Connector (era l'unico modo
 * possibile finora, per via dell'UNIQUE (member_id, arena_session_id)
 * su squad_memberships: un utente può comparire come MEMBRO di una
 * sola squad a sera).
 *
 * Qui si separano le due cose: questa funzione lo rende Connector di
 * un tavolo SENZA inserire nessuna riga con lui come membro — resta
 * fuori dal conteggio punti organici di quel tavolo (non genera lui
 * stesso interazioni sedendosi lì), ma i bonus da Connector (riflesso
 * squadra 15%, Talent Scout) continuano ad arrivargli normalmente,
 * perché quelle query leggono sempre connector_id da squad_memberships
 * — che qui viene risolto tramite resolveTableConnectorId sopra,
 * senza nessuna modifica a quelle query.
 *
 * Riservata a chi ha is_professional_connector = true — un flag
 * settabile SOLO da dashboard (mai auto-attivabile), per evitare che
 * chiunque si dichiari "PR" di dieci tavoli diversi solo per fare
 * incetta di bonus.
 * ============================================================
 */
async function claimTableAsProfessionalConnector({ connectorId, arenaSessionId, tableQrCode }, { db }) {
  const user = await db.query(`SELECT is_professional_connector FROM users WHERE id = $1`, [connectorId]);
  if (!user || !user.is_professional_connector) {
    return { success: false, reason: 'not_a_professional_connector' };
  }

  // Se il tavolo ha già un Connector "spontaneo" (un amico del
  // gruppo ha già accettato scansionando fisicamente), quella scelta
  // resta valida — un PR arrivato dopo non può scavalcarla.
  const existingSquadConnector = await db.query(`
    SELECT connector_id FROM squad_memberships
    WHERE arena_session_id = $1 AND table_qr_code = $2 AND connector_id IS NOT NULL
    LIMIT 1
  `, [arenaSessionId, tableQrCode]);
  if (existingSquadConnector) {
    return { success: false, reason: 'table_already_has_a_connector' };
  }

  const inserted = await db.query(`
    INSERT INTO table_connector_assignments (arena_session_id, table_qr_code, connector_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (arena_session_id, table_qr_code) DO NOTHING
    RETURNING connector_id
  `, [arenaSessionId, tableQrCode, connectorId]);

  if (!inserted) {
    return { success: false, reason: 'table_already_assigned' };
  }

  return { success: true };
}

/**
 * ============================================================
 * BLOCCO TAVOLO (19/9, idea dell'utente)
 * ============================================================
 * Stato VIVO di sessione, non permanente — stesso principio già
 * usato per radar/contatore check-in (Redis, mai Postgres), sparisce
 * da solo a fine serata con il resto (v. closeSessionIfOpen in
 * populive-scheduler.js). Un Set per sessione (arena:<id>:locked_tables)
 * invece di una chiave per tavolo, per poterlo ripulire con un solo
 * DEL a fine serata senza dover conoscere in anticipo quanti tavoli
 * sono stati bloccati.
 * Solo il Connector VERO del tavolo (spontaneo o PR pre-assegnato,
 * v. resolveTableConnectorId) può bloccarlo/sbloccarlo — mai un
 * membro qualunque.
 * ============================================================
 */
async function isTableLocked({ arenaSessionId, tableQrCode }, { redis }) {
  if (!tableQrCode || !redis) return false;
  return !!(await redis.sismember(`arena:${arenaSessionId}:locked_tables`, tableQrCode));
}

async function setTableLock({ requestingUserId, arenaSessionId, tableQrCode, locked }, { db, redis }) {
  const currentConnectorId = await resolveTableConnectorId({ arenaSessionId, tableQrCode }, { db });
  if (!currentConnectorId || currentConnectorId !== requestingUserId) {
    return { success: false, reason: 'not_the_table_connector' };
  }

  if (locked) {
    await redis.sadd(`arena:${arenaSessionId}:locked_tables`, tableQrCode);
  } else {
    await redis.srem(`arena:${arenaSessionId}:locked_tables`, tableQrCode);
  }

  return { success: true, locked };
}

/**
 * Va chiamata OGNI VOLTA che un membro di una squad guadagna punti
 * (like/superlike/pulse ricevuti, spesa) — riflette una quota al
 * Connector della sua squad, se ne ha una per questa sessione.
 */
async function reflectPointsToConnector({ memberId, arenaSessionId, memberPointsEarned }, { db, io }) {
  if (!(await isTopConnectorEnabled({ db }))) {
    return { reflected: false, reason: 'top_connector_disabled' };
  }

  const membership = await db.query(`
    SELECT connector_id FROM squad_memberships
    WHERE member_id = $1 AND arena_session_id = $2
  `, [memberId, arenaSessionId]);

  if (!membership) return { reflected: false };

  const reflectedPoints = Math.round(memberPointsEarned * SQUAD_REFLECTION_SHARE);
  if (reflectedPoints <= 0) return { reflected: false };

  await db.query(`
    INSERT INTO points_ledger (user_id, arena_session_id, points, source)
    VALUES ($1, $2, $3, 'squad_reflection')
  `, [membership.connector_id, arenaSessionId, reflectedPoints]);

  await updateContributionPoints({ userId: membership.connector_id, arenaSessionId, delta: reflectedPoints }, { db });

  io.to(`arena_${arenaSessionId}`).emit('points_update', {
    userId: membership.connector_id,
    points: reflectedPoints,
    source: 'squad_reflection',
  });

  return { reflected: true, reflectedPoints };
}


// ------------------------------------------------------------
// B) MOTORE ALGORITMICO — scoperta predittiva
// ------------------------------------------------------------
/**
 * Chiamata quando un utente con status Connector (per questa
 * sessione) invia un like/Pulse a qualcuno — piazza il "marker".
 * La valutazione vera avviene più tardi, nel job schedulato.
 */
async function placeDiscoveryMarker({ connectorId, discoveredUserId, arenaSessionId }, { db }) {
  if (!(await isTopConnectorEnabled({ db }))) {
    return { placed: false, reason: 'top_connector_disabled' };
  }

  const status = await getConnectorStatus({ userId: connectorId, arenaSessionId }, { db });
  if (!status.isTopConnector) return { placed: false, reason: 'not_a_connector_this_session' };

  const currentPoints = await getLocalPoints({ userId: discoveredUserId, arenaSessionId }, { db });

  await db.query(`
    INSERT INTO connector_discovery_markers
      (connector_id, discovered_user_id, arena_session_id, points_at_vote_time)
    VALUES ($1, $2, $3, $4)
  `, [connectorId, discoveredUserId, arenaSessionId, currentPoints]);

  return { placed: true };
}

/**
 * IL JOB SCHEDULATO — va eseguito periodicamente (es. ogni 15
 * minuti) da un worker separato, non dentro una richiesta HTTP.
 * Controlla tutti i marker più vecchi della finestra di tempo e
 * non ancora valutati, assegna il bonus se il profilo è "esploso".
 */
async function evaluatePendingDiscoveryMarkers({ db, io }) {
  const cutoff = new Date(Date.now() - DISCOVERY_WINDOW_HOURS * 60 * 60 * 1000);

  const pendingMarkers = await db.queryAll(`
    SELECT * FROM connector_discovery_markers
    WHERE evaluated_at IS NULL AND created_at <= $1
  `, [cutoff]);

  // Letto una sola volta per l'intero giro del job, non per ogni
  // marker — se qualcuno lo riaccende A METÀ esecuzione, il giro in
  // corso resta coerente con lo stato letto all'inizio, i marker
  // restanti verranno rivalutati al giro successivo (ogni 15 minuti).
  const topConnectorEnabled = await isTopConnectorEnabled({ db });

  for (const marker of pendingMarkers) {
    const currentPoints = await getLocalPoints(
      { userId: marker.discovered_user_id, arenaSessionId: marker.arena_session_id }, { db }
    );
    const surge = currentPoints - marker.points_at_vote_time;
    // Se il Top Connector è spento dalla dashboard, il marker viene
    // comunque segnato come valutato (niente coda che si accumula in
    // silenzio), semplicemente senza mai assegnare il bonus.
    const didSurge = topConnectorEnabled && surge >= DISCOVERY_SURGE_THRESHOLD;

    if (didSurge) {
      await awardPoints({
        receiverId: marker.connector_id,
        arenaSessionId: marker.arena_session_id,
        source: 'connector_discovery_bonus',
      }, { db, io });
      // NOTA: awardPoints usa BASE_POINTS per source — per un valore
      // dedicato, aggiungere la relativa voce a BASE_POINTS nel
      // motore punti invece di duplicare qui la scrittura sul ledger.
    }

    await db.query(`
      UPDATE connector_discovery_markers
      SET evaluated_at = now(), bonus_awarded = $1
      WHERE id = $2
    `, [didSurge, marker.id]);
  }

  return { evaluated: pendingMarkers.length };
}


/**
 * ============================================================
 * BONUS "TALENT SCOUT" DI FINE SERATA (17/9, idea dell'utente)
 * ============================================================
 * Non è uno dei due motori del documento originale — è un TERZO
 * bonus, pensato apposta per il pitch con i PR/locali: quando
 * l'Arena chiude, i Connector dei TRE TAVOLI DIVERSI che hanno in
 * squadra la persona più popolare della serata prendono un bonus
 * decrescente (1°/2°/3° posto). "Tavoli diversi" per costruzione:
 * per ogni Connector conta SOLO il suo membro più popolare, così uno
 * stesso Connector non può vincere due volte solo perché in squadra
 * ha sia il 1° che il 4° più popolare — libera il posto per il tavolo
 * successivo davvero diverso.
 *
 * Va chiamata UNA VOLTA, quando l'Arena chiude per la notte (v.
 * populive-scheduler.js, closeSessionIfOpen) — mai durante la serata,
 * altrimenti "chi è il più popolare" cambierebbe in corsa e lo stesso
 * Connector potrebbe incassare il bonus più volte.
 * ============================================================
 */
const TOP_TALENT_BONUS_SOURCES = ['connector_top_talent_1', 'connector_top_talent_2', 'connector_top_talent_3'];

async function awardTopTalentBonuses(arenaSessionId, { db, io }) {
  if (!(await isTopConnectorEnabled({ db }))) return { awarded: 0 };

  // Per ogni Connector, il punteggio del suo membro più popolare
  // (DISTINCT ON connector_id, ordinato per punti) — poi i primi 3
  // Connector per quel valore, in ordine.
  const topThree = await db.queryAll(`
    WITH member_points AS (
      SELECT sm.connector_id, sm.member_id, COALESCE(SUM(pl.points), 0) AS points
      FROM squad_memberships sm
      LEFT JOIN points_ledger pl
        ON pl.user_id = sm.member_id AND pl.arena_session_id = sm.arena_session_id AND pl.counts_toward_local = true
      WHERE sm.arena_session_id = $1 AND sm.connector_id IS NOT NULL
      GROUP BY sm.connector_id, sm.member_id
    ),
    best_per_connector AS (
      SELECT DISTINCT ON (connector_id) connector_id, member_id, points
      FROM member_points
      ORDER BY connector_id, points DESC
    )
    SELECT connector_id, member_id, points
    FROM best_per_connector
    ORDER BY points DESC
    LIMIT 3
  `, [arenaSessionId]);

  for (let i = 0; i < topThree.length; i++) {
    await awardPoints({
      receiverId: topThree[i].connector_id,
      arenaSessionId,
      source: TOP_TALENT_BONUS_SOURCES[i],
    }, { db, io });
  }

  return { awarded: topThree.length };
}


/**
 * ============================================================
 * BONUS "TAVOLO PIÙ ATTIVO" DI FINE SERATA (19/9, idea dell'utente)
 * ============================================================
 * Diverso dal Talent Scout qui sopra: quello premia il Connector in
 * base al SUO SINGOLO membro più popolare (una stella, anche se il
 * resto del tavolo è spento) — questo invece guarda la SOMMA dei
 * punti ORGANICI di TUTTI i partecipanti del tavolo insieme, e premia
 * il tavolo compatto/coinvolto nel suo insieme, non il singolo. I due
 * bonus convivono, un tavolo può vincerli entrambi.
 *
 * Va SOLO ai tavoli che hanno un Connector assegnato (quelli senza
 * restano fuori dai giochi, esclusi anche dalla classifica interna,
 * non solo dalla vittoria) — pensato apposta per dare un motivo
 * concreto anche a un gruppo di semplici amici, senza nessun PR di
 * professione, per nominare comunque un Connector: a differenza del
 * riflesso punti/Talent Scout (che vanno SOLO al Connector), questo
 * bonus si divide in parti UGUALI tra TUTTI i partecipanti del
 * tavolo (stesso principio già usato per Big Spender qui sopra).
 *
 * Punti ORGANICI = stessa identica definizione usata per il tetto di
 * equità (populive-ranking-cap.js) — solo Like/Superlike/Pulse
 * ricevuti, mai bonus — così un tavolo non scala questa classifica
 * semplicemente perché il suo Connector ha già ricevuto punti
 * riflessi da altrove.
 *
 * Va chiamata UNA VOLTA, quando l'Arena chiude per la notte (stesso
 * momento esatto del Talent Scout, v. populive-scheduler.js,
 * closeSessionIfOpen) — mai durante la serata, altrimenti "qual è il
 * tavolo più attivo" cambierebbe in corsa.
 * ============================================================
 */
const TABLE_ACTIVITY_BONUS_SOURCES = ['table_activity_bonus_1', 'table_activity_bonus_2', 'table_activity_bonus_3'];

async function awardTopTableActivityBonuses(arenaSessionId, { db, io }) {
  if (!(await isTopConnectorEnabled({ db }))) return { awarded: 0 };

  // Tavoli idonei = hanno un Connector assegnato (connector_id non
  // nullo per quel table_qr_code in questa sessione) — un tavolo
  // senza Connector non entra proprio in questa classifica.
  const topThreeTables = await db.queryAll(`
    WITH eligible_tables AS (
      SELECT DISTINCT table_qr_code
      FROM squad_memberships
      WHERE arena_session_id = $1 AND table_qr_code IS NOT NULL AND connector_id IS NOT NULL
    ),
    table_members AS (
      SELECT DISTINCT sm.table_qr_code, sm.member_id
      FROM squad_memberships sm
      JOIN eligible_tables et ON et.table_qr_code = sm.table_qr_code
      WHERE sm.arena_session_id = $1
    ),
    table_organic_totals AS (
      SELECT tm.table_qr_code, COALESCE(SUM(pl.points), 0) AS organic_points
      FROM table_members tm
      LEFT JOIN points_ledger pl
        ON pl.user_id = tm.member_id
        AND pl.arena_session_id = $1
        AND pl.counts_toward_local = true
        AND pl.source = ANY(${ORGANIC_REFERENCE_SOURCES_SQL})
      GROUP BY tm.table_qr_code
    )
    SELECT table_qr_code, organic_points
    FROM table_organic_totals
    ORDER BY organic_points DESC
    LIMIT 3
  `, [arenaSessionId]);

  let awarded = 0;
  for (let i = 0; i < topThreeTables.length; i++) {
    const tableQrCode = topThreeTables[i].table_qr_code;

    const members = await db.queryAll(`
      SELECT DISTINCT member_id FROM squad_memberships
      WHERE arena_session_id = $1 AND table_qr_code = $2
    `, [arenaSessionId, tableQrCode]);

    if (members.length === 0) continue; // difensivo, non dovrebbe mai capitare data la query sopra

    const source = TABLE_ACTIVITY_BONUS_SOURCES[i];
    const totalBonus = BASE_POINTS[source];
    // Stesso principio del bonus spesa Big Spender: si divide in
    // parti UGUALI tra tutti i partecipanti, non un awardPoints per
    // persona (che applicherebbe moltiplicatori Premium/Founder/ecc.
    // pensati per punti RICEVUTI da un'interazione vera, non per una
    // quota di un bonus di squadra).
    const perPersonPoints = Math.round(totalBonus / members.length);

    for (const member of members) {
      await db.query(`
        INSERT INTO points_ledger (user_id, arena_session_id, points, source)
        VALUES ($1, $2, $3, $4)
      `, [member.member_id, arenaSessionId, perPersonPoints, source]);

      io.to(`arena_${arenaSessionId}`).emit('points_update', {
        userId: member.member_id,
        points: perPersonPoints,
        source,
      });
    }

    awarded++;
  }

  return { awarded };
}


// ------------------------------------------------------------
// STATO CONNECTOR — sempre per singola sessione, mai permanente
// ------------------------------------------------------------
async function updateContributionPoints({ userId, arenaSessionId, delta }, { db }) {
  await db.query(`
    INSERT INTO connector_status (user_id, arena_session_id, contribution_points)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, arena_session_id)
    DO UPDATE SET contribution_points = connector_status.contribution_points + $3
  `, [userId, arenaSessionId, delta]);

  await recalculateTopConnectors(arenaSessionId, { db });
}

/**
 * Ricalcola chi è "Top Connector" in QUESTA sessione (top 5% per
 * Punti Contribuzione) — si azzera e si ricalcola da zero ogni
 * sera, mai un badge che si porta dietro da una serata all'altra.
 */
async function recalculateTopConnectors(arenaSessionId, { db }) {
  await db.query(`
    WITH ranked AS (
      SELECT id, PERCENT_RANK() OVER (ORDER BY contribution_points DESC) AS pct
      FROM connector_status
      WHERE arena_session_id = $1
    )
    UPDATE connector_status
    SET is_top_connector = (ranked.pct <= $2)
    FROM ranked
    WHERE connector_status.id = ranked.id
  `, [arenaSessionId, CONNECTOR_TOP_PERCENTILE]);
}

async function getConnectorStatus({ userId, arenaSessionId }, { db }) {
  if (!(await isTopConnectorEnabled({ db }))) return { contributionPoints: 0, isTopConnector: false };
  const row = await db.query(`
    SELECT contribution_points, is_top_connector FROM connector_status
    WHERE user_id = $1 AND arena_session_id = $2
  `, [userId, arenaSessionId]);
  return row
    ? { contributionPoints: row.contribution_points, isTopConnector: row.is_top_connector }
    : { contributionPoints: 0, isTopConnector: false };
}

async function getLocalPoints({ userId, arenaSessionId }, { db }) {
  const row = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND counts_toward_local = true
  `, [userId, arenaSessionId]);
  return row.total || 0;
}

/**
 * ============================================================
 * BONUS SPESA AL TAVOLO — soglia fissa, mai proporzionale
 * ============================================================
 * Va chiamata quando arriva la conferma di una spesa per un tavolo
 * (via PR/Concierge in fase pilota, via webhook Stripe quando la
 * fintech sarà attiva — il canale non cambia questa funzione).
 *
 * La soglia e il bonus NON sono valori passati da fuori: si leggono
 * sempre dalla configurazione del locale (venues.spending_threshold_cents
 * / spending_bonus_points), personalizzabile per singolo locale dalla
 * dashboard — mai un valore fisso uguale per tutti i locali.
 */
async function awardTableSpendingBonus({ arenaSessionId, tableQrCode, venueId, spentCents }, { db, io }) {
  if (!(await isBigSpenderEnabled({ db }))) {
    return { success: false, reason: 'big_spender_disabled' };
  }

  const venue = await db.query(`
    SELECT spending_threshold_cents, spending_bonus_points FROM venues WHERE id = $1
  `, [venueId]);

  if (!venue || !venue.spending_threshold_cents) {
    return { success: false, reason: 'venue_has_no_spending_threshold_configured' };
  }
  if (spentCents < venue.spending_threshold_cents) {
    return { success: false, reason: 'below_threshold', threshold: venue.spending_threshold_cents };
  }

  // Idempotenza: se questo tavolo ha già ricevuto il bonus stasera
  // (es. la spesa viene ri-confermata più volte durante la serata),
  // non lo assegniamo una seconda volta.
  const alreadyAwarded = await db.query(`
    SELECT 1 FROM points_ledger pl
    JOIN squad_memberships sm ON sm.member_id = pl.user_id AND sm.arena_session_id = pl.arena_session_id
    WHERE sm.table_qr_code = $1 AND pl.arena_session_id = $2 AND pl.source = 'table_spending_threshold'
    LIMIT 1
  `, [tableQrCode, arenaSessionId]);
  if (alreadyAwarded) return { success: false, reason: 'already_awarded_tonight' };

  const members = await db.queryAll(`
    SELECT DISTINCT member_id FROM squad_memberships
    WHERE arena_session_id = $1 AND table_qr_code = $2
  `, [arenaSessionId, tableQrCode]);

  if (members.length === 0) return { success: false, reason: 'no_squad_found_for_table' };

  const perPersonPoints = Math.round(venue.spending_bonus_points / members.length);

  for (const member of members) {
    await db.query(`
      INSERT INTO points_ledger (user_id, arena_session_id, points, source)
      VALUES ($1, $2, $3, 'table_spending_threshold')
    `, [member.member_id, arenaSessionId, perPersonPoints]);

    io.to(`arena_${arenaSessionId}`).emit('points_update', {
      userId: member.member_id,
      points: perPersonPoints,
      source: 'table_spending_threshold',
    });
  }

  await recalculateTopSpenders(arenaSessionId, { db });

  return { success: true, membersRewarded: members.length, perPersonPoints };
}


/**
 * ============================================================
 * COLLEGAMENTO MANCANTE — chiamata dalla dashboard (fase pilota:
 * un Architetto conferma a mano, dopo che PR/Concierge/bartender
 * gli comunicano che un tavolo ha raggiunto la soglia). Prima
 * questa funzione esisteva ma nessun endpoint la richiamava mai —
 * il Big Spender non poteva scattare per nessuno.
 * ============================================================
 */

/**
 * Risolve da sola la sessione Arena "di stasera" per il locale
 * indicato — chi conferma la spesa dalla dashboard non deve mai
 * conoscere o inserire a mano un ID tecnico di sessione.
 */
async function awardTableSpendingBonusByVenue({ venueId, tableQrCode, spentCents }, { db, io }) {
  const session = await db.query(`
    SELECT id FROM arena_sessions
    WHERE venue_id = $1 AND session_date = current_business_date($1)
  `, [venueId]);

  if (!session) return { success: false, reason: 'no_active_session_tonight' };

  return awardTableSpendingBonus({ arenaSessionId: session.id, tableQrCode, venueId, spentCents }, { db, io });
}

/**
 * Soglia e bonus punti — personalizzabili per locale dalla
 * dashboard, mai un valore fisso uguale per tutti (da concordare
 * con ogni proprietario in base al proprio listino).
 */
async function updateVenueSpendingConfig({ venueId, thresholdCents, bonusPoints }, { db }) {
  await db.query(`
    UPDATE venues SET spending_threshold_cents = $1, spending_bonus_points = $2 WHERE id = $3
  `, [thresholdCents, bonusPoints, venueId]);
  return { success: true };
}

module.exports = {
  joinSquad,
  reflectPointsToConnector,
  placeDiscoveryMarker,
  evaluatePendingDiscoveryMarkers,
  awardTopTalentBonuses,
  awardTopTableActivityBonuses,
  getConnectorStatus,
  getSpenderStatus,
  awardTableSpendingBonus,
  awardTableSpendingBonusByVenue,
  updateVenueSpendingConfig,
  isBigSpenderEnabled,
  isTopConnectorEnabled,
  claimTableAsProfessionalConnector,
  isTableLocked,
  setTableLock,
  resolveTableConnectorId,
};
