/**
 * ============================================================
 * POPULIVE — TABELLA PUNTI E MOTORE DI CALCOLO
 * ============================================================
 * Un solo posto dove vivono tutti i valori — quando li
 * bilanceremo con i dati reali dei test, si cambia solo qui,
 * non in dieci funzioni sparse per il codice.
 * ============================================================
 */

const BASE_POINTS = {
  // Valori DEFINITIVI, decisi insieme — piccoli e interi apposta,
  // per restare leggibili in classifica anche dopo mesi di utilizzo
  // reale (mai rischiare numeri enormi difficili da confrontare).
  profile_view:              2,   // solo la prima visita per coppia visitatore/visitato/serata, e solo le prime N persone diverse viste a testa (v. MAX_DISTINCT_VIEWS_PER_SESSION)
  like_received:             5,   // solo i primi N like/giorno per ricevente contano (rate limit già deciso)
  superlike_received:        8,
  rosa_standalone:          10,
  rosa_like:                10,   // + bonus separato al DESTINATARIO se vince il minigioco (vedi GUESS_GAME_BONUS_POINTS)
  rosa_super:               12,
  mission_completed:        15,   // missione sponsorizzata da brand
  connector_discovery_bonus: 18,  // Top Connector: bonus per aver "scoperto" un profilo che poi esplode
};

// Punti a chi COMPIE l'azione (non solo a chi la riceve) — valori
// fissi decisi insieme, non più calcolati come "percentuale" del
// valore del destinatario (evita decimali/arrotondamenti ovunque).
const SENDER_POINTS = {
  profile_view:        1,
  like_received:       2,
  superlike_received:  3,
  rosa_standalone:     4,
  rosa_like:           4,
  rosa_super:          5,
};

// Bonus al DESTINATARIO se vince il minigioco Rosa+Like (è lui/lei
// che gioca, quindi il bonus va a lui/lei, non a chi ha mandato la Rosa).
const GUESS_GAME_BONUS_POINTS = 8;

// Tetto anti-spam sulle visite profilo: oltre le prime N persone
// DIVERSE viste in una sessione, le visite continuano a funzionare
// ma non generano più punti — altrimenti basterebbe scorrere il
// radar all'infinito per accumulare punti senza sforzo reale.
const MAX_DISTINCT_VIEWS_PER_SESSION = 20;


const MULTIPLIERS = {
  premium:        1.2,   // profilo Premium a pagamento
  founder_global: 1.5,   // braccialetto founder — SOLO sul globale, mai sul locale (già deciso)
  sender_share:   0.3,   // chi INVIA un'interazione riceve il 30% del punteggio corrispondente
  top_connector_vote: 1.5, // il voto di un Top Connector vale 1.5x — solo la prima volta per persona per like/superlike, sempre per la Rosa (già limitata dal costo reale)
};

// Limite specifico sul LIKE INVIATO (non ricevuto): solo i primi N
// like mandati per Arena generano punti al mittente. Oltre quel
// numero, il like si può comunque inviare liberamente (nessun
// blocco all'azione stessa), semplicemente non genera punti extra
// per chi lo manda — evita che il sistema si "gonfi" di punti
// gratuiti mandando like a raffica senza limiti. Chi ne vuole di
// più che generino punti dovrà acquistarli in app (fase successiva,
// stesso principio del Wallet "Coming Soon": qui prepariamo il
// meccanismo, il pagamento vero arriva con la fintech).
const LIKE_SENDER_FREE_LIMIT = 10;

/**
 * Calcola i punti da assegnare per un evento, applicando i
 * moltiplicatori pertinenti. Ritorna sia il valore "locale"
 * (per la classifica della serata) sia quello "globale"
 * (che può includere bonus che il locale non vede, es. founder).
 *
 * senderId/arenaSessionId sono FACOLTATIVI: se passati e il
 * mittente risulta Top Connector per QUESTA sessione (mai un dato
 * permanente, sempre ricalcolato sera per sera), il punteggio
 * raddoppia PRIMA degli altri moltiplicatori.
 */
