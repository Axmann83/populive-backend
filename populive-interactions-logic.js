/**
 * ============================================================
 * POPULIVE — INVIO INTERAZIONI E RISPOSTA ALLE ROSE
 * ============================================================
 */

const { awardPoints, awardSenderPoints, LIKE_SENDER_FREE_LIMIT, GUESS_GAME_BONUS_POINTS, MAX_DISTINCT_VIEWS_PER_SESSION } = require('./populive-points-engine');
const { openChatConversation } = require('./populive-chat-logic');


async function sendInteraction({ senderId, receiverId, arenaSessionId, type }, { db, io, redis }) {
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

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [receiverId, senderId]);
  if (blocked) return { success: false, reason: 'blocked_by_receiver' };

  if (type === 'superlike') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };

    const sender = await db.query(`SELECT superlike_balance FROM users WHERE id = $1`, [senderId]);
    if (!sender || sender.superlike_balance <= 0) {
      return { success: false, reason: 'superlike_balance_exhausted' };
    }
    await db.query(`UPDATE users SET superlike_balance = superlike_balance - 1 WHERE id = $1`, [senderId]);
  }

  const countsForPoints = type === 'superlike'
    ? true
    : await isUnderDailyLikeLimit(receiverId, { db });

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

  let senderEarnedPoints = false;
  if (countsForPoints) {
    if (type === 'superlike') {
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
        io.to(`user_${senderId}`).emit('like_limit_reached', {});
      }
    }
  }

  io.to(`user_${receiverId}`).emit(type === 'superlike' ? 'superlike_received' : 'like_received', {
    senderId: type === 'superlike' ? senderId : null,
    senderName: type === 'superlike' ? await getSenderName(senderId, { db }) : null,
    countedForPoints: countsForPoints,
    points: receiverLocalPoints,
  });

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
  const DAILY_LIKE_LIMIT = 5;
  const count = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'like' AND counts_for_points = true
      AND created_at >= current_business_day_start($1)
  `, [receiverId]);
  return count < DAILY_LIKE_LIMIT;
}

async function isUnderSenderLikeLimit(senderId, arenaSessionId, { db }) {
  const sentCount = await db.query(`
    SELECT COUNT(*) FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND source = 'like_received_sent'
  `, [senderId, arenaSessionId]);

  const purchasedCredits = await getPurchasedLikeCredits(senderId, arenaSessionId, { db });
  const threshold = LIKE_SENDER_FREE_LIMIT + purchasedCredits;

  return {
    underLimit: sentCount < threshold,
    justReachedLimit: sentCount === threshold,
  };
}

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


async function applyPurchaseEffect({ userId, productId, arenaSessionId, externalTransactionId }, { db }) {
  const product = await db.query(`SELECT * FROM iap_products WHERE id = $1 AND is_active = true`, [productId]);
  if (!product) return { success: false, reason: 'product_not_found_or_inactive' };

  const config = product.effect_config;
  let expiresAt = null;

  switch (product.product_type) {
    case 'like_credits':
      break;

    case 'superlike_credits':
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
        await db.query(`
          INSERT INTO verification_requests (user_id, purchase_id, status)
          VALUES ($1, NULL, 'pending')
        `, [userId]);
      } else {
        await db.query(`UPDATE users SET is_verified = true WHERE id = $1`, [userId]);
      }
      break;

    case 'rosa_bundle':
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


async function trackProfileView({ viewerId, viewedUserId, arenaSessionId }, { db, io }) {
  if (viewerId === viewedUserId) return { success: true, skipped: true };

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [viewedUserId, viewerId]);
  if (blocked) return { success: false, reason: 'blocked_by_viewed_user' };

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

  const distinctViewsCount = await db.query(`
    SELECT COUNT(DISTINCT viewed_user_id) AS total FROM profile_views
    WHERE viewer_id = $1 AND arena_session_id = $2
  `, [viewerId, arenaSessionId]);

  if (parseInt(distinctViewsCount.total) <= MAX_DISTINCT_VIEWS_PER_SESSION) {
    await awardSenderPoints({ senderId: viewerId, arenaSessionId, source: 'profile_view' }, { db, io });
  }

  io.to(`user_${viewedUserId}`).emit('profile_viewed', { countedForPoints: true });

  return { success: true, alreadyCounted: false };
}

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


async function createRosaRecord({ senderId, receiverId, arenaSessionId, drinkName, priceCents, tier, paymentStatus, stripeCheckoutSessionId }, { db, redis, io }) {

  let guessesRemaining = null;
  if (tier === 'like') {
    guessesRemaining = await computeGuessAllowance(arenaSessionId, { redis });
  }

  const rosa = await db.query(`
    INSERT INTO roses (sender_id, receiver_id, arena_session_id, drink_type,
                        price_cents, tier, guesses_remaining, payment_status, stripe_checkout_session_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [senderId, receiverId, arenaSessionId, drinkName, priceCents, tier, guessesRemaining, paymentStatus, stripeCheckoutSessionId || null]);

  await awardSenderPoints({ senderId, arenaSessionId, source: `rosa_${tier}` }, { db, io });

  io.to(`user_${receiverId}`).emit('rosa_received', {
    rosaId: rosa.id,
    tier,
    drinkType: drinkName,
    senderName: tier === 'super' ? await getSenderName(senderId, { db }) : null,
  });

  return { success: true, rosaId: rosa.id };
}

