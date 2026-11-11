/**
 * ============================================================
 * POPULIVE — BADGE VERIFICATO (lotto 9, novembre 2026)
 * ============================================================
 * Gratis (decisione dell'utente dell'11/11, prima costava 5 € e la
 * richiesta finiva in una coda che nessuna schermata mostrava).
 *
 *  1) chi lo chiede riceve un gesto a caso (startVerification): la
 *     richiesta nasce con stato 'challenge';
 *  2) scatta un selfie mentre fa quel gesto e lo invia
 *     (submitVerification): stato 'pending', push agli Architetti;
 *  3) un Architetto, dalla dashboard (sezione Verifiche), confronta il
 *     selfie con le foto del profilo e approva o rifiuta
 *     (reviewVerification): is_verified acceso, push all'interessato.
 *
 * Il gesto a caso serve a capire che il selfie è stato fatto adesso e
 * non preso da internet (come Tinder e Bumble). Il confronto del volto
 * si potrà poi automatizzare (es. AWS Rekognition CompareFaces) per
 * dare all'Architetto un punteggio di somiglianza.
 * ============================================================
 */
const { notifyUser } = require('./populive-push');

// Gesti tra cui si sceglie a caso: chiave in inglese (DB), testo per l'app.
const GESTURES = {
  thumbs_up: 'Pollice in su',
  peace_sign: 'Segno di pace (indice e medio a V)',
  hand_on_head: 'Una mano sulla testa',
  three_fingers: 'Tre dita alzate',
  finger_on_cheek: "L'indice sulla guancia",
  open_palm: 'La mano aperta accanto al viso',
};

// Motivi di rifiuto (chiave nel DB, testo per l'utente).
const REJECT_REASONS = {
  gesture_mismatch: 'Nel selfie non si vede il gesto richiesto.',
  face_mismatch: 'Il volto del selfie non corrisponde alle foto del profilo.',
  unclear_photo: 'Il selfie non è abbastanza chiaro.',
};

// Il selfie deve arrivare dal nostro spazio su Cloudinary (lo stesso delle
// foto del profilo, uploadPhotoToStorage nel frontend): niente URL qualunque.
const SELFIE_URL_PREFIX = 'https://res.cloudinary.com/rjkegdrp/';

function gestureInfo(key) {
  return key ? { key, text: GESTURES[key] || key } : null;
}

function rejectReasonText(key) {
  return key ? REJECT_REASONS[key] || 'Verifica non riuscita.' : null;
}

/** Stato della verifica per il profilo di chi la chiede. */
async function getVerificationStatus({ userId }, { db }) {
  const user = await db.query(`SELECT is_verified FROM users WHERE id = $1`, [userId]);
  if (!user) return { success: false, reason: 'user_not_found' };
  if (user.is_verified) return { success: true, status: 'verified' };

  const last = await db.query(
    `
    SELECT status, gesture, reject_reason FROM verification_requests
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [userId]
  );
  if (!last) return { success: true, status: 'none' };
  if (last.status === 'challenge') {
    return { success: true, status: 'challenge', gesture: gestureInfo(last.gesture) };
  }
  if (last.status === 'pending') return { success: true, status: 'pending' };
  if (last.status === 'rejected') {
    return { success: true, status: 'rejected', rejectReason: rejectReasonText(last.reject_reason) };
  }
  return { success: true, status: 'none' };
}

/**
 * Assegna il gesto. Se c'è già una richiesta 'challenge' si riusa lo
 * stesso gesto (riaprire la schermata non lo cambia); una 'pending'
 * aspetta l'Architetto e non se ne apre un'altra.
 */
async function startVerification({ userId }, { db }) {
  const status = await getVerificationStatus({ userId }, { db });
  if (!status.success) return status;
  if (status.status === 'verified') return { success: false, reason: 'already_verified' };
  if (status.status === 'pending') return { success: false, reason: 'already_pending' };
  if (status.status === 'challenge') return { success: true, gesture: status.gesture };

  const keys = Object.keys(GESTURES);
  const gesture = keys[Math.floor(Math.random() * keys.length)];
  await db.query(
    `
    INSERT INTO verification_requests (user_id, purchase_id, status, gesture)
    VALUES ($1, NULL, 'challenge', $2)
  `,
    [userId, gesture]
  );
  return { success: true, gesture: gestureInfo(gesture) };
}

/** Invio del selfie: la richiesta passa agli Architetti. */
async function submitVerification({ userId, selfieUrl }, { db }) {
  if (typeof selfieUrl !== 'string' || !selfieUrl.startsWith(SELFIE_URL_PREFIX)) {
    return { success: false, reason: 'invalid_selfie' };
  }
  const request = await db.query(
    `
    SELECT id FROM verification_requests
    WHERE user_id = $1 AND status = 'challenge'
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [userId]
  );
  if (!request) return { success: false, reason: 'no_challenge' };

  await db.query(
    `
    UPDATE verification_requests
    SET status = 'pending', selfie_url = $1, submitted_at = now()
    WHERE id = $2
  `,
    [selfieUrl, request.id]
  );

  const architects = await db.queryAll(`SELECT user_id FROM architects`);
  for (const { user_id: architectId } of architects) {
    if (architectId !== userId) notifyUser({ userId: architectId, event: 'verification_request' }, { db });
  }
  return { success: true };
}

