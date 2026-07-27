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
 *      giusto.
 *   2) Bonus: Twilio ora gestisce lui stesso generazione, scadenza
 *      e tentativi del codice — non ci serve più una tabella
 *      nostra (otp_codes) per tenerne traccia.
 * ============================================================
 */

const jwt = require('jsonwebtoken');
const twilio = require('twilio');

const JWT_EXPIRY = '30d';

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function requestOtp({ phoneNumber }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  try {
    const client = getTwilioClient();
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: normalizedPhone, channel: 'sms' });
  } catch (err) {
    console.error('[auth] invio SMS fallito:', err);
    return { success: false, reason: 'sms_send_failed' };
  }

  return { success: true };
}

async function verifyOtp({ phoneNumber, code }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  let check;
  try {
    const client = getTwilioClient();
    check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: normalizedPhone, code });
  } catch (err) {
    console.error('[auth] verifica codice fallita:', err);
    return { success: false, reason: 'verification_failed' };
  }

  if (check.status !== 'approved') {
    return { success: false, reason: 'wrong_code' };
  }

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

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return { valid: true, userId: payload.userId };
  } catch (err) {
    return { valid: false };
  }
}

function normalizePhoneNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('39')) return `+${cleaned}`;
  return `+39${cleaned}`;
}

module.exports = { requestOtp, verifyOtp, verifyToken };
