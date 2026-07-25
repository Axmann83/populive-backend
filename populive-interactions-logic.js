/**
 * ============================================================
 * POPULIVE — INVIO INTERAZIONI E RISPOSTA ALLE ROSE
 * ============================================================
 * Due famiglie di funzioni:
 *   1) Invio: chi manda un Like/Superlike/Rosa (con controllo
 *      del filtro contatti del destinatario)
 *   2) Risposta: chi riceve una Rosa decide cosa fare
 *      (accetta / rifiuta / ignora / mini-gioco per la variante +Like)
 * ============================================================
 */

const { awardPoints, awardSenderPoints, LIKE_SENDER_FREE_LIMIT } = require('./populive-points-engine');
const { openChatConversation } = require('./populive-chat-logic');


// ------------------------------------------------------------
// PARTE 0 — Like / Superlike semplici (senza Rosa allegata)
// ------------------------------------------------------------
async function sendInteraction({ senderId, receiverId, arenaSessionId, type }, { db, io, redis }) {
  // type: 'like' | 'superlike'

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [receiverId, senderId]);
  if (blocked) return { success: false, reason: 'blocked_by_receiver' };

  if (type === 'superlike') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };
  }

  // Rate limit giornaliero LATO RICEVENTE: solo i primi N like
  // generano punti a chi li riceve (l'invio resta comunque libero).
  const countsForPoints = type === 'superlike'
    ? true
    : await isUnderDailyLikeLimit(receiverId, { db });

  // IMPORTANTE: calcoliamo i punti (che internamente controlla se
  // questo Connector ha già "boostato" questa persona) PRIMA di
  // scrivere la riga dell'interazione corrente — altrimenti il
  // controllo vedrebbe sempre "già presente" anche al primo invio.
  let receiverLocalPoints = 0;
  if (countsForPoints) {
    const result = await awardPoints({
      receiverId,
      arenaSessionId,
      source: type === 'superlike' ? 'superlike_received' : 'like_received',
      senderId,
    }, { db, io });
    receiverLocalPoints = result.localPoints;
  }

  await db.query(`
    INSERT INTO interactions (sender_id, receiver_id, arena_session_id, type, counts_for_points)
    VALUES ($1, $2, $3, $4, $5)
  `, [senderId, receiverId, arenaSessionId, type, countsForPoints]);

  // Punti al MITTENTE: per il Superlike sempre (già limitato di suo
  // dal numero di Superlike disponibili al giorno), per il Like solo
  // dentro il tetto dei primi 10 inviati per questa Arena.
  let senderEarnedPoints = false;
  if (countsForPoints) {
    if (type === 'superlike') {
      await awardSenderPoints({
        senderId, arenaSessionId, receiverLocalPoints, source: 'superlike_received',
      }, { db, io });
      senderEarnedPoints = true;
    } else {
      const underSenderLimit = await isUnderSenderLikeLimit(senderId, arenaSessionId, { db });
      if (underSenderLimit) {
        await awardSenderPoints({
          senderId, arenaSessionId, receiverLocalPoints, source: 'like_received',
        }, { db, io });
        senderEarnedPoints = true;
      }
      // Oltre il tetto: il like parte comunque (nessun blocco),
      // semplicemente non genera punti extra al mittente — a meno
      // che non abbia acquistato crediti extra (vedi purchaseLikeCredits).
    }
  }

  // Notifica PRIVATA — mai alla stanza dell'Arena. Il Like resta
  // anonimo nel payload (nessun senderId), il Superlike mostra
  // il mittente perché è la sua natura fin dall'inizio.
  io.to(`user_${receiverId}`).emit(type === 'superlike' ? 'superlike_received' : 'like_received', {
    senderId: type === 'superlike' ? senderId : null,
    senderName: type === 'superlike' ? await getSenderName(senderId, { db }) : null,
    countedForPoints: countsForPoints,
  });

  // RECIPROCITÀ (solo per il Like anonimo): se il destinatario ci
  // aveva GIÀ messo like in precedenza, scatta il match — l'identità
  // si svela a entrambi e si apre la chat, con la stessa protezione
  // bilaterale "conserva/cancella" di tutte le altre chat.
  let reciprocalMatch = false;
  let matchConversationId = null;
  if (type === 'like') {
    const priorReciprocalLike = await db.query(`
      SELECT 1 FROM interactions
      WHERE sender_id = $1 AND receiver_id = $2 AND type = 'like'
    `, [receiverId, senderId]);

    if (priorReciprocalLike) {
      reciprocalMatch = true;
      const chat = await openChatConversation({
        userAId: senderId, userBId: receiverId, arenaSessionId, unlockedVia: 'like_reciprocal',
      }, { db, io });
      matchConversationId = chat.conversationId;

      io.to(`user_${senderId}`).emit('chat_unlocked', { withUserId: receiverId, conversationId: matchConversationId, viaReciprocalLike: true });
      io.to(`user_${receiverId}`).emit('chat_unlocked', { withUserId: senderId, conversationId: matchConversationId, viaReciprocalLike: true });
    }
  }

  return { success: true, countedForPoints: countsForPoints, senderEarnedPoints, reciprocalMatch, matchConversationId };
}

