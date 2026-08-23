/**
 * ============================================================
 * POPULIVE — INVIO INTERAZIONI E RISPOSTA AI PULSE
 * ============================================================
 * Due famiglie di funzioni:
 *   1) Invio: chi manda un Like/Superlike/Pulse (con controllo
 *      del filtro contatti del destinatario)
 *   2) Risposta: chi riceve una Pulse decide cosa fare
 *      (accetta / rifiuta / ignora / mini-gioco per la variante +Like)
 * ============================================================
 */

const { awardPoints, awardSenderPoints, LIKE_SENDER_FREE_LIMIT, MAX_DISTINCT_VIEWS_PER_SESSION } = require('./populive-points-engine');
const { openChatConversation } = require('./populive-chat-logic');


// ------------------------------------------------------------
// PARTE 0 — Like / Superlike semplici (senza Pulse allegata)
// ------------------------------------------------------------
async function sendInteraction({ senderId, receiverId, arenaSessionId, type, viaHistoricalBoard }, { db, io, redis }) {
  // type: 'like' | 'superlike'

  // Controllo VERO, non solo un'interfaccia che nasconde il
  // bottone — un'interazione verso se stessi va bloccata qui,
  // indipendentemente da come la richiesta sia arrivata (un
  // client vecchio in cache, una chiamata diretta all'endpoint,
  // ecc.). Nascondere il proprio profilo dal radar non basta da
  // solo: chi controlla i punti deve essere il server, sempre.
  if (senderId === receiverId) {
    return { success: false, reason: 'cannot_interact_with_self' };
  }

  // Dalla Bacheca Storica si può inviare SOLO un Superlike — niente
  // Like (l'anonimato non serve a proteggere nessuno, non è più in
  // tempo reale) né Pulse (non sei fisicamente nel locale, non
  // potresti mai riscattarlo). Controllo VERO qui, non solo
  // un'interfaccia che nasconde i bottoni sbagliati.
  if (viaHistoricalBoard && type !== 'superlike') {
    return { success: false, reason: 'historical_board_superlike_only' };
  }

  // Recuperato PRESTO apposta — serve sia per il controllo dei
  // blocchi qui sotto sia per quello dei doppioni più avanti.
  // Un account di prova non ha MAI nessuno di questi limiti, né i
  // vecchi (blocco dopo un rifiuto) né i nuovi (una sola volta a
  // sera): altrimenti due account di prova che si testano a vicenda
  // (es. testando il rifiuto di una Pulse) finirebbero per bloccarsi
  // da soli, impedendo di continuare a testare.
  const senderTestRow = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [senderId]);
  const isTestSender = !!senderTestRow?.is_test_account;

  if (!isTestSender) {
    const blocked = await db.query(`
      SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 AND (arena_session_id IS NULL OR arena_session_id = $3)
    `, [receiverId, senderId, arenaSessionId]);
    if (blocked) return { success: false, reason: 'blocked_by_receiver' };

    // NUOVO — non più di un Like e non più di un Superlike alla
    // STESSA persona nella STESSA serata (stessa arena_session).
    // Il tipo è compreso nel controllo: aver già mandato un Like
    // stasera non blocca un Superlike, e viceversa — sono limiti
    // separati, uno per tipo.
    const alreadySentThisEvening = await db.query(`
      SELECT 1 FROM interactions
      WHERE sender_id = $1 AND receiver_id = $2 AND arena_session_id = $3 AND type = $4
    `, [senderId, receiverId, arenaSessionId, type]);
    if (alreadySentThisEvening) {
      return { success: false, reason: type === 'like' ? 'like_already_sent_tonight' : 'superlike_already_sent_tonight' };
    }
  }

  if (type === 'superlike') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };

    // Un Superlike dalla Bacheca Storica richiede Premium — è
    // l'unica azione possibile da lì (deciso apposta così, invece
    // di un prodotto dedicato separato), quindi è lei a generare
    // il ricavo di questa funzionalità.
    if (viaHistoricalBoard) {
      const senderPremium = await db.query(`SELECT is_premium FROM users WHERE id = $1`, [senderId]);
      if (!senderPremium?.is_premium) {
        return { success: false, reason: 'requires_premium_for_historical_board' };
      }
    }

    // Il Superlike ora è un vero SALDO da spendere (non solo un
    // tetto oltre il quale perdi il bonus, come il Like) — se è a
    // zero, l'invio si blocca del tutto: il frontend mostra "Superlike
    // esauriti, vuoi acquistarne altri?" invece di lasciarlo passare
    // senza punti.
    const sender = await db.query(`SELECT superlike_balance FROM users WHERE id = $1`, [senderId]);
    if (!sender || sender.superlike_balance <= 0) {
      return { success: false, reason: 'superlike_balance_exhausted' };
    }
    await db.query(`UPDATE users SET superlike_balance = superlike_balance - 1 WHERE id = $1`, [senderId]);
  }

  // Chi RICEVE un Like guadagna sempre punti, senza tetto — il
  // limite esiste solo lato mittente (isUnderSenderLikeLimit più
  // sotto), mai per chi lo riceve.
  const countsForPoints = true;

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
      viaHistoricalBoard,
    }, { db, io });
    receiverLocalPoints = result.localPoints;
  }

  const newInteraction = await db.query(`
    INSERT INTO interactions (sender_id, receiver_id, arena_session_id, type, counts_for_points)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [senderId, receiverId, arenaSessionId, type, countsForPoints]);

  // GHOST MODE — se chi invia è un fantasma, questo è il momento in
  // cui si "rivela" — ma SOLO nel radar di chi riceve, mai per il
  // resto della stanza. Non cambia nulla nelle regole di anonimato
  // già esistenti per Like/Superlike (quelle restano intatte) — qui
  // stiamo solo dicendo al radar del destinatario "aggiungi questo
  // profilo tra i candidati", come se fosse appena entrato.
  const senderGhostRow = await db.query(`SELECT ghost_mode_enabled FROM users WHERE id = $1`, [senderId]);
  if (senderGhostRow?.ghost_mode_enabled) {
    io.to(`user_${receiverId}`).emit('ghost_revealed', { userId: senderId });
  }

  // RIORDINO DEL RADAR — solo per il Like (resta anonimo, il
  // destinatario non ha altro modo di sapere chi potrebbe averlo
  // mandato se non lo vede tra i primi). Il Superlike non ne ha
  // bisogno: mostra già subito chi è stato, tramite la sua stessa
  // notifica. Non rivela nulla in più — se il mittente è già
  // visibile normalmente nel radar del destinatario (non è un
  // fantasma), questo evento dice solo "fallo comparire tra i
  // primi", mai "eccoti chi ti ha messo like".
  if (type === 'like') {
    io.to(`user_${receiverId}`).emit('like_boost', { userId: senderId });
  }

  // Punti al MITTENTE: sia per Superlike che per Like, solo dentro
  // un tetto gratuito — per il Like è per-Arena, per il Superlike è
  // SETTIMANALE (dato che il Superlike, mostrando sempre l'identità,
  // è un gesto più "pesante" — un tetto a settimana invece che a
  // singola serata ha più senso). Oltre il tetto, l'invio resta
  // comunque libero, semplicemente non genera più punti extra per
  // chi lo manda, a meno di crediti acquistati.
  let senderEarnedPoints = false;
  if (countsForPoints) {
    if (type === 'superlike') {
      // Nessun controllo di tetto qui: il saldo è già stato
      // verificato e scalato più sopra, prima ancora di scrivere
      // l'interazione — se siamo arrivati fin qui, il punto spetta.
      await awardSenderPoints({
        senderId, arenaSessionId, source: 'superlike_received',
      }, { db, io });
      senderEarnedPoints = true;
    } else {
      const { underLimit, justReachedLimit } = await isUnderSenderLikeLimit(senderId, arenaSessionId, { db });
      if (underLimit) {
        await awardSenderPoints({
          senderId, arenaSessionId, source: 'like_received',
        }, { db, io });
        senderEarnedPoints = true;
      } else if (justReachedLimit) {
        // Il primo like che supera il tetto — un avviso, una volta
        // sola, non ripetuto per ogni like successivo mentre si
        // resta sopra il limite (sarebbe fastidioso).
        io.to(`user_${senderId}`).emit('like_limit_reached', {});
      }
      // Oltre il tetto: il like parte comunque (nessun blocco),
      // semplicemente non genera punti extra al mittente — a meno
      // che non abbia acquistato crediti extra (vedi purchaseLikeCredits).
    }
  }

  // Notifica PRIVATA — mai alla stanza dell'Arena. Il Like resta
  // anonimo nel payload (nessun senderId), il Superlike mostra
  // il mittente perché è la sua natura fin dall'inizio. Includiamo
  // anche i punti veri guadagnati, per il popup che li mostra
  // ovunque ci si trovi nell'app.
  const senderProfile = type === 'superlike' ? await getSenderProfile(senderId, { db }) : null;
  io.to(`user_${receiverId}`).emit(type === 'superlike' ? 'superlike_received' : 'like_received', {
    interactionId: newInteraction.id,
    senderId: type === 'superlike' ? senderId : null,
    senderName: senderProfile?.displayName || null,
    senderPhotoUrl: senderProfile?.photoUrl || null,
    senderAvatarEmoji: senderProfile?.avatarEmoji || null,
    countedForPoints: countsForPoints,
    points: receiverLocalPoints,
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

      // Anti-abuso punti: un match vero blocca da qui in poi
      // qualunque NUOVA interazione tra queste due persone, in
      // entrambe le direzioni — altrimenti potrebbero rimandarsi
      // Like all'infinito solo per farsi salire i punti a vicenda.
      await blockBothDirectionsPermanently({ userAId: senderId, userBId: receiverId }, { db });

      io.to(`user_${senderId}`).emit('chat_unlocked', { withUserId: receiverId, conversationId: matchConversationId, viaReciprocalLike: true });
      io.to(`user_${receiverId}`).emit('chat_unlocked', { withUserId: senderId, conversationId: matchConversationId, viaReciprocalLike: true });

      // Bonus punti a ENTRAMBI per il match — 5 punti fissi a testa,
      // nessun +30% (a differenza del Pulse+Like, qui non c'è un
      // minigioco da giocare o skippare, il match scatta da solo
      // appena il secondo Like arriva). Chiamato per entrambe le
      // persone coinvolte, ciascuna sul proprio lato (locale + globale
      // per chi lo riceve tramite awardPoints, locale per chi lo
      // "invia" tramite awardSenderPoints — qui però il concetto di
      // "invio" non si applica in modo netto: entrambi hanno sia
      // inviato che ricevuto un Like, quindi entrambi passano da
      // awardPoints per la propria metà del match).
      await awardPoints({ receiverId: senderId, arenaSessionId, source: 'like_match', senderId: receiverId }, { db, io });
      await awardPoints({ receiverId, arenaSessionId, source: 'like_match', senderId }, { db, io });
    }
  }

  return { success: true, countedForPoints: countsForPoints, senderEarnedPoints, reciprocalMatch, matchConversationId };
}

/**
 * Risposta a un Superlike semplice (senza Pulse allegata) — stessa
 * logica di accetta/rifiuta/lascia-in-sospeso già decisa per la
 * Pulse, mai implementata finora per il Superlike puro.
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
    // Rifiuto = un "no" attivo e voluto → blocco per sempre.
    // Sospeso = nessuna decisione vera, magari solo distrazione o
    // un umore diverso quella sera → blocco solo per QUESTA serata,
    // da quella successiva si può ritentare. Un blocco già
    // permanente non torna MAI indietro a "solo stasera", anche se
    // arriva un nuovo "ignora" più avanti — resta sempre il più
    // forte dei due mai deciso finora.
    const newArenaSessionId = action === 'reject' ? null : interaction.arena_session_id;
    const newReason = action === 'reject' ? 'rejection' : null;
    await db.query(`
      INSERT INTO blocks (blocker_id, blocked_id, arena_session_id, reason) VALUES ($1, $2, $3, $4)
      ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
        arena_session_id = CASE WHEN blocks.arena_session_id IS NULL THEN NULL ELSE EXCLUDED.arena_session_id END,
        reason = CASE WHEN blocks.reason = 'rejection' THEN 'rejection' ELSE COALESCE(EXCLUDED.reason, blocks.reason) END,
        created_at = now()
    `, [receiverId, interaction.sender_id, newArenaSessionId, newReason]);
    await db.query(`
      UPDATE interactions SET status = $1 WHERE id = $2
    `, [action === 'reject' ? 'rejected' : 'ignored', interactionId]);

    // Stesso principio già applicato alla Pulse (14/8): un rifiuto
    // esplicito è una decisione chiara e definitiva, il credito
    // torna indietro subito. "Ignora" invece aspetta che il
    // destinatario lasci davvero il locale — v. STEP 2.5 in
    // populive-checkin-logic.js, esteso per coprire anche i
    // Superlike, non solo le Pulse.
    if (action === 'reject') {
      await db.query(`UPDATE users SET superlike_balance = superlike_balance + 1 WHERE id = $1`, [interaction.sender_id]);
    }

    return { success: true, action, senderNotified: false };
  }

  if (action === 'accept') {
    await db.query(`UPDATE interactions SET status = 'matched' WHERE id = $1`, [interactionId]);

    const chat = await openChatConversation({
      userAId: interaction.sender_id, userBId: receiverId,
      arenaSessionId: interaction.arena_session_id, unlockedVia: 'superlike',
    }, { db, io });

    // Anti-abuso punti: stesso principio del Like reciproco — un
    // Superlike accettato è un "sì" vero, non deve poter essere
    // ripetuto all'infinito solo per far salire i punti.
    await blockBothDirectionsPermanently({ userAId: interaction.sender_id, userBId: receiverId }, { db });

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

// Tetto lato MITTENTE: solo i primi LIKE_SENDER_FREE_LIMIT like
// inviati in questa Arena generano punti a chi li manda. Conta
// anche eventuali crediti extra acquistati (fase fintech successiva).
async function isUnderSenderLikeLimit(senderId, arenaSessionId, { db }) {
  const sentCount = await db.query(`
    SELECT COUNT(*) FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND source = 'like_received_sent'
  `, [senderId, arenaSessionId]);

  const purchasedCredits = await getPurchasedLikeCredits(senderId, arenaSessionId, { db });
  const threshold = LIKE_SENDER_FREE_LIMIT + purchasedCredits;

  return {
    underLimit: sentCount < threshold,
    // true SOLO per il primo invio che supera il tetto — serve per
    // avvisare una volta sola, non ripetutamente ad ogni like
    // successivo mentre si resta sopra il limite.
    justReachedLimit: sentCount === threshold,
  };
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
 * Pulse scontate") inserendo solo una riga in iap_products — questa
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

    case 'superlike_credits':
      // A differenza del like_credits (letto al bisogno), qui il
      // Superlike è un vero saldo — l'acquisto lo ricarica subito.
      // IMPORTANTE: qui NESSUN tetto — il tetto di 10 vale solo per
      // l'accumulo GRATUITO settimanale (per non lasciarlo crescere
      // all'infinito se non lo usi); comprare è denaro vero, nessun
      // motivo di limitare quanti pacchetti qualcuno voglia prendere
      // in una singola serata.
      await db.query(`
        UPDATE users SET superlike_balance = superlike_balance + $1 WHERE id = $2
      `, [config.credits, userId]);
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

    case 'pulse_bundle':
      // Un credito = una consumazione generica, il valore vero è
      // deciso a monte con ogni locale — nessun controllo di prezzo
      // qui: se qualcuno prova a chiedere un drink chiaramente fuori
      // scala (es. un flûte di Dom Pérignon), è il BARTENDER a
      // rifiutare guardando la consumazione richiesta sull'app,
      // esattamente come già succede per il riscatto stesso. Mai una
      // scadenza: restano validi finché non li usi, in qualunque
      // locale partner presente e futuro.
      await db.query(`
        UPDATE users SET paid_pulse_credits = paid_pulse_credits + $1 WHERE id = $2
      `, [config.credits, userId]);
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
async function trackProfileView({ viewerId, viewedUserId, arenaSessionId, viaHistoricalBoard }, { db, io }) {
  if (viewerId === viewedUserId) return { success: true, skipped: true }; // non contano le proprie

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 AND (arena_session_id IS NULL OR arena_session_id = $3)
  `, [viewedUserId, viewerId, arenaSessionId]);
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

  // Il destinatario (chi viene visto) riceve sempre il suo punto —
  // ogni visita a lui è comunque un segnale genuino, nessun rischio
  // di spam dal SUO lato.
  await awardPoints({ receiverId: viewedUserId, arenaSessionId, source: 'profile_view', viaHistoricalBoard }, { db, io });

  // Il VISITATORE invece riceve il proprio piccolo incentivo solo
  // per le prime N persone DIVERSE viste in questa sessione — oltre
  // quel tetto, può continuare a guardare profili liberamente, ma
  // senza più guadagnare punti lui stesso (altrimenti basterebbe
  // scorrere il radar all'infinito per punti gratis).
  const distinctViewsCount = await db.query(`
    SELECT COUNT(DISTINCT viewed_user_id) AS total FROM profile_views
    WHERE viewer_id = $1 AND arena_session_id = $2
  `, [viewerId, arenaSessionId]);

  if (parseInt(distinctViewsCount.total) <= MAX_DISTINCT_VIEWS_PER_SESSION) {
    await awardSenderPoints({ senderId: viewerId, arenaSessionId, source: 'profile_view' }, { db, io });
  }

  // Notifica privata, leggera: non svela chi ha guardato (coerente
  // con l'anonimato generale del radar), solo che "qualcuno" l'ha fatto.
  io.to(`user_${viewedUserId}`).emit('profile_viewed', { countedForPoints: true });

  return { success: true, alreadyCounted: false };
}
// Questa funzione va chiamata PRIMA di creare un Superlike o una
// Pulse+Superlike (mai per il Like semplice o la Pulse standalone/
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
// PARTE 1b — Creazione VERA della Pulse nel database. Volutamente
// separata dall'invio: questa funzione presuppone che il pagamento
// sia GIÀ risolto (gratis, account di prova, o confermato da Stripe)
// — non fa mai controlli sui soldi, solo sulla logica del prodotto.
// Chiamata da initiatePulsePurchase (per il caso gratis/test, subito)
// e dal webhook Stripe (per il caso pagato, solo a conferma avvenuta).
// ------------------------------------------------------------
async function createPulseRecord({ senderId, receiverId, arenaSessionId, drinkName, priceCents, tier, paymentStatus, stripeCheckoutSessionId }, { db, redis, io }) {

  // Il Superlike allegato si scala SOLO qui — il momento vero in cui
  // la Pulse nasce per davvero, indipendentemente da quale dei
  // percorsi di pagamento l'ha portata fin qui (test/gratis/
  // pre-pagato/Stripe). Il controllo "ce n'è almeno uno" era già
  // stato fatto prima, qui lo consumiamo per davvero.
  if (tier === 'super') {
    await db.query(`UPDATE users SET superlike_balance = superlike_balance - 1 WHERE id = $1`, [senderId]);
  }

  let guessesRemaining = null;
  if (tier === 'like') {
    guessesRemaining = await computeGuessAllowance(arenaSessionId, { redis });
  }

  const pulse = await db.query(`
    INSERT INTO pulses (sender_id, receiver_id, arena_session_id, drink_type,
                        price_cents, tier, guesses_remaining, payment_status, stripe_checkout_session_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [senderId, receiverId, arenaSessionId, drinkName, priceCents, tier, guessesRemaining, paymentStatus, stripeCheckoutSessionId || null]);

  // GHOST MODE — stessa regola di Like/Superlike: se il mittente è
  // un fantasma, si rivela SOLO nel radar di chi riceve la Pulse,
  // qualunque sia la variante (anche standalone/+Like, che restano
  // comunque anonime come interazione — qui parliamo solo di
  // farlo comparire come profilo tra i candidati).
  const pulseSenderGhostRow = await db.query(`SELECT ghost_mode_enabled FROM users WHERE id = $1`, [senderId]);
  if (pulseSenderGhostRow?.ghost_mode_enabled) {
    io.to(`user_${receiverId}`).emit('ghost_revealed', { userId: senderId });
  }

  // Punti al mittente per l'invio stesso — piccolo incentivo per
  // aver compiuto l'azione, coerente con tutte le altre interazioni
  // (visita, like, superlike). La Pulse costa già denaro reale, quindi
  // qui il valore è comunque contenuto rispetto a quello che riceverà
  // chi la riceve.
  await awardSenderPoints({ senderId, arenaSessionId, source: `pulse_${tier}` }, { db, io });

  // Punti a chi RICEVE — sempre, al momento stesso della ricezione,
  // indipendentemente da cosa deciderà dopo (accetta/rifiuta/lascia
  // in sospeso). Prima erano legati solo all'accettazione, un'unica
  // regola diversa rispetto a Like e Superlike (che danno sempre
  // punti al ricevimento) — allineato su richiesta esplicita
  // dell'utente: i punti misurano quanto sei notato, non quante
  // interazioni accetti, ed evita ogni pressione sottile ad
  // accettare "solo per convenienza".
  await awardPoints({
    receiverId, arenaSessionId, source: `pulse_${tier}`, senderId,
  }, { db, io });

  // Notifica privata in tempo reale SOLO al destinatario — mai alla
  // stanza dell'Arena intera, questo è un evento personale.
  // Il payload NON include mai l'identità del mittente per i tier
  // "standalone" e "like" (resta il backend, tramite sender_id nel
  // database, a saperlo — il frontend riceve solo ciò che è coerente
  // con la variante scelta).
  const superSenderProfile = tier === 'super' ? await getSenderProfile(senderId, { db }) : null;
  io.to(`user_${receiverId}`).emit('pulse_received', {
    pulseId: pulse.id,
    tier,
    drinkType: drinkName,
    senderId: tier === 'super' ? senderId : null,
    senderName: superSenderProfile?.displayName || null,
    senderPhotoUrl: superSenderProfile?.photoUrl || null,
    senderAvatarEmoji: superSenderProfile?.avatarEmoji || null,
  });

  return { success: true, pulseId: pulse.id };
}

async function getSenderProfile(senderId, { db }) {
  const sender = await db.query(`SELECT display_name, photo_url, avatar_emoji FROM users WHERE id = $1`, [senderId]);
  return {
    displayName: sender.display_name,
    photoUrl: sender.photo_url,
    avatarEmoji: sender.avatar_emoji || '🙂',
  };
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
// PARTE 2 — Risposta a una Pulse: accetta / rifiuta / ignora
// ------------------------------------------------------------
async function respondToPulse({ pulseId, receiverId, action }, { db, io }) {

  const pulse = await db.query(`SELECT * FROM pulses WHERE id = $1`, [pulseId]);
  if (!pulse || pulse.receiver_id !== receiverId) {
    return { success: false, reason: 'not_found_or_not_yours' };
  }
  if (pulse.status !== 'pending') {
    return { success: false, reason: 'already_decided' };
  }

  // --- RIFIUTA o IGNORA: stesso effetto di fondo (blocco silenzioso) ---
  // La differenza tra le due è SOLO cosa vede chi riceve nella propria
  // interfaccia in questo istante — nessuna delle due manda al mittente
  // un segnale esplicito di rifiuto (per non rischiare di provocare
  // una reazione ostile in chi non accetta bene un "no").
  if (action === 'reject' || action === 'ignore') {
    // Stessa distinzione già applicata al Superlike puro: un
    // rifiuto vero è per sempre, un semplice "in sospeso" vale solo
    // per questa serata — mai un blocco già permanente che torna
    // indietro, qualunque cosa arrivi dopo.
    const newArenaSessionId = action === 'reject' ? null : pulse.arena_session_id;
    const newReason = action === 'reject' ? 'rejection' : null;
    await db.query(`
      INSERT INTO blocks (blocker_id, blocked_id, arena_session_id, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
        arena_session_id = CASE WHEN blocks.arena_session_id IS NULL THEN NULL ELSE EXCLUDED.arena_session_id END,
        reason = CASE WHEN blocks.reason = 'rejection' THEN 'rejection' ELSE COALESCE(EXCLUDED.reason, blocks.reason) END,
        created_at = now()
    `, [receiverId, pulse.sender_id, newArenaSessionId, newReason]);

    await db.query(`
      UPDATE pulses SET status = $1 WHERE id = $2
    `, [action === 'reject' ? 'rejected' : 'ignored', pulseId]);

    // Rimborso SOLO per il rifiuto esplicito — è una decisione chiara
    // e definitiva, nessun motivo di aspettare. Per "ignora" invece
    // si aspetta che la persona lasci davvero il locale (v. STEP 2.5
    // in populive-checkin-logic.js), lasciandole una finestra vera
    // per ripensarci e accettarla comunque prima di quel momento.
    if (action === 'reject') {
      await refundPulseCredit({ userId: pulse.sender_id, pulseId: pulse.id }, { db });
    }

    return { success: true, action, senderNotified: false };
  }

  // --- ACCETTA ---
  // Vale per TUTTI e tre i tier, incluso "like": accettare garantisce
  // sempre la consumazione, a prescindere dall'esito del minigioco.
  // Per il tier "like", il minigioco (attemptGuess) resta disponibile
  // DOPO l'accettazione, ma è solo un bonus per sbloccare la chat —
  // non condiziona mai il possesso della Pulse già accettata.
  if (action === 'accept') {
    const redeemCode = generateRedeemCode();
    await db.query(`
      UPDATE pulses
      SET status = 'accepted',
          chat_unlocked = $1,
          redeem_code = $2
      WHERE id = $3
    `, [pulse.tier === 'super', redeemCode, pulseId]);

    // Anti-abuso punti: stesso principio già applicato a Like
    // reciproco e Superlike — accettare una Pulse (in QUALUNQUE
    // variante, anche standalone/+like) è un "sì" vero, non deve
    // poter essere ripetuto all'infinito solo per far salire i
    // punti. Vale per tutti e tre i tier allo stesso modo, non
    // solo per il Pulse+Superlike.
    await blockBothDirectionsPermanently({ userAId: pulse.sender_id, userBId: receiverId }, { db });

    // I punti per aver ricevuto la Pulse sono già stati assegnati al
    // momento della ricezione vera (in createPulseRecord) — allineato
    // a Like/Superlike, che danno sempre punti al ricevimento, mai
    // legati alla decisione presa dopo. Qui non si riassegnano.
    // standalone → chat_unlocked resta false (nessun contatto, solo il drink)
    // super      → chat_unlocked true da subito (il profilo era già visibile)
    // like       → chat_unlocked resta false per ora: si sblocca SOLO
    //              vincendo il minigioco in attemptGuess, che però non
    //              tocca mai lo status della Pulse (già "accepted" qui)

    // Pulse+Superlike: l'accettazione apre la chat di default (il
    // profilo era già visibile prima di decidere) — creiamo davvero
    // la conversazione, poi avvisiamo in tempo reale entrambe le
    // parti, sempre in privato, mai sulla stanza condivisa dell'Arena.
    let chatConversationId = null;
    if (pulse.tier === 'super') {
      const chat = await openChatConversation({
        userAId: pulse.sender_id, userBId: receiverId,
        arenaSessionId: pulse.arena_session_id, unlockedVia: 'pulse_super',
      }, { db, io });
      chatConversationId = chat.conversationId;

      io.to(`user_${pulse.sender_id}`).emit('chat_unlocked', { pulseId, withUserId: receiverId, conversationId: chatConversationId });
      io.to(`user_${receiverId}`).emit('chat_unlocked', { pulseId, withUserId: pulse.sender_id, conversationId: chatConversationId });
    }

    return {
      success: true,
      action: 'accept',
      chatUnlocked: pulse.tier === 'super',
      conversationId: chatConversationId,
      redeemCode,
      canStillPlayGuessGame: pulse.tier === 'like',   // il frontend sa se offrire il minigioco dopo
    };
  }

  return { success: false, reason: 'invalid_action' };
}

// ------------------------------------------------------------
// PARTE 3 — Mini-gioco della Pulse + Like: tentativo di indovinare
// ------------------------------------------------------------
// NOTA IMPORTANTE: questa funzione si chiama SOLO dopo che la Pulse
// è già stata accettata (status = 'accepted'). Non tocca mai il
// possesso della consumazione — decide solo se si sblocca la chat.
// Chi perde tutti i tentativi tiene comunque la Pulse già sua.
async function attemptGuess({ pulseId, receiverId, guessedUserId }, { db, io }) {

  const pulse = await db.query(`SELECT * FROM pulses WHERE id = $1`, [pulseId]);
  if (!pulse || pulse.receiver_id !== receiverId || pulse.tier !== 'like') {
    return { success: false, reason: 'invalid_request' };
  }
  if (pulse.status !== 'accepted') {
    return { success: false, reason: 'must_accept_pulse_first' };
  }
  if (pulse.chat_unlocked) {
    return { success: false, reason: 'already_unlocked' };
  }
  if (pulse.guesses_remaining <= 0) {
    return { success: false, reason: 'no_attempts_left' };
  }

  const isCorrect = guessedUserId === pulse.sender_id;

  await db.query(`
    INSERT INTO pulse_guess_attempts (pulse_id, guessed_user_id, was_correct)
    VALUES ($1, $2, $3)
  `, [pulseId, guessedUserId, isCorrect]);

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
      arenaSessionId: pulse.arena_session_id,
      type: 'like',
    }, { db, io });
  }

  if (isCorrect) {
    await db.query(`UPDATE pulses SET chat_unlocked = true WHERE id = $1`, [pulseId]);

    // Match riuscito: creiamo davvero la conversazione, poi
    // avvisiamo entrambe le parti in privato — è il momento "wow"
    // del minigioco.
    const chat = await openChatConversation({
      userAId: pulse.sender_id, userBId: receiverId,
      arenaSessionId: pulse.arena_session_id, unlockedVia: 'pulse_like_match',
    }, { db, io });

    io.to(`user_${pulse.sender_id}`).emit('chat_unlocked', { pulseId, withUserId: receiverId, viaGuessGame: true, conversationId: chat.conversationId });
    io.to(`user_${receiverId}`).emit('chat_unlocked', { pulseId, withUserId: pulse.sender_id, viaGuessGame: true, conversationId: chat.conversationId });

    // Bonus punti per un match riuscito — ora a ENTRAMBI (prima solo
    // al ricevente), passando dal vero motore dei moltiplicatori
    // (source dedicato pulse_like_match, +30% via
    // MULTIPLIERS.guess_match_bonus) invece di un valore fisso a
    // parte: si somma correttamente a eventuali altri bonus che
    // ciascuno dei due potesse già avere (Premium, Founder, ecc.).
    // awardPoints/awardSenderPoints emettono già da soli l'evento
    // 'points_update' verso l'Arena — nessun broadcast manuale
    // aggiuntivo necessario qui.
    const matchResult = await awardPoints({
      receiverId, arenaSessionId: pulse.arena_session_id, source: 'pulse_like_match', senderId: pulse.sender_id,
    }, { db, io });
    await awardSenderPoints({
      senderId: pulse.sender_id, arenaSessionId: pulse.arena_session_id, source: 'pulse_like_match',
    }, { db, io });

    return { success: true, matched: true, chatUnlocked: true, bonusPoints: matchResult.localPoints };
  }
  const remaining = pulse.guesses_remaining - 1;
  await db.query(`UPDATE pulses SET guesses_remaining = $1 WHERE id = $2`, [remaining, pulseId]);

  if (remaining <= 0) {
    // Tentativi esauriti: la Pulse resta sua (era già accettata prima
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

/**
 * Elenco delle Pulse ricevute da un utente — usato dalla tab "Pulse"
 * dell'app. Il nome del mittente si mostra SOLO per il tier 'super'
 * (dove è sempre visibile per design) o se la Pulse ha già
 * chat_unlocked = true (reciprocità/match avvenuti) — mai per una
 * Pulse standalone/+like ancora "misteriosa".
 */
async function getReceivedPulses({ userId }, { db }) {
  const pulses = await db.queryAll(`
    SELECT r.id, r.drink_type, r.tier, r.status, r.chat_unlocked, r.created_at, r.redeem_code,
           v.id AS venue_id, v.name AS venue_name,
           CASE WHEN r.tier = 'super' OR r.chat_unlocked THEN u.display_name ELSE NULL END AS sender_name,
           CASE WHEN r.tier = 'super' OR r.chat_unlocked THEN u.id ELSE NULL END AS sender_id,
           CASE WHEN r.tier = 'super' OR r.chat_unlocked THEN u.photo_url ELSE NULL END AS sender_photo_url
    FROM pulses r
    JOIN arena_sessions a ON a.id = r.arena_session_id
    JOIN venues v ON v.id = a.venue_id
    JOIN users u ON u.id = r.sender_id
    WHERE r.receiver_id = $1
      AND (
        (SELECT pulses_cleared_before FROM users WHERE id = $1) IS NULL
        OR r.created_at > (SELECT pulses_cleared_before FROM users WHERE id = $1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dismissed_notifications d
        WHERE d.user_id = $1 AND d.entry_key = 'pulse_view-' || r.id::text
      )
    ORDER BY r.created_at DESC
  `, [userId]);

  return pulses.map((r) => ({
    pulseId: r.id,
    drinkType: r.drink_type,
    tier: r.tier,
    status: r.status,
    venueId: r.venue_id, // serve al frontend per capire se si è nel locale giusto per riscattare
    venueName: r.venue_name,
    senderName: r.sender_name, // null se ancora anonimo
    senderId: r.sender_id, // null se ancora anonimo — serve per aprire il profilo completo dalla riga
    senderPhotoUrl: r.sender_photo_url, // null se ancora anonimo
    createdAt: r.created_at,
    // Solo per quelle accettate ma non ancora riscattate — serve al
    // pulsante "Riscatta ora" nella lista, per aprire il sigillo
    // quando la persona è pronta, non necessariamente subito dopo
    // aver accettato (es. se ha aperto prima la chat).
    redeemCode: r.status === 'accepted' ? r.redeem_code : null,
  }));
}

/**
 * Gemella di getReceivedPulses, ma dal lato di chi ha INVIATO —
 * per la visione complessiva unica richiesta dall'utente (vedere
 * insieme, sulla stessa pagina, ricevute E inviate). Chi le ha
 * mandate conosce già sempre chi è il destinatario (l'ha scelto
 * lui stesso), quindi qui il nome non è mai nascosto — a
 * differenza delle ricevute, dove l'anonimato dipende dalla
 * variante. Nessun redeem_code qui: solo chi riceve può riscattare,
 * mai chi ha inviato.
 */
async function getSentPulses({ userId }, { db }) {
  const pulses = await db.queryAll(`
    SELECT r.id, r.drink_type, r.tier, r.status, r.created_at,
           v.name AS venue_name,
           u.display_name AS receiver_name
    FROM pulses r
    JOIN arena_sessions a ON a.id = r.arena_session_id
    JOIN venues v ON v.id = a.venue_id
    JOIN users u ON u.id = r.receiver_id
    WHERE r.sender_id = $1
      AND (
        (SELECT pulses_cleared_before FROM users WHERE id = $1) IS NULL
        OR r.created_at > (SELECT pulses_cleared_before FROM users WHERE id = $1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dismissed_notifications d
        WHERE d.user_id = $1 AND d.entry_key = 'pulse_view-' || r.id::text
      )
    ORDER BY r.created_at DESC
  `, [userId]);

  return pulses.map((r) => ({
    pulseId: r.id,
    drinkType: r.drink_type,
    tier: r.tier,
    status: r.status,
    venueName: r.venue_name,
    receiverName: r.receiver_name, // sempre visibile, l'ha scelto chi ha inviato
    createdAt: r.created_at,
  }));
}

/**
 * Nasconde una singola Pulse dalla LISTA DI LAVORO (questa
 * schermata) — separato apposta dalle dismissioni del Centro
 * Notifiche (stessa tabella, prefisso diverso nella chiave): sono
 * due viste con scopi diversi, eliminarla da una non deve toccare
 * l'altra. Mai la riga vera sottostante, solo nascosta qui.
 */
async function dismissPulseView({ userId, pulseId }, { db }) {
  await db.query(`
    INSERT INTO dismissed_notifications (user_id, entry_key)
    VALUES ($1, $2)
    ON CONFLICT (user_id, entry_key) DO NOTHING
  `, [userId, `pulse_view-${pulseId}`]);
  return { success: true };
}

/**
 * "Ripulisci tutto" per la lista Pulse — stesso principio del
 * Centro Notifiche (un timestamp solo, non una riga per Pulse).
 */
async function clearAllPulseViews({ userId }, { db }) {
  await db.query(`UPDATE users SET pulses_cleared_before = now() WHERE id = $1`, [userId]);
  return { success: true };
}

/**
 * ============================================================
 * RIMBORSO — Pulse mai accettata dal destinatario
 * ============================================================
 * Decisione presa con l'utente (14/8): se il destinatario rifiuta o
 * ignora e poi se ne va senza mai accettare, chi ha inviato non
 * deve perdere per sempre quello che ha pagato — indipendentemente
 * da come l'aveva pagata (credito gratis, pre-pagato, o pagamento
 * diretto Stripe), il rimborso arriva sempre come UN credito Pulse
 * pronto da rimandare a qualcun altro (mai contanti veri indietro —
 * troppo complesso/costoso gestire un rimborso Stripe vero per
 * ogni caso, e un credito è comunque equivalente in valore).
 * Il MOMENTO del rimborso dipende dal tipo di "no":
 *   - RIFIUTO esplicito → subito (v. sopra in respondToPulse)
 *   - IGNORATA (o mai decisa) → solo quando il destinatario lascia
 *     davvero quel locale (v. STEP 2.5 in populive-checkin-logic.js)
 * Una Pulse già ACCETTATA non rientra mai qui — i soldi sono già
 * "vinti" dal destinatario in quel momento, resta solo da capire
 * DOVE può ritirarla (stessa regola per locale citata sopra).
 * ============================================================
 */
/**
 * ============================================================
 * BLOCCO PERMANENTE BIDIREZIONALE — anti-abuso punti
 * ============================================================
 * Regola decisa con l'utente (14/8): appena scatta un'interazione
 * POSITIVA vera (Like reciproco, Superlike accettato, Pulse
 * accettato in qualunque variante), le due persone non devono più
 * potersi mandare NESSUNA nuova interazione tra loro — altrimenti
 * potrebbero rimandarsi Like/Superlike/Pulse all'infinito solo per
 * far salire i punti a vicenda, truffando il sistema.
 *
 * A differenza del blocco normale (una direzione sola, nato da un
 * rifiuto — chi riceve blocca chi ha inviato), qui servono ENTRAMBE
 * le direzioni: il "sì" è stato reciproco, quindi il blocco lo è
 * altrettanto. Riusa la STESSA tabella blocks già esistente (e già
 * controllata ovunque un'interazione viene inviata) — nessun nuovo
 * controllo da aggiungere nei punti di invio, scatta da solo.
 * Sempre permanente (mai scoped a una sola serata, a differenza di
 * un "lascia in sospeso") — un match vero non si "dimentica" al
 * cambio di serata.
 * ============================================================
 */
async function blockBothDirectionsPermanently({ userAId, userBId, reason = 'match' }, { db }) {
  // Gerarchia di forza tra i motivi: rifiuto (già per sé un "no"
  // definitivo) non torna mai indietro a niente di più debole; un
  // blocco manuale dalla chat vince su un semplice match (nato solo
  // per impedire la ripetizione di punti, non un vero "non voglio
  // più vederti").
  await db.query(`
    INSERT INTO blocks (blocker_id, blocked_id, arena_session_id, reason) VALUES ($1, $2, NULL, $3)
    ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
      arena_session_id = NULL,
      reason = CASE
        WHEN blocks.reason = 'rejection' THEN 'rejection'
        WHEN blocks.reason = 'user_blocked' OR $3 = 'user_blocked' THEN 'user_blocked'
        ELSE $3
      END,
      created_at = now()
  `, [userAId, userBId, reason]);
  await db.query(`
    INSERT INTO blocks (blocker_id, blocked_id, arena_session_id, reason) VALUES ($1, $2, NULL, $3)
    ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
      arena_session_id = NULL,
      reason = CASE
        WHEN blocks.reason = 'rejection' THEN 'rejection'
        WHEN blocks.reason = 'user_blocked' OR $3 = 'user_blocked' THEN 'user_blocked'
        ELSE $3
      END,
      created_at = now()
  `, [userBId, userAId, reason]);
}

async function refundPulseCredit({ userId }, { db }) {
  await db.query(`UPDATE users SET paid_pulse_credits = paid_pulse_credits + 1 WHERE id = $1`, [userId]);
}

/**
 * ============================================================
 * SCADENZA A FINE SERATA — gemella del rimborso per cambio locale
 * ============================================================
 * Buco trovato dall'utente (14/8): l'unico modo di loggarsi è un QR
 * code — se una persona resta nello stesso locale per sempre senza
 * mai scansionarne un altro, una Pulse mai decisa (pending/ignored)
 * potrebbe restare "in sospeso" per mesi, senza che scatti mai il
 * rimborso legato al cambio locale. Questa funzione chiude quel
 * buco: agganciata alla chiusura NATURALE della serata (quando
 * l'Arena si spegne da sola a fine orario), non solo al cambio
 * locale — chi non ha deciso nulla entro la fine della serata la
 * perde comunque, punto. Stessa identica sorte delle Pulse GIÀ
 * accettate però: quelle NON rientrano qui, restano valide a tempo
 * indeterminato come deciso in precedenza — solo pending/ignored.
 * ============================================================
 */
async function refundAbandonedPulsesForSession(arenaSessionId, { db }) {
  const abandoned = await db.queryAll(`
    SELECT id, sender_id FROM pulses
    WHERE arena_session_id = $1 AND status IN ('pending', 'ignored')
  `, [arenaSessionId]);

  for (const p of abandoned) {
    await refundPulseCredit({ userId: p.sender_id }, { db });
  }

  if (abandoned.length > 0) {
    await db.query(`
      UPDATE pulses SET status = 'expired'
      WHERE id = ANY($1)
    `, [abandoned.map((p) => p.id)]);
  }
}

/**
 * ============================================================
 * INVISIBILITÀ RECIPROCA NEL RADAR DOPO UN BLOCCO PERMANENTE
 * ============================================================
 * Decisione presa con l'utente (22/8), suggerita da Giuseppe: un
 * rifiuto crea un blocco permanente ma A SENSO UNICO (solo chi è
 * stato rifiutato non può più scrivere a chi ha rifiutato — v.
 * commento sopra in respondToPulse/respondToSuperlike). Per il
 * RADAR però si è deciso diversamente: invisibilità RECIPROCA,
 * indipendentemente da chi abbia rifiutato chi — altrimenti la
 * persona rifiutata continuerebbe comunque a vedere chi l'ha
 * rifiutata nello stesso locale, senza poterle scrivere, probabile
 * fonte di imbarazzo/nervosismo proprio quanto il contrario.
 * Ogni telefono filtra DA SÉ la propria lista del radar (più
 * semplice e robusto che far scegliere al server, connessione per
 * connessione, chi escludere da una trasmissione broadcast).
 * ============================================================
 */
async function getPermanentlyBlockedPairUserIds({ userId }, { db }) {
  const rows = await db.queryAll(`
    SELECT blocker_id, blocked_id FROM blocks
    WHERE (blocker_id = $1 OR blocked_id = $1) AND arena_session_id IS NULL AND reason IN ('rejection', 'user_blocked')
  `, [userId]);
  return [...new Set(rows.map((r) => (r.blocker_id === userId ? r.blocked_id : r.blocker_id)))];
}

/**
 * ============================================================
 * BLOCCA DALLA CHAT — richiesta esplicita dell'utente (22/8)
 * ============================================================
 * Consolidamento di due idee future citate insieme: un vero
 * bottone "Blocca" dentro la chat, che copre anche la
 * "cancellazione della chat" (bloccare qualcuno chiude per forza
 * anche la conversazione in corso — non avrebbe senso restasse
 * aperta con chi si è appena bloccato).
 * Blocco SEMPRE bidirezionale (a differenza del rifiuto, che è a
 * senso unico) — un blocco manuale è una scelta forte e deliberata,
 * nessuna delle due parti deve più poter contattare l'altra.
 * ============================================================
 */
async function blockUserFromChat({ conversationId, blockerId }, { db, io }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== blockerId && conv.user_b_id !== blockerId) {
    return { success: false, reason: 'not_a_participant' };
  }

  const otherUserId = conv.user_a_id === blockerId ? conv.user_b_id : conv.user_a_id;

  await blockBothDirectionsPermanently({ userAId: blockerId, userBId: otherUserId, reason: 'user_blocked' }, { db });

  if (!conv.closed_at) {
    await db.query(`UPDATE chat_conversations SET closed_at = now() WHERE id = $1`, [conversationId]);
  }

  // Notifica alla persona bloccata che la chat si è chiusa — MAI
  // dire esplicitamente "sei stato bloccato" (potrebbe provocare
  // una reazione ostile), stesso principio già usato per rifiuto/
  // sospeso: un "no" silenzioso, mai annunciato con enfasi.
  io.to(`user_${otherUserId}`).emit('chat_closed', { conversationId, reason: 'blocked' });
  io.to(`user_${blockerId}`).emit('chat_closed', { conversationId, reason: 'blocked' });

  return { success: true };
}

/**
 * Saldo Pulse disponibili per l'invio — separato tra quelli
 * gratuiti settimanali e quelli pre-pagati (comprati in pacchetto,
 * mai a scadenza), così il frontend può mostrarli distinti se serve
 * ma anche il totale utilizzabile subito.
 */
async function getPulseBalance({ userId }, { db }) {
  const user = await db.query(`
    SELECT free_pulses_balance, paid_pulse_credits FROM users WHERE id = $1
  `, [userId]);
  if (!user) return { success: false, reason: 'user_not_found' };

  return {
    success: true,
    freeBalance: user.free_pulses_balance || 0,
    paidCredits: user.paid_pulse_credits || 0,
  };
}

/**
 * ============================================================
 * CENTRO NOTIFICHE — storico cronologico completo
 * ============================================================
 * Unisce Like, Superlike e Pulse (tutte le varianti) — sia inviate
 * sia ricevute — in un unico elenco ordinato per data. Rispetta le
 * STESSE regole di anonimato già in vigore ovunque nell'app: mai
 * svelare a chi riceve un Like/Pulse anonimo chi sia stato, a meno
 * che non sia scattato davvero un match/sblocco chat — le proprie
 * azioni inviate invece sono sempre visibili per intero (le ha
 * scelte la persona stessa).
 *
 * Un match da Like reciproco NON compare come due righe separate
 * ("hai mandato un Like" + "hai ricevuto un Like, svelato") — le
 * due righe originali vengono escluse ed è sostituita da UN'UNICA
 * notifica di festeggiamento ("Hai matchato con [nome]!"), stile
 * Facebook/Tinder — molto più pulito che raccontare due volte lo
 * stesso evento da due lati diversi. Rilevato direttamente dai due
 * Like reciproci nella tabella interactions (non dalla chat
 * associata) — una stessa coppia può già avere una conversazione
 * aperta da un motivo diverso (es. un Superlike precedente), che
 * verrebbe solo RIUSATA per il match successivo invece di crearne
 * una nuova, rendendo inaffidabile un controllo basato su quella.
 * ============================================================
 */
async function getInteractionHistory({ userId }, { db }) {
  const rows = await db.queryAll(`
    WITH combined AS (
      (
        SELECT i.id::text AS id, i.type AS kind, i.status, i.created_at,
               CASE WHEN i.sender_id = $1 THEN 'sent' ELSE 'received' END AS direction,
               CASE WHEN i.sender_id = $1 THEN i.receiver_id ELSE i.sender_id END AS other_user_id,
               NULL AS drink_type, NULL AS chat_unlocked
        FROM interactions i
        WHERE (i.sender_id = $1 OR i.receiver_id = $1)
          AND NOT (
            i.type = 'like' AND EXISTS(
              SELECT 1 FROM interactions r
              WHERE r.sender_id = i.receiver_id AND r.receiver_id = i.sender_id AND r.type = 'like'
            )
          )
      )
      UNION ALL
      (
        SELECT p.id::text AS id, ('pulse_' || p.tier) AS kind, p.status, p.created_at,
               CASE WHEN p.sender_id = $1 THEN 'sent' ELSE 'received' END AS direction,
               CASE WHEN p.sender_id = $1 THEN p.receiver_id ELSE p.sender_id END AS other_user_id,
               p.drink_type, p.chat_unlocked
        FROM pulses p
        WHERE p.sender_id = $1 OR p.receiver_id = $1
      )
      UNION ALL
      (
        SELECT MIN(i.id::text) AS id, 'like_match' AS kind, 'matched' AS status,
               MAX(i.created_at) AS created_at,
               'match' AS direction,
               CASE WHEN i.sender_id = $1 THEN i.receiver_id ELSE i.sender_id END AS other_user_id,
               NULL AS drink_type, NULL AS chat_unlocked
        FROM interactions i
        WHERE i.type = 'like' AND (i.sender_id = $1 OR i.receiver_id = $1)
          AND EXISTS (
            SELECT 1 FROM interactions r
            WHERE r.type = 'like'
              AND r.sender_id = CASE WHEN i.sender_id = $1 THEN i.receiver_id ELSE i.sender_id END
              AND r.receiver_id = $1
          )
        GROUP BY other_user_id
      )
    )
    -- Nascosti, non cancellati: sia il "ripulisci tutto" (tutto ciò
    -- che è più vecchio del momento in cui è stato premuto) sia le
    -- singole "x" mai tolgono le righe vere sottostanti.
    SELECT c.* FROM combined c
    WHERE (
      (SELECT notifications_cleared_before FROM users WHERE id = $1) IS NULL
      OR c.created_at > (SELECT notifications_cleared_before FROM users WHERE id = $1)
    )
    AND NOT EXISTS (
      SELECT 1 FROM dismissed_notifications d
      WHERE d.user_id = $1 AND d.entry_key = c.kind || '-' || c.id
    )
    ORDER BY created_at DESC
    LIMIT 150
  `, [userId]);

  // Chi va svelato: sempre le proprie azioni inviate E i match (per
  // definizione un match svela già l'identità a entrambi); per il
  // resto ricevuto, solo Superlike/Pulse+Superlike (mostrano sempre
  // l'identità, coerente col resto dell'app) o una Pulse anonima
  // con chat_unlocked vero. Un Like ricevuto SENZA match resta
  // sempre anonimo qui — se avesse portato a un match, non
  // comparirebbe più come riga a sé (v. sopra, escluso alla fonte).
  const revealed = rows.map((r) => {
    let reveal = false;
    if (r.direction === 'sent' || r.direction === 'match') {
      reveal = true;
    } else if (r.kind === 'superlike' || r.kind === 'pulse_super') {
      reveal = true;
    } else if (r.kind === 'pulse_standalone' || r.kind === 'pulse_like') {
      reveal = !!r.chat_unlocked;
    }
    return { ...r, reveal };
  });

  const idsToFetch = [...new Set(revealed.filter((r) => r.reveal).map((r) => r.other_user_id))];
  const profiles = {};
  if (idsToFetch.length > 0) {
    const profileRows = await db.queryAll(`
      SELECT id, display_name, photo_url FROM users WHERE id = ANY($1)
    `, [idsToFetch]);
    profileRows.forEach((p) => { profiles[p.id] = { displayName: p.display_name, photoUrl: p.photo_url }; });
  }

  return revealed.map((r) => ({
    id: r.id,
    kind: r.kind, // 'like' | 'superlike' | 'pulse_standalone' | 'pulse_like' | 'pulse_super' | 'like_match'
    status: r.status,
    direction: r.direction, // 'sent' | 'received' | 'match'
    createdAt: r.created_at,
    drinkType: r.drink_type,
    otherPerson: r.reveal ? (profiles[r.other_user_id] || null) : null,
  }));
}

/**
 * Numero sul pallino della scheda Notifiche — quante interazioni
 * ricevute (Like/Superlike/Pulse insieme) da quando la persona ha
 * aperto DAVVERO il Centro Notifiche l'ultima volta. Colonna
 * dedicata (notifications_last_seen_at), separata apposta da
 * last_seen_at (quella serve al "Bentornato" e ai suoi punti, un
 * concetto diverso).
 */
async function getUnseenNotificationCount({ userId }, { db }) {
  const row = await db.query(`
    SELECT COUNT(*) AS total FROM (
      (SELECT id, created_at FROM interactions WHERE receiver_id = $1)
      UNION ALL
      (SELECT id, created_at FROM pulses WHERE receiver_id = $1)
    ) combined
    WHERE created_at > (SELECT notifications_last_seen_at FROM users WHERE id = $1)
  `, [userId]);
  return parseInt(row?.total) || 0;
}

async function markNotificationsSeen({ userId }, { db }) {
  await db.query(`UPDATE users SET notifications_last_seen_at = now() WHERE id = $1`, [userId]);
  return { success: true };
}

/**
 * Nasconde una singola notifica (la "x" su una riga) — mai la riga
 * vera sottostante, solo un segno "non mostrarla più a questa
 * persona" in una tabella leggera a sé.
 */
async function dismissNotification({ userId, kind, entryId }, { db }) {
  await db.query(`
    INSERT INTO dismissed_notifications (user_id, entry_key)
    VALUES ($1, $2)
    ON CONFLICT (user_id, entry_key) DO NOTHING
  `, [userId, `${kind}-${entryId}`]);
  return { success: true };
}

/**
 * "Ripulisci tutto" — un solo timestamp aggiornato, non una riga
 * per ogni notifica esistente (che con centinaia di interazioni
 * crescerebbe senza limite). Nasconde tutto ciò che è più vecchio
 * di questo momento; quello che arriva DOPO resta visibile.
 */
async function clearAllNotifications({ userId }, { db }) {
  await db.query(`UPDATE users SET notifications_cleared_before = now() WHERE id = $1`, [userId]);
  return { success: true };
}

module.exports = { canSendDirectContact, sendInteraction, trackProfileView, createPulseRecord, respondToPulse, attemptGuess, applyPurchaseEffect, respondToSuperlike, getReceivedPulses, getSentPulses, getPulseBalance, getInteractionHistory, getUnseenNotificationCount, markNotificationsSeen, dismissNotification, clearAllNotifications, dismissPulseView, clearAllPulseViews, refundPulseCredit, refundAbandonedPulsesForSession, getPermanentlyBlockedPairUserIds, blockUserFromChat };
