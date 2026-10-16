/**
 * ============================================================
 * POPULIVE — NOTIFICHE PUSH (Firebase Cloud Messaging)
 * ============================================================
 * Ottobre 2026, D3 nella spec. Dal 12/10 (D14) chi ha fatto check-in
 * resta nel radar anche con l'app chiusa, quindi continua a ricevere
 * Like, Superlike, Pulse e messaggi: senza push non lo saprebbe mai.
 * Gli eventi socket restano come prima (app aperta: banner, popup,
 * vibrazione); la push è in più e arriva quando il socket è spento.
 *
 * Una sola strada per Android e iOS: Firebase Cloud Messaging, che su
 * iOS inoltra ad APNs con la chiave caricata nella console Firebase.
 *
 * Configurazione: variabile FIREBASE_SERVICE_ACCOUNT, che contiene il
 * JSON dell'account di servizio (Railway) oppure il percorso del file
 * (in locale, nel file .env non committato). Senza variabile le push
 * sono spente e il resto dell'app funziona come prima.
 *
 * Regole decise con l'utente (16/10):
 *  - il backend manda sempre la push, anche se l'app è aperta: non
 *    può sapere se è davvero in primo piano (un iPhone sospeso resta
 *    "collegato" per il server ancora per decine di secondi); in
 *    primo piano è l'app a non mostrarla;
 *  - interruttore "Notifiche aptiche" spento = push silenziosa (niente
 *    suono né vibrazione), non assente;
 *  - i messaggi in chat non mostrano il testo, solo chi ha scritto
 *    (sulla schermata di blocco lo leggerebbe chiunque);
 *  - il Like resta anonimo anche qui, come nell'evento socket.
 * ============================================================
 */

const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// Canali Android: li crea l'app al primo avvio. Il suono e la
// vibrazione di una notifica Android dipendono dal canale, non dal
// messaggio: per la push silenziosa serve un canale a parte.
const ANDROID_CHANNEL_DEFAULT = 'interactions';
const ANDROID_CHANNEL_SILENT = 'interactions_silent';

// Errori con cui Firebase dice che un token non vale più (app
// disinstallata, dati cancellati, token rinnovato): la riga si cancella.
const INVALID_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

let messaging = null;
let initialized = false;

function getFirebaseMessaging() {
  if (initialized) return messaging;
  initialized = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn('[push] FIREBASE_SERVICE_ACCOUNT non impostata: notifiche push spente');
    return null;
  }
  try {
    const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
    const app = initializeApp({ credential: cert(JSON.parse(json)) }, 'populive-push');
    messaging = getMessaging(app);
    console.info('[push] Firebase pronto, notifiche push attive');
  } catch (err) {
    // Mai far cadere il server per una configurazione sbagliata delle
    // push: si spengono e basta, con un errore chiaro nel log.
    console.error('[push] configurazione Firebase non valida, notifiche push spente:', err.message);
    messaging = null;
  }
  return messaging;
}

// ------------------------------------------------------------
// TOKEN DEI DISPOSITIVI
// ------------------------------------------------------------

/**
 * Registra (o riconferma) il token del dispositivo. L'app lo manda a
 * ogni avvio dopo il login: se il token esisteva per un altro account
 * (stesso telefono, utente diverso) passa a questo.
 */
async function registerPushToken({ userId, token, platform }, { db }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return { success: false, reason: 'invalid_token' };
  }
  if (platform !== 'android' && platform !== 'ios') {
    return { success: false, reason: 'invalid_platform' };
  }
  await db.query(
    `
    INSERT INTO push_tokens (user_id, token, platform)
    VALUES ($1, $2, $3)
    ON CONFLICT (token) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      last_seen_at = now()
  `,
    [userId, token, platform]
  );
  return { success: true };
}

/**
 * Al logout: il dispositivo smette di ricevere le push di questo
 * account. Si cancella solo se il token è davvero suo.
 */
async function unregisterPushToken({ userId, token }, { db }) {
  if (typeof token !== 'string' || token.length === 0) {
    return { success: false, reason: 'invalid_token' };
  }
  await db.query(`DELETE FROM push_tokens WHERE token = $1 AND user_id = $2`, [token, userId]);
  return { success: true };
}

// ------------------------------------------------------------
// TESTI
// ------------------------------------------------------------