/**
 * Risposta a un Superlike semplice (senza Rosa allegata) — stessa
 * logica di accetta/rifiuta/lascia-in-sospeso già decisa per la
 * Rosa, mai implementata finora per il Superlike puro.
 */
async function respondToSuperlike({ interactionId, receiverId, action }, { db, io }) {
  const interaction = await db.query(`SELECT * FROM interactions WHERE id = $1`, [interactionId]);
  if (!interaction || interaction.receiver_id !== receiverId || interaction.type !== 'superlike') {
    return { success: false, reason: 'not_found_or_not_yours' };
  }
  if (interaction.status !== 'sent') {
    return { success: false, reason: 'already_decided' };
  }

  if (action === 'reject' || action === 'ignore') {
    await db.query(`
      INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [receiverId, interaction.sender_id]);
    await db.query(`
      UPDATE interactions SET status = $1 WHERE id = $2
    `, [action === 'reject' ? 'rejected' : 'ignored', interactionId]);
    return { success: true, action, senderNotified: false };
  }

  if (action === 'accept') {
    await db.query(`UPDATE interactions SET status = 'matched' WHERE id = $1`, [interactionId]);

    const chat = await openChatConversation({
      userAId: interaction.sender_id, userBId: receiverId,
      arenaSessionId: interaction.arena_session_id, unlockedVia: 'superlike',
    }, { db, io });

    io.to(`user_${interaction.sender_id}`).emit('chat_unlocked', {
      withUserId: receiverId, conversationId: chat.conversationId,
    });
    io.to(`user_${receiverId}`).emit('chat_unlocked', {
      withUserId: interaction.sender_id, conversationId: chat.conversationId,
    });

    return { success: true, action: 'accept', conversationId: chat.conversationId };
  }

  return { success: false, reason: 'invalid_action' };
}

async function isUnderDailyLikeLimit(receiverId, { db }) {
  const DAILY_LIKE_LIMIT = 5; // valore già deciso, tenuto qui per ora
  const count = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'like' AND counts_for_points = true
      AND created_at >= current_business_day_start($1)
  `, [receiverId]);
  return count < DAILY_LIKE_LIMIT;
}

// Tetto lato MITTENTE: solo i primi LIKE_SENDER_FREE_LIMIT like
// inviati in questa Arena generano punti a chi li manda. Conta
// anche eventuali crediti extra acquistati (fase fintech successiva).
async function isUnderSenderLikeLimit(senderId, arenaSessionId, { db }) {
  const sentCount = await db.query(`
    SELECT COUNT(*) FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND source = 'like_received_sent'
  `, [senderId, arenaSessionId]);

  const purchasedCredits = await getPurchasedLikeCredits(senderId, arenaSessionId, { db });

  return sentCount < (LIKE_SENDER_FREE_LIMIT + purchasedCredits);
}

// Placeholder per la fase fintech: qui si collegherà l'acquisto
// reale in-app di crediti Like extra. Per ora ritorna sempre 0.
async function getPurchasedLikeCredits(senderId, arenaSessionId, { db }) {
  const result = await db.query(`
    SELECT COALESCE(SUM((effect_config->>'credits')::int), 0) AS total
    FROM user_purchases
    JOIN iap_products ON iap_products.id = user_purchases.product_id
    WHERE user_purchases.user_id = $1
      AND iap_products.product_type = 'like_credits'
      AND (
        user_purchases.arena_session_id = $2
        OR iap_products.effect_config->>'scope' = 'permanent'
      )
  `, [senderId, arenaSessionId]);
  return result.total || 0;
}


/**
 * ============================================================
 * MOTORE ACQUISTI — applica l'effetto di QUALUNQUE prodotto del
 * catalogo, senza bisogno di scrivere una funzione nuova ogni
 * volta che aggiungiamo un prodotto. Studiando il mercato potremo
 * aggiungere nuovi SKU (es. "boost visibilità 1 ora", "pacchetto
 * Rose scontate") inserendo solo una riga in iap_products — questa
 * funzione va estesa SOLO se introduciamo un product_type
 * concettualmente nuovo, non per ogni singolo nuovo prodotto.
 * ============================================================
 */
async function applyPurchaseEffect({ userId, productId, arenaSessionId, externalTransactionId }, { db }) {
  const product = await db.query(`SELECT * FROM iap_products WHERE id = $1 AND is_active = true`, [productId]);
  if (!product) return { success: false, reason: 'product_not_found_or_inactive' };

  const config = product.effect_config;
  let expiresAt = null;

  switch (product.product_type) {
    case 'like_credits':
      // Non serve fare nulla qui subito: getPurchasedLikeCredits
      // legge direttamente user_purchases al momento del bisogno.
      break;

    case 'premium_subscription':
      expiresAt = new Date(Date.now() + config.duration_days * 24 * 60 * 60 * 1000);
      await db.query(`
        UPDATE users SET is_premium = true, premium_expires_at = $1 WHERE id = $2
      `, [expiresAt, userId]);
      break;

    case 'verified_badge':
      if (config.requires_manual_review) {
        // Non attiviamo subito is_verified: entra in coda di
        // revisione manuale (protezione anti-finti-VIP già decisa).
        await db.query(`
          INSERT INTO verification_requests (user_id, purchase_id, status)
          VALUES ($1, NULL, 'pending')
        `, [userId]);
      } else {
        await db.query(`UPDATE users SET is_verified = true WHERE id = $1`, [userId]);
      }
      break;

    case 'rosa_bundle':
      // Esempio di estensione futura: accredita Rose pre-pagate
      // da spendere più avanti. Struttura pronta, da collegare
      // quando il prodotto sarà definito nel dettaglio.
      break;

    default:
      return { success: false, reason: `product_type non gestito: ${product.product_type}` };
  }

  await db.query(`
    INSERT INTO user_purchases (user_id, product_id, arena_session_id, external_transaction_id, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [userId, productId, arenaSessionId, externalTransactionId, expiresAt]);

  return { success: true, productType: product.product_type };
}


// ------------------------------------------------------------
// VISITE AL PROFILO
// ------------------------------------------------------------
async function trackProfileView({ viewerId, viewedUserId, arenaSessionId }, { db, io }) {
  if (viewerId === viewedUserId) return { success: true, skipped: true }; // non contano le proprie

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [viewedUserId, viewerId]);
  if (blocked) return { success: false, reason: 'blocked_by_viewed_user' };

  // Anti-abuso: una sola visita "che conta" per coppia viewer→viewed
  // per Arena — altrimenti basterebbe aprire e chiudere lo stesso
  // profilo cento volte per generare punti a raffica.
  const alreadyCounted = await db.query(`
    SELECT 1 FROM profile_views
    WHERE viewer_id = $1 AND viewed_user_id = $2 AND arena_session_id = $3
  `, [viewerId, viewedUserId, arenaSessionId]);

  if (alreadyCounted) return { success: true, alreadyCounted: true };

  await db.query(`
    INSERT INTO profile_views (viewer_id, viewed_user_id, arena_session_id)
    VALUES ($1, $2, $3)
  `, [viewerId, viewedUserId, arenaSessionId]);

  await awardPoints({ receiverId: viewedUserId, arenaSessionId, source: 'profile_view' }, { db, io });

  // Notifica privata, leggera: non svela chi ha guardato (coerente
  // con l'anonimato generale del radar), solo che "qualcuno" l'ha fatto.
  io.to(`user_${viewedUserId}`).emit('profile_viewed', { countedForPoints: true });

  return { success: true, alreadyCounted: false };
}
// Questa funzione va chiamata PRIMA di creare un Superlike o una
// Rosa+Superlike (mai per il Like semplice o la Rosa standalone/
// +Like, che restano anonime e quindi non sono "un contatto" da
// filtrare).
async function canSendDirectContact({ senderId, receiverId }, { db }) {
  const receiver = await db.query(`
    SELECT contact_filter FROM users WHERE id = $1
  `, [receiverId]);

  if (receiver.contact_filter === 'everyone') return { allowed: true };

  const sender = await db.query(`
    SELECT is_verified, is_premium FROM users WHERE id = $1
  `, [senderId]);

  if (receiver.contact_filter === 'verified_only' && !sender.is_verified) {
    return { allowed: false, reason: 'receiver_requires_verified' };
  }
  if (receiver.contact_filter === 'premium_only' && !sender.is_premium) {
    return { allowed: false, reason: 'receiver_requires_premium' };
  }
  return { allowed: true };
}


// ------------------------------------------------------------
// PARTE 1b — Invio di una Rosa (tutte e tre le varianti)
// ------------------------------------------------------------
async function sendRosa({ senderId, receiverId, arenaSessionId, drinkType, priceCents, tier }, { db, redis, io }) {

  // Il blocco reciproco vale sempre, qualunque sia il tier:
  // se una delle due parti ha bloccato l'altra, l'invio si ferma qui.
  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [receiverId, senderId]);
  if (blocked) return { success: false, reason: 'blocked_by_receiver' };

  // Il filtro contatti si applica solo alla variante "super"
  // (mittente sempre visibile, richiesta di contatto diretto).
  if (tier === 'super') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };
  }

  // Per la variante "like", il numero di tentativi di indovinello
  // scala con quante persone sono nell'Arena in questo momento —
  // sempre in proporzione MINORE rispetto ai profili che verranno
  // mostrati nel mini-gioco (mai 1:1, per non rompere l'anonimato).
  let guessesRemaining = null;
  if (tier === 'like') {
    guessesRemaining = await computeGuessAllowance(arenaSessionId, { redis });
  }

  const rosa = await db.query(`
    INSERT INTO roses (sender_id, receiver_id, arena_session_id, drink_type,
                        price_cents, tier, guesses_remaining)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [senderId, receiverId, arenaSessionId, drinkType, priceCents, tier, guessesRemaining]);

  // Notifica privata in tempo reale SOLO al destinatario — mai alla
  // stanza dell'Arena intera, questo è un evento personale.
  // Il payload NON include mai l'identità del mittente per i tier
  // "standalone" e "like" (resta il backend, tramite sender_id nel
  // database, a saperlo — il frontend riceve solo ciò che è coerente
  // con la variante scelta).
  io.to(`user_${receiverId}`).emit('rosa_received', {
    rosaId: rosa.id,
    tier,
    drinkType,
    senderName: tier === 'super' ? await getSenderName(senderId, { db }) : null,
  });

  return { success: true, rosaId: rosa.id };
}

async function getSenderName(senderId, { db }) {
  const sender = await db.query(`SELECT display_name FROM users WHERE id = $1`, [senderId]);
  return sender.display_name;
}

// Regola di scaling concordata: profili mostrati nel mini-gioco e
// tentativi concessi crescono con la dimensione dell'Arena, ma i
// tentativi restano sempre sotto il numero di profili mostrati.
async function computeGuessAllowance(arenaSessionId, { redis }) {
  const arenaSize = await redis.scard(`arena:${arenaSessionId}:radar`);

  if (arenaSize <= 15)  return 1;   // Arena piccola: massima tensione, stile Happn
  if (arenaSize <= 50)  return 2;
  if (arenaSize <= 100) return 3;
  return 4;                         // Arena molto grande: mai oltre 4, anche se enorme
}


// ------------------------------------------------------------
// PARTE 2 — Risposta a una Rosa: accetta / rifiuta / ignora
// ------------------------------------------------------------
async function respondToRosa({ rosaId, receiverId, action }, { db, io }) {

  const rosa = await db.query(`SELECT * FROM roses WHERE id = $1`, [rosaId]);
  if (!rosa || rosa.receiver_id !== receiverId) {
    return { success: false, reason: 'not_found_or_not_yours' };
  }
  if (rosa.status !== 'pending') {
    return { success: false, reason: 'already_decided' };
  }

  // --- RIFIUTA o IGNORA: stesso effetto di fondo (blocco silenzioso) ---
  // La differenza tra le due è SOLO cosa vede chi riceve nella propria
  // interfaccia in questo istante — nessuna delle due manda al mittente
  // un segnale esplicito di rifiuto (per non rischiare di provocare
  // una reazione ostile in chi non accetta bene un "no").
  if (action === 'reject' || action === 'ignore') {
    await db.query(`
      INSERT INTO blocks (blocker_id, blocked_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [receiverId, rosa.sender_id]);

    await db.query(`
      UPDATE roses SET status = $1 WHERE id = $2
    `, [action === 'reject' ? 'rejected' : 'ignored', rosaId]);

    return { success: true, action, senderNotified: false };
  }

  // --- ACCETTA ---
  // Vale per TUTTI e tre i tier, incluso "like": accettare garantisce
  // sempre la consumazione, a prescindere dall'esito del minigioco.
  // Per il tier "like", il minigioco (attemptGuess) resta disponibile
  // DOPO l'accettazione, ma è solo un bonus per sbloccare la chat —
  // non condiziona mai il possesso della Rosa già accettata.
  if (action === 'accept') {
    const redeemCode = generateRedeemCode();
    await db.query(`
      UPDATE roses
      SET status = 'accepted',
          chat_unlocked = $1,
          redeem_code = $2
      WHERE id = $3
    `, [rosa.tier === 'super', redeemCode, rosaId]);

    // Punti base per aver ricevuto la Rosa, qualunque sia il tier —
    // passa dal motore centralizzato, così eventuali moltiplicatori
    // (premium, founder, voto Top Connector) si applicano automaticamente
    // qui come ovunque altro nel sistema.
    await awardPoints({
      receiverId,
      arenaSessionId: rosa.arena_session_id,
      source: `rosa_${rosa.tier}`,   // 'rosa_standalone' | 'rosa_like' | 'rosa_super'
      senderId: rosa.sender_id,
    }, { db, io });
    // standalone → chat_unlocked resta false (nessun contatto, solo il drink)
    // super      → chat_unlocked true da subito (il profilo era già visibile)
    // like       → chat_unlocked resta false per ora: si sblocca SOLO
    //              vincendo il minigioco in attemptGuess, che però non
    //              tocca mai lo status della Rosa (già "accepted" qui)

    // Rosa+Superlike: l'accettazione apre la chat di default (il
    // profilo era già visibile prima di decidere) — creiamo davvero
    // la conversazione, poi avvisiamo in tempo reale entrambe le
    // parti, sempre in privato, mai sulla stanza condivisa dell'Arena.
    let chatConversationId = null;
    if (rosa.tier === 'super') {
      const chat = await openChatConversation({
        userAId: rosa.sender_id, userBId: receiverId,
        arenaSessionId: rosa.arena_session_id, unlockedVia: 'rosa_super',
      }, { db, io });
      chatConversationId = chat.conversationId;

      io.to(`user_${rosa.sender_id}`).emit('chat_unlocked', { rosaId, withUserId: receiverId, conversationId: chatConversationId });
      io.to(`user_${receiverId}`).emit('chat_unlocked', { rosaId, withUserId: rosa.sender_id, conversationId: chatConversationId });
    }

    return {
      success: true,
      action: 'accept',
      chatUnlocked: rosa.tier === 'super',
      conversationId: chatConversationId,
      redeemCode,
      canStillPlayGuessGame: rosa.tier === 'like',   // il frontend sa se offrire il minigioco dopo
    };
  }

  return { success: false, reason: 'invalid_action' };
}

// ------------------------------------------------------------
// PARTE 3 — Mini-gioco della Rosa + Like: tentativo di indovinare
// ------------------------------------------------------------
// NOTA IMPORTANTE: questa funzione si chiama SOLO dopo che la Rosa
// è già stata accettata (status = 'accepted'). Non tocca mai il
// possesso della consumazione — decide solo se si sblocca la chat.
// Chi perde tutti i tentativi tiene comunque la Rosa già sua.
async function attemptGuess({ rosaId, receiverId, guessedUserId }, { db, io }) {

  const rosa = await db.query(`SELECT * FROM roses WHERE id = $1`, [rosaId]);
  if (!rosa || rosa.receiver_id !== receiverId || rosa.tier !== 'like') {
    return { success: false, reason: 'invalid_request' };
  }
  if (rosa.status !== 'accepted') {
    return { success: false, reason: 'must_accept_rosa_first' };
  }
  if (rosa.chat_unlocked) {
    return { success: false, reason: 'already_unlocked' };
  }
  if (rosa.guesses_remaining <= 0) {
    return { success: false, reason: 'no_attempts_left' };
  }

  const isCorrect = guessedUserId === rosa.sender_id;

  await db.query(`
    INSERT INTO rose_guess_attempts (rose_id, guessed_user_id, was_correct)
    VALUES ($1, $2, $3)
  `, [rosaId, guessedUserId, isCorrect]);

  // Ogni tentativo SBAGLIATO equivale a un vero Like inviato a quella
  // persona — non è solo un tentativo "interno" al minigioco: chi
  // viene indovinato per errore riceve comunque la notifica normale
  // di un like misterioso, i suoi punti, e finisce nel sistema di
  // reciprocità/shortlist come qualunque altro Like — altrimenti,
  // in una serata affollata, chi ha provato a indovinare rischia di
  // non riuscire mai a chiudere un match con chi gli piace davvero.
  // (Il tentativo corretto invece porta già dritto alla chat, non
  // serve passare anche dal Like: l'identità è già del tutto svelata.)
  if (!isCorrect) {
    await sendInteraction({
      senderId: receiverId,
      receiverId: guessedUserId,
      arenaSessionId: rosa.arena_session_id,
      type: 'like',
    }, { db, io });
  }

  if (isCorrect) {
    await db.query(`UPDATE roses SET chat_unlocked = true WHERE id = $1`, [rosaId]);

    // Match riuscito: creiamo davvero la conversazione, poi
    // avvisiamo entrambe le parti in privato — è il momento "wow"
    // del minigioco.
    const chat = await openChatConversation({
      userAId: rosa.sender_id, userBId: receiverId,
      arenaSessionId: rosa.arena_session_id, unlockedVia: 'rosa_like_match',
    }, { db, io });

    io.to(`user_${rosa.sender_id}`).emit('chat_unlocked', { rosaId, withUserId: receiverId, viaGuessGame: true, conversationId: chat.conversationId });
    io.to(`user_${receiverId}`).emit('chat_unlocked', { rosaId, withUserId: rosa.sender_id, viaGuessGame: true, conversationId: chat.conversationId });

    // Bonus punti popolarità per aver vinto il minigioco — oltre al
    // drink già garantito, e come "chance di ringraziamento" per chi
    // ha inviato la Rosa (il match dà valore anche al suo gesto).
    // NOTA: questo valore fisso NON passa dal motore dei moltiplicatori
    // (è già un bonus a sé, non un punteggio "base" da moltiplicare)
    // — se in futuro vorremo applicare anche qui i moltiplicatori,
    // basterà cambiarlo in un source dedicato in BASE_POINTS.
    await db.query(`
      INSERT INTO points_ledger (user_id, arena_session_id, points, source)
      VALUES ($1, $2, $3, 'rosa_guess_won')
    `, [receiverId, rosa.arena_session_id, GUESS_GAME_BONUS_POINTS]);

    // Questo invece va condiviso con TUTTA l'Arena, non in privato —
    // è l'evento che fa scorrere le posizioni sulla classifica live
    // per chiunque la stia guardando in quel momento (l'effetto "+10"
    // che sale sopra il nome, come nel prototipo del ranking).
    io.to(`arena_${rosa.arena_session_id}`).emit('points_update', {
      userId: receiverId,
      points: GUESS_GAME_BONUS_POINTS,
      source: 'rosa_guess_won',
    });

    return { success: true, matched: true, chatUnlocked: true, bonusPoints: GUESS_GAME_BONUS_POINTS };
  }
  const remaining = rosa.guesses_remaining - 1;
  await db.query(`UPDATE roses SET guesses_remaining = $1 WHERE id = $2`, [remaining, rosaId]);

  if (remaining <= 0) {
    // Tentativi esauriti: la Rosa resta sua (era già accettata prima
    // di iniziare il gioco), semplicemente il mittente resta un
    // mistero per sempre. Nessun blocco: non è stato un rifiuto,
    // solo un indovinello non riuscito.
    return { success: true, matched: false, attemptsExhausted: true };
  }

  return { success: true, matched: false, attemptsRemaining: remaining };
}


function generateRedeemCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const GUESS_GAME_BONUS_POINTS = 10; // valore indicativo, da bilanciare insieme al resto del sistema punti

/**
 * Elenco delle Rose ricevute da un utente — usato dalla tab "Rose"
 * dell'app. Il nome del mittente si mostra SOLO per il tier 'super'
 * (dove è sempre visibile per design) o se la Rosa ha già
 * chat_unlocked = true (reciprocità/match avvenuti) — mai per una
 * Rosa standalone/+like ancora "misteriosa".
 */
async function getReceivedRoses({ userId }, { db }) {
  const roses = await db.queryAll(`
    SELECT r.id, r.drink_type, r.tier, r.status, r.chat_unlocked, r.created_at,
           v.name AS venue_name,
           CASE WHEN r.tier = 'super' OR r.chat_unlocked THEN u.display_name ELSE NULL END AS sender_name
    FROM roses r
    JOIN arena_sessions a ON a.id = r.arena_session_id
    JOIN venues v ON v.id = a.venue_id
    JOIN users u ON u.id = r.sender_id
    WHERE r.receiver_id = $1
    ORDER BY r.created_at DESC
  `, [userId]);

  return roses.map((r) => ({
    rosaId: r.id,
    drinkType: r.drink_type,
    tier: r.tier,
    status: r.status,
    venueName: r.venue_name,
    senderName: r.sender_name, // null se ancora anonimo
    createdAt: r.created_at,
  }));
}

module.exports = { canSendDirectContact, sendInteraction, trackProfileView, sendRosa, respondToRosa, attemptGuess, applyPurchaseEffect, respondToSuperlike, getReceivedRoses };
