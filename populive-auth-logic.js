/**
 * ============================================================
 * POPULIVE — AUTENTICAZIONE VERA (telefono + SMS, via Twilio Verify)
 * ============================================================
 * Finora il sistema si fidava semplicemente di un header
 * "x-user-id" mandato dal frontend — chiunque avrebbe potuto
 * scrivere un ID a caso e "diventare" un altro utente. Questo file
 * chiude quel buco: da qui in poi, essere "quell'utente" richiede
 * aver dimostrato di possedere davvero quel numero di telefono
 * (tramite un codice ricevuto via SMS), e ogni richiesta successiva
 * porta un token firmato che il server verifica di aver emesso lui
 * stesso — non più un dato che il frontend può inventarsi.
 *
 * IMPORTANTE — cambio rispetto alla prima versione: usiamo
 * "Twilio Verify" invece della Messaging API grezza. Due motivi:
 *   1) Gli account Twilio in prova possono mandare SOLO messaggi
 *      con un testo tra quelli predefiniti — Verify è pensato
 *      apposta per i codici di verifica e include già il modello
 *      giusto, mentre un messaggio scritto a mano da noi non era
 *      permesso in prova.
 *   2) Bonus: Twilio ora gestisce lui stesso generazione, scadenza
 *      e tentativi del codice — non ci serve più una tabella
 *      nostra (otp_codes) per tenerne traccia, il codice è più
 *      semplice e ha meno cose che possono andare storte.
 * ============================================================
 */

const jwt = require('jsonwebtoken');
const twilio = require('twilio');

const JWT_EXPIRY = '30d'; // sessione lunga: un'app di nightlife non deve chiedere
                           // di rifare login ogni pochi giorni

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * STEP 1 — L'utente inserisce il numero, Twilio Verify genera e
 * manda lui stesso il codice via SMS (col suo modello predefinito,
 * utilizzabile anche in prova). Non creiamo ancora nessun utente
 * qui: quello avviene solo dopo la verifica.
 */
async function requestOtp({ phoneNumber }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  try {
    const client = getTwilioClient();
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: normalizedPhone, channel: 'sms' });
  } catch (err) {
    // Se l'SMS non parte per davvero (es. numero non verificato in
    // un account ancora in prova), non ha senso dire all'utente
    // "controlla il telefono" — meglio un errore chiaro subito.
    console.error('[auth] invio SMS fallito:', err);
    return { success: false, reason: 'sms_send_failed' };
  }

  return { success: true };
}

/**
 * STEP 2 — L'utente inserisce il codice ricevuto. Chiediamo a
 * Twilio se è corretto (lui solo sa qual è, generato e scaduto
 * tutto dal suo lato) — se sì, troviamo o creiamo l'utente legato
 * a quel numero, e rilasciamo un token di sessione (JWT).
 *
 * NOTA TECNICA IMPORTANTE: qui chiamiamo l'indirizzo di Twilio
 * DIRETTAMENTE (con una richiesta HTTP semplice), invece di usare
 * il metodo "comodo" della libreria ufficiale Twilio per Node.js
 * (client.verify.v2.services(...).verificationChecks.create(...)).
 * Quel metodo ha un bug noto e documentato (mai risolto del tutto,
 * segnalato più volte su GitHub) che a volte fa credere che la
 * richiesta sia fallita anche quando Twilio ha verificato il
 * codice correttamente — scoperto proprio testando questo sistema.
 * Chiamare l'indirizzo direttamente evita del tutto quel bug.
 */
async function verifyOtp({ phoneNumber, code }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  let check;
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({ To: normalizedPhone, Code: code });

    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    check = await res.json();

    if (!res.ok) {
      console.error('[auth] verifica codice fallita (risposta Twilio):', check);
      return { success: false, reason: 'verification_failed' };
    }
  } catch (err) {
    console.error('[auth] verifica codice fallita:', err);
    return { success: false, reason: 'verification_failed' };
  }

  if (check.status !== 'approved') {
    return { success: false, reason: 'wrong_code' };
  }

  // Troviamo l'utente esistente legato a questo numero, o ne
  // creiamo uno nuovo "vuoto" — il resto del profilo (nome, foto,
  // hashtag, consenso) si completa nel flusso di onboarding già
  // scritto, che parte subito dopo il login per chi è nuovo.
  let user = await db.query(`SELECT id, onboarding_completed FROM users WHERE phone_number = $1`, [normalizedPhone]);

  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    user = await db.query(`
      INSERT INTO users (phone_number)
      VALUES ($1)
      RETURNING id, onboarding_completed
    `, [normalizedPhone]);
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRY });

  return {
    success: true,
    token,
    userId: user.id,
    isNewUser,
    onboardingCompleted: user.onboarding_completed,
  };
}

