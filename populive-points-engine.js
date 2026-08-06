/**
 * ============================================================
 * POPULIVE — TABELLA PUNTI E MOTORE DI CALCOLO
 * ============================================================
 * Un solo posto dove vivono tutti i valori — quando li
 * bilanceremo con i dati reali dei test, si cambia solo qui,
 * non in dieci funzioni sparse per il codice.
 * Tutti i valori sono INDICATIVI, da tarare con i numeri veri.
 * ============================================================
 */

const BASE_POINTS = {
  // Valori DEFINITIVI, decisi insieme — piccoli e interi apposta,
  // per restare leggibili in classifica anche dopo mesi di utilizzo
  // reale (mai rischiare numeri enormi difficili da confrontare).
  profile_view:              2,   // solo la prima visita per coppia visitatore/visitato/serata, e solo le prime N persone diverse viste a testa (v. MAX_DISTINCT_VIEWS_PER_SESSION)
  like_received:             5,   // solo i primi N like/giorno per ricevente contano (rate limit già deciso)
  superlike_received:        8,
  pulse_standalone:          10,
  pulse_like:                10,   // + bonus separato per ENTRAMBI se vince il minigioco (vedi pulse_like_match sotto)
  pulse_like_match:          10,   // bonus al RICEVENTE per un match riuscito nel minigioco — +30% incluso via MULTIPLIERS.guess_match_bonus, si somma correttamente a eventuali altri bonus (Premium, Founder, ecc.)
  pulse_super:               12,
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
  pulse_standalone:     4,
  pulse_like:           4,
  pulse_super:          5,
  pulse_like_match:    13,  // 10 base + 30% già incluso (questo percorso non passa dal motore dei moltiplicatori generico) — premia CHI HA INVIATO per il fatto che il ricevente ha giocato il minigioco fino in fondo invece di skipparlo, non solo il ricevente stesso.
};

// Bonus a ENTRAMBI se il minigioco Pulse+Like va a segno (match) —
// non solo al destinatario che gioca, come succedeva prima: chi ha
// mandato la Pulse partecipa comunque al risultato del suo gesto.
// Il +30% (rispetto ai 10 punti base) premia il fatto di NON aver
// skippato il minigioco — un incentivo in più a giocarlo davvero.
// (il vecchio valore fisso GUESS_GAME_BONUS_POINTS=8, solo per il
// ricevente e fuori dal motore dei moltiplicatori, è stato sostituito
// da questo — v. BASE_POINTS.pulse_like_match / SENDER_POINTS.pulse_like_match)

// Tetto anti-spam sulle visite profilo: oltre le prime N persone
// DIVERSE viste in una sessione, le visite continuano a funzionare
// ma non generano più punti — altrimenti basterebbe scorrere il
// radar all'infinito per accumulare punti senza sforzo reale.
const MAX_DISTINCT_VIEWS_PER_SESSION = 20;