/** Dashboard: richieste da guardare, le più vecchie prima. */
async function listPendingVerifications({}, { db }) {
  const rows = await db.queryAll(
    `
    SELECT vr.id, vr.gesture, vr.selfie_url, vr.submitted_at,
           u.id AS user_id, u.display_name, u.photo_url, u.photo_urls, u.avatar_emoji
    FROM verification_requests vr
    JOIN users u ON u.id = vr.user_id
    WHERE vr.status = 'pending' AND u.deleted_at IS NULL
    ORDER BY vr.submitted_at ASC
  `,
    []
  );
  return {
    success: true,
    requests: rows.map((r) => ({
      id: r.id,
      gesture: gestureInfo(r.gesture),
      selfieUrl: r.selfie_url,
      submittedAt: r.submitted_at,
      user: {
        userId: r.user_id,
        displayName: r.display_name,
        photoUrls: r.photo_urls && r.photo_urls.length > 0 ? r.photo_urls : r.photo_url ? [r.photo_url] : [],
        avatarEmoji: r.avatar_emoji || '🙂',
      },
    })),
    rejectReasons: Object.entries(REJECT_REASONS).map(([key, text]) => ({ key, text })),
  };
}

/** Dashboard: approva o rifiuta una richiesta 'pending'. */
async function reviewVerification({ requestId, architectId, approve, rejectReason }, { db, io }) {
  if (!approve && !REJECT_REASONS[rejectReason]) return { success: false, reason: 'invalid_reject_reason' };

  const request = await db.query(
    `
    UPDATE verification_requests
    SET status = $1, reject_reason = $2, reviewed_by = $3, reviewed_at = now()
    WHERE id = $4 AND status = 'pending'
    RETURNING user_id
  `,
    [approve ? 'approved' : 'rejected', approve ? null : rejectReason, architectId, requestId]
  );
  if (!request) return { success: false, reason: 'not_pending' };

  if (approve) {
    await db.query(`UPDATE users SET is_verified = true WHERE id = $1`, [request.user_id]);
  }
  const result = approve ? 'approved' : 'rejected';
  io?.to(`user_${request.user_id}`).emit('verification_result', {
    result,
    rejectReason: approve ? null : rejectReasonText(rejectReason),
  });
  notifyUser({ userId: request.user_id, event: approve ? 'verification_approved' : 'verification_rejected' }, { db });
  return { success: true };
}

module.exports = {
  GESTURES,
  getVerificationStatus,
  startVerification,
  submitVerification,
  listPendingVerifications,
  reviewVerification,
};