async function getSenderName(senderId, { db }) {
  const sender = await db.query(`SELECT display_name FROM users WHERE id = $1`, [senderId]);
  return sender.display_name;
}

async function computeGuessAllowance(arenaSessionId, { redis }) {
  const arenaSize = await redis.scard(`arena:${arenaSessionId}:radar`);

  if (arenaSize <= 15)  return 1;
  if (arenaSize <= 50)  return 2;
  if (arenaSize <= 100) return 3;
  return 4;
}


async function respondToRosa({ rosaId, receiverId, action }, { db, io }) {

  const rosa = await db.query(`SELECT * FROM roses WHERE id = $1`, [rosaId]);
  if (!rosa || rosa.receiver_id !== receiverId) {
    return { success: false, reason: 'not_found_or_not_yours' };
  }
  if (rosa.status !== 'pending') {
    return { success: false, reason: 'already_decided' };
  }

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

  if (action === 'accept') {
    const redeemCode = generateRedeemCode();
    await db.query(`
      UPDATE roses
      SET status = 'accepted',
          chat_unlocked = $1,
          redeem_code = $2
      WHERE id = $3
    `, [rosa.tier === 'super', redeemCode, rosaId]);

    await awardPoints({
      receiverId,
      arenaSessionId: rosa.arena_session_id,
      source: `rosa_${rosa.tier}`,
      senderId: rosa.sender_id,
    }, { db, io });

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
      canStillPlayGuessGame: rosa.tier === 'like',
    };
  }

  return { success: false, reason: 'invalid_action' };
}

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

    const chat = await openChatConversation({
      userAId: rosa.sender_id, userBId: receiverId,
      arenaSessionId: rosa.arena_session_id, unlockedVia: 'rosa_like_match',
    }, { db, io });

    io.to(`user_${rosa.sender_id}`).emit('chat_unlocked', { rosaId, withUserId: receiverId, viaGuessGame: true, conversationId: chat.conversationId });
    io.to(`user_${receiverId}`).emit('chat_unlocked', { rosaId, withUserId: rosa.sender_id, viaGuessGame: true, conversationId: chat.conversationId });

    await db.query(`
      INSERT INTO points_ledger (user_id, arena_session_id, points, source)
      VALUES ($1, $2, $3, 'rosa_guess_won')
    `, [receiverId, rosa.arena_session_id, GUESS_GAME_BONUS_POINTS]);

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
    return { success: true, matched: false, attemptsExhausted: true };
  }

  return { success: true, matched: false, attemptsRemaining: remaining };
}


function generateRedeemCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
    senderName: r.sender_name,
    createdAt: r.created_at,
  }));
}

module.exports = { canSendDirectContact, sendInteraction, trackProfileView, createRosaRecord, respondToRosa, attemptGuess, applyPurchaseEffect, respondToSuperlike, getReceivedRoses };