const MULTIPLIERS = {
  premium:        1.2,   // profilo Premium a pagamento
  founder_global: 1.5,   // braccialetto founder — SOLO sul globale, mai sul locale (già deciso)
  sender_share:   0.3,   // chi INVIA un'interazione riceve il 30% del punteggio corrispondente
  top_connector_vote: 1.5, // il voto di un Top Connector vale 1.5x — solo la prima volta per persona per like/superlike, sempre per la Pulse (già limitata dal costo reale)
  consent_per_toggle: 0.05, // +5% per ciascuna delle 3 scelte facoltative attive in Impostazioni (missioni sponsorizzate/bacheca storica/ricevi Pulse) — cumulabile fino a +15% con tutte e tre attive. Si applica SIA ai punti che ricevi SIA a quelli che guadagni inviando, ed è sempre calcolato al momento (mai "congelato"): se spunti o togli una casella, il moltiplicatore cambia dalla prossima interazione in poi, coerente con la sua natura reversibile.
  verified_bonus: 0.05, // +5% per chi ha il profilo Verificato — a differenza delle 3 scelte sopra, questo NON si accende/spegne mai (badge acquistato una volta), quindi si SOMMA in modo semplice sopra gli altri invece di moltiplicarsi insieme — su 10 punti base: 15% (tutte e 3 le scelte) + 5% (verificato) = 2 punti bonus totali, non 2,075. Vale meno proprio perché non è reversibile come le altre.
  historical_board_bonus: 1.3, // +30% sui punti guadagnati da un Superlike o una visita profilo che arrivano dalla Bacheca Storica — incentivo a comparire lì (consenso facoltativo appears_in_historical_search). Si applica SOLO a questi due source, moltiplicato in sequenza con gli altri (come premium), non sommato come il bonus Verificato — qui non c'è motivo di trattarlo diversamente, è calcolato per ogni singolo evento, non legato a uno stato permanente.
  guess_match_bonus: 1.3, // +30% sui punti del RICEVENTE per un match riuscito nel minigioco Pulse+Like — premia chi lo gioca fino in fondo invece di skipparlo. Si applica SOLO al source pulse_like_match, moltiplicato in sequenza con gli altri come premium/historical_board_bonus.
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
 * Moltiplicatore per le 3 scelte facoltative in Impostazioni —
 * calcolato SEMPRE al momento (mai salvato da nessuna parte), così
 * riflette sempre lo stato vero e attuale delle spunte. Usata sia
 * per i punti che una persona RICEVE sia per quelli che guadagna
 * INVIANDO, guardando ogni volta le proprie scelte, non quelle di
 * chi le manda o le riceve.
 */
async function getConsentMultiplier(userId, { db }) {
  const user = await db.query(`
    SELECT sponsored_missions_enabled, appears_in_historical_search, receive_pulses_enabled, is_verified
    FROM users WHERE id = $1
  `, [userId]);

  if (!user) return 1;

  const activeCount =
    (user.sponsored_missions_enabled ? 1 : 0) +
    (user.appears_in_historical_search ? 1 : 0) +
    (user.receive_pulses_enabled ? 1 : 0);

  // Somma semplice, non composta — il bonus Verificato si aggiunge
  // "sopra" quello delle 3 scelte, non si moltiplica insieme (v.
  // spiegazione sopra su MULTIPLIERS.verified_bonus).
  const verifiedBonus = user.is_verified ? MULTIPLIERS.verified_bonus : 0;

  return 1 + (activeCount * MULTIPLIERS.consent_per_toggle) + verifiedBonus;
}

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
async function computePoints({ receiverId, source, senderId, arenaSessionId, viaHistoricalBoard }, { db }) {
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
      // La Pulse (qualunque tier) è sempre esente dal tetto: costa
      // denaro reale ogni volta, quindi è già naturalmente limitata
      // — nessun bisogno di un tetto artificiale in più.
      const isPulseSource = source.startsWith('pulse_');

      const alreadyBoostedThisReceiver = isPulseSource
        ? false
        : await hasAlreadyBoosted({ senderId, receiverId, source, arenaSessionId }, { db });

      if (isPulseSource || !alreadyBoostedThisReceiver) {
        localPoints = Math.round(localPoints * MULTIPLIERS.top_connector_vote);
      }
      // Se ha già "boostato" questa persona con lo stesso tipo di
      // interazione in questa sessione, il valore resta quello base
      // — niente errore, semplicemente niente bonus la seconda volta.
    }
  }

  if (receiver.is_premium) {
    localPoints = Math.round(localPoints * MULTIPLIERS.premium);
  }

  // Bonus Bacheca Storica — SOLO per un Superlike o una visita
  // profilo arrivati da lì, mai per le altre fonti. Incentivo a
  // rendersi trovabili tornando indietro nel tempo, non solo dal
  // vivo stasera.
  if (viaHistoricalBoard && (source === 'superlike_received' || source === 'profile_view')) {
    localPoints = Math.round(localPoints * MULTIPLIERS.historical_board_bonus);
  }

  // Bonus match riuscito nel minigioco Pulse+Like — SOLO per questo
  // source specifico, mai per altri.
  if (source === 'pulse_like_match') {
    localPoints = Math.round(localPoints * MULTIPLIERS.guess_match_bonus);
  }

  // Bonus scelte facoltative — si applica per ultimo, sopra a tutti
  // gli altri moltiplicatori, sempre calcolato sulle impostazioni
  // ATTUALI di chi riceve.
  const receiverConsentMultiplier = await getConsentMultiplier(receiverId, { db });
  if (receiverConsentMultiplier !== 1) {
    localPoints = Math.round(localPoints * receiverConsentMultiplier);
  }

  const isFounder = await db.query(`
    SELECT 1 FROM founder_bracelets WHERE user_id = $1
  `, [receiverId]);
  if (isFounder) {
    // Il bonus founder si applica SOLO all'accumulo globale, mai al
    // locale — coerente con "si riparte tutti alla pari ogni sera".
    globalOnlyBonus = Math.round(base * (MULTIPLIERS.founder_global - 1));
  }

  return { localPoints, globalOnlyBonus };
}

/**
 * Scrive i punti nel ledger e trasmette l'aggiornamento alla
 * classifica dell'Arena in tempo reale (evento PUBBLICO, va
 * a tutta la stanza — è la classifica che tutti guardano).
 */
async function awardPoints({ receiverId, arenaSessionId, source, senderId, viaHistoricalBoard }, { db, io }) {
  const { localPoints, globalOnlyBonus } = await computePoints({ receiverId, source, senderId, arenaSessionId, viaHistoricalBoard }, { db });

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
 * Assegna al MITTENTE una quota (0.3x) dei punti che ha generato
 * per il destinatario con la sua interazione. Va chiamata SOLO se
 * l'invio è ancora dentro i limiti previsti (per il Like: il tetto
 * dei primi 10 per Arena, verificato PRIMA di chiamare questa
 * funzione — vedi isUnderSenderLikeLimit in interactions-logic).
 */
async function awardSenderPoints({ senderId, arenaSessionId, source }, { db, io }) {
  let senderPoints = SENDER_POINTS[source];
  if (!senderPoints || senderPoints <= 0) return { senderPoints: 0 };

  const senderConsentMultiplier = await getConsentMultiplier(senderId, { db });
  if (senderConsentMultiplier !== 1) {
    senderPoints = Math.round(senderPoints * senderConsentMultiplier);
  }

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
  // Nota: questa funzione va chiamata PRIMA di inserire la nuova
  // riga in "interactions" — se la riga corrente fosse già stata
  // scritta, il conteggio includerebbe anche lei per errore.
  return priorCount > 0;
}

module.exports = { BASE_POINTS, SENDER_POINTS, MULTIPLIERS, LIKE_SENDER_FREE_LIMIT, MAX_DISTINCT_VIEWS_PER_SESSION, computePoints, awardPoints, awardSenderPoints, getConsentMultiplier };