async function computePoints({ receiverId, source, senderId, arenaSessionId }, { db }) {
  const base = BASE_POINTS[source];
  if (base === undefined) throw new Error(`Punteggio non definito per: ${source}`);

  const receiver = await db.query(`
    SELECT is_premium FROM users WHERE id = $1
  `, [receiverId]);

  let localPoints = base;
  let globalOnlyBonus = 0;

  if (senderId && arenaSessionId) {
    const senderStatus = await db.query(`
      SELECT is_top_connector FROM connector_status
      WHERE user_id = $1 AND arena_session_id = $2
    `, [senderId, arenaSessionId]);

    if (senderStatus && senderStatus.is_top_connector) {
      const isRosaSource = source.startsWith('rosa_');

      const alreadyBoostedThisReceiver = isRosaSource
        ? false
        : await hasAlreadyBoosted({ senderId, receiverId, source, arenaSessionId }, { db });

      if (isRosaSource || !alreadyBoostedThisReceiver) {
        localPoints = Math.round(localPoints * MULTIPLIERS.top_connector_vote);
      }
    }
  }

  if (receiver.is_premium) {
    localPoints = Math.round(localPoints * MULTIPLIERS.premium);
  }

  const isFounder = await db.query(`
    SELECT 1 FROM founder_bracelets WHERE user_id = $1
  `, [receiverId]);
  if (isFounder) {
    globalOnlyBonus = Math.round(base * (MULTIPLIERS.founder_global - 1));
  }

  return { localPoints, globalOnlyBonus };
}

/**
 * Scrive i punti nel ledger e trasmette l'aggiornamento alla
 * classifica dell'Arena in tempo reale (evento PUBBLICO, va
 * a tutta la stanza — è la classifica che tutti guardano).
 */
async function awardPoints({ receiverId, arenaSessionId, source, senderId }, { db, io }) {
  const { localPoints, globalOnlyBonus } = await computePoints({ receiverId, source, senderId, arenaSessionId }, { db });

  await db.query(`
    INSERT INTO points_ledger (user_id, arena_session_id, points, source, counts_toward_local)
    VALUES ($1, $2, $3, $4, true)
  `, [receiverId, arenaSessionId, localPoints, source]);

  if (globalOnlyBonus > 0) {
    await db.query(`
      INSERT INTO points_ledger (user_id, arena_session_id, points, source, counts_toward_local)
      VALUES ($1, NULL, $2, $3, false)
    `, [receiverId, globalOnlyBonus, `${source}_founder_bonus`]);
  }

  io.to(`arena_${arenaSessionId}`).emit('points_update', {
    userId: receiverId,
    points: localPoints,
    source,
  });

  return { localPoints, globalOnlyBonus };
}

/**
 * Assegna al MITTENTE una quota fissa dei punti per l'interazione
 * che ha compiuto. Va chiamata SOLO se l'invio è ancora dentro i
 * limiti previsti (per il Like: il tetto dei primi 10 per Arena).
 */
async function awardSenderPoints({ senderId, arenaSessionId, source }, { db, io }) {
  const senderPoints = SENDER_POINTS[source];
  if (!senderPoints || senderPoints <= 0) return { senderPoints: 0 };

  await db.query(`
    INSERT INTO points_ledger (user_id, arena_session_id, points, source, counts_toward_local)
    VALUES ($1, $2, $3, $4, true)
  `, [senderId, arenaSessionId, senderPoints, `${source}_sent`]);

  io.to(`arena_${arenaSessionId}`).emit('points_update', {
    userId: senderId,
    points: senderPoints,
    source: `${source}_sent`,
  });

  return { senderPoints };
}

/**
 * Controlla se questo Connector ha già inviato lo stesso tipo di
 * interazione (like o superlike) a questo specifico destinatario,
 * in questa stessa sessione — se sì, il bonus 1.5x non si ripete,
 * per evitare che concentri tutti i suoi voti "pesanti" su una
 * sola persona (es. un amico) invece di distribuirli sull'Arena.
 */
async function hasAlreadyBoosted({ senderId, receiverId, source, arenaSessionId }, { db }) {
  const interactionType = source === 'superlike_received' ? 'superlike' : 'like';
  const priorCount = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE sender_id = $1 AND receiver_id = $2 AND type = $3 AND arena_session_id = $4
  `, [senderId, receiverId, interactionType, arenaSessionId]);
  return priorCount > 0;
}

module.exports = { BASE_POINTS, SENDER_POINTS, MULTIPLIERS, LIKE_SENDER_FREE_LIMIT, GUESS_GAME_BONUS_POINTS, MAX_DISTINCT_VIEWS_PER_SESSION, computePoints, awardPoints, awardSenderPoints };