/**
 * Titolo, testo e raggruppamento per ogni evento. `group` fa sì che
 * una notifica nuova sostituisca la precedente dello stesso gruppo
 * invece di accumularsi (Android `tag`, iOS `apns-collapse-id`):
 * tutti i Like in una sola notifica, i messaggi una per chat.
 */
function buildContent(event, { senderName, drinkName, conversationId }) {
  const name = senderName || 'Qualcuno';
  switch (event) {
    case 'like':
      return { title: 'Nuovo Like', body: 'Qualcuno ti ha messo Like ❤️', group: 'likes' };
    case 'superlike':
      return { title: 'Superlike ⭐', body: `${name} ti ha mandato un Superlike` };
    case 'pulse':
      return {
        title: 'Pulse 🍹',
        body: drinkName ? `${name} ti ha mandato una Pulse: ${drinkName}` : `${name} ti ha mandato una Pulse`,
      };
    case 'match':
      return { title: 'È un match! 🎉', body: `Tu e ${name} ora potete scrivervi` };
    case 'message':
      return { title: 'Nuovo messaggio', body: `${name} ti ha scritto`, group: `chat_${conversationId}` };
    default:
      return null;
  }
}

// ------------------------------------------------------------
// INVIO
// ------------------------------------------------------------

/**
 * Manda una push a tutti i dispositivi di una persona.
 *
 * Si chiama SENZA await, accanto all'evento socket: non lancia mai
 * errori e non deve rallentare né far fallire un Like o un messaggio.
 *
 * @param event 'like' | 'superlike' | 'pulse' | 'match' | 'message'
 * @param senderId chi ha causato l'evento; il nome si mostra solo se
 *   revealSender è vero (mai per il Like, né per la Pulse anonima)
 * @param data id utili all'app per aprire la schermata giusta al tocco
 */
async function notifyUser(
  { userId, event, senderId = null, revealSender = false, drinkName = null, data = {} },
  { db }
) {
  try {
    const fcm = getFirebaseMessaging();
    if (!fcm) return;

    const tokens = await db.queryAll(`SELECT token FROM push_tokens WHERE user_id = $1`, [userId]);
    if (tokens.length === 0) return;

    const receiver = await db.query(`SELECT haptic_notifications_enabled, deleted_at FROM users WHERE id = $1`, [
      userId,
    ]);
    if (!receiver || receiver.deleted_at) return;
    const withSound = receiver.haptic_notifications_enabled !== false;

    let senderName = null;
    if (revealSender && senderId) {
      const sender = await db.query(`SELECT display_name FROM users WHERE id = $1`, [senderId]);
      senderName = sender?.display_name || null;
    }

    const content = buildContent(event, { senderName, drinkName, conversationId: data.conversationId });
    if (!content) return;

    // FCM vuole solo stringhe nei dati.
    const payloadData = { type: event };
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) payloadData[key] = String(value);
    }

    const response = await fcm.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      notification: { title: content.title, body: content.body },
      data: payloadData,
      android: {
        priority: 'high',
        notification: {
          channelId: withSound ? ANDROID_CHANNEL_DEFAULT : ANDROID_CHANNEL_SILENT,
          ...(content.group ? { tag: content.group } : {}),
        },
      },
      apns: {
        headers: content.group ? { 'apns-collapse-id': content.group } : {},
        payload: {
          // Senza `sound` iOS mostra la notifica in silenzio, senza
          // vibrazione: è così che si rispetta l'interruttore.
          aps: {
            ...(withSound ? { sound: 'default' } : {}),
            ...(content.group ? { threadId: content.group } : {}),
          },
        },
      },
    });

    const invalid = [];
    response.responses.forEach((r, i) => {
      if (!r.success && INVALID_TOKEN_ERRORS.has(r.error?.code)) invalid.push(tokens[i].token);
      else if (!r.success) console.warn(`[push] invio fallito (${event}):`, r.error?.code, r.error?.message);
    });
    if (invalid.length > 0) {
      await db.query(`DELETE FROM push_tokens WHERE token = ANY($1)`, [invalid]);
    }
  } catch (err) {
    console.error(`[push] errore inviando "${event}" a ${userId}:`, err.message);
  }
}

module.exports = { registerPushToken, unregisterPushToken, notifyUser };