/**
 * Verifica il token su ogni richiesta — sostituisce il vecchio
 * "requireOnboarded" che si fidava ciecamente dell'header. Ora
 * l'unico modo di "essere" un utente è avere un token che il
 * server ha firmato lui stesso, impossibile da falsificare senza
 * conoscere JWT_SECRET.
 */
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return { valid: true, userId: payload.userId };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * Normalizza il numero in formato internazionale (E.164, es.
 * +393331234567) — Twilio lo richiede in questo formato esatto.
 * Molto semplice apposta: per l'MVP assumiamo prefisso italiano
 * se l'utente non lo scrive, da raffinare quando servirà davvero
 * supportare altri paesi.
 */
function normalizePhoneNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  // Convenzione "00" internazionale (es. "0039 389 4381164") —
  // molto comune in Italia al posto del "+39". Senza questo
  // controllo, il codice sotto non la riconosce né come "+" né
  // come "39 seguito dal numero", e finisce per AGGIUNGERE un
  // secondo prefisso davanti (bug vero, trovato nei log reali:
  // un numero digitato così diventava +3900393894381164).
  if (cleaned.startsWith('0039')) return `+39${cleaned.slice(4)}`;
  if (cleaned.startsWith('39')) return `+${cleaned}`;
  return `+39${cleaned}`;
}

/**
 * ============================================================
 * CANCELLAZIONE ACCOUNT (12/9) — richiesta obbligatoria di Apple/Google
 * ============================================================
 * Approccio: cancellazione "soft" con anonimizzazione, non una
 * pulizia riga per riga di ogni tabella collegata — per due motivi
 * precisi, non solo pigrizia:
 *   1) Il ledger punti (points_ledger) è append-only per scelta di
 *      design (integrità di classifiche/storico) — la tensione con
 *      il diritto di cancellazione GDPR è già segnalata come punto
 *      APERTO con lo studio legale, non risolta qui in autonomia.
 *      Anonimizzare il PROFILO soddisfa la richiesta pratica della
 *      persona (nome/foto/bio/numero spariscono, non è più
 *      rintracciabile né ricontattabile) senza decidere da soli una
 *      questione ancora aperta con i legali.
 *   2) I messaggi già scambiati in una chat appartengono anche
 *      all'ALTRA persona nella conversazione — si sostituisce il
 *      testo con un segnaposto, non si fa sparire la conversazione
 *      da sotto i piedi di chi resta.
 *
 * Cosa succede davvero:
 *   - deleted_at = ora, profilo azzerato (nome/foto/bio/hashtag)
 *   - numero di telefono liberato (sostituito con un segnaposto
 *     univoco) — libera il numero vero per un'eventuale nuova
 *     registrazione futura, e IMPEDISCE da solo ogni nuovo accesso
 *     sul vecchio account (la ricerca per numero in verifyOtp non
 *     lo troverà più, v. sopra)
 *   - messaggi già inviati: testo sostituito, struttura della
 *     conversazione intatta per l'altra persona
 *   - escluso da classifiche/ricerche — v. deleted_at IS NULL già
 *     aggiunto in populive-ranking-queries.js
 *   - il Radar (presenza live via socket, non una query) si
 *     risolve da sé appena il chiamante disconnette la sessione
 *     subito dopo — nessun filtro aggiuntivo necessario lì.
 * ============================================================
 */
async function deleteAccount({ userId }, { db }) {
  await db.query(`
    UPDATE users SET
      deleted_at = now(),
      display_name = 'Utente eliminato',
      photo_url = NULL,
      avatar_emoji = NULL,
      bio = NULL,
      phone_number = 'del_' || substring(id::text, 1, 16),
      ghost_mode_enabled = false,
      receive_pulses_enabled = false,
      sponsored_missions_enabled = false,
      appears_in_historical_search = false
    WHERE id = $1
  `, [userId]);

  await db.query(`DELETE FROM user_hashtags WHERE user_id = $1`, [userId]);

  await db.query(`
    UPDATE chat_messages SET body = '[messaggio eliminato]'
    WHERE sender_id = $1
  `, [userId]);

  return { success: true };
}

module.exports = { requestOtp, verifyOtp, verifyToken, deleteAccount };
