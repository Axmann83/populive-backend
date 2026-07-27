/**
 * ============================================================
 * POPULIVE — AUTENTICAZIONE VERA (telefono + SMS)
 * ============================================================
 * Finora il sistema si fidava semplicemente di un header
 * "x-user-id" mandato dal frontend — chiunque avrebbe potuto
 * scrivere un ID a caso e "diventare" un altro utente. Questo file
 * chiude quel buco: da qui in poi, essere "quell'utente" richiede
 * aver dimostrato di possedere davvero quel numero di telefono
 * (tramite un codice ricevuto via SMS), e ogni richiesta successiva
 * porta un token firmato che il server verifica di aver emesso lui
 * stesso — non più un dato che il frontend può inventarsi.
 * ============================================================
 */

const jwt = require('jsonwebtoken');
const twilio = require('twilio');

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const JWT_EXPIRY = '30d';

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function requestOtp({ phoneNumber }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.query(`
    INSERT INTO otp_codes (phone_number, code, expires_at)
    VALUES ($1, $2, $3)
  `, [normalizedPhone, code, expiresAt]);

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: `Il tuo codice PopuLive è: ${code}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalizedPhone,
    });
  } catch (err) {
    console.error('[auth] invio SMS fallito:', err);
    return { success: false, reason: 'sms_send_failed' };
  }

  return { success: true, expiresInMinutes: OTP_EXPIRY_MINUTES };
}

async function verifyOtp({ phoneNumber, code }, { db }) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) return { success: false, reason: 'invalid_phone_number' };

  const otpRow = await db.query(`
    SELECT * FROM otp_codes
    WHERE phone_number = $1 AND verified = false
    ORDER BY created_at DESC
    LIMIT 1
  `, [normalizedPhone]);

  if (!otpRow) return { success: false, reason: 'no_pending_code' };

  if (new Date(otpRow.expires_at) < new Date()) {
    return { success: false, reason: 'code_expired' };
  }
  if (otpRow.attempts >= MAX_OTP_ATTEMPTS) {
    return { success: false, reason: 'too_many_attempts' };
  }

  if (otpRow.code !== code) {
    await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [otpRow.id]);
    return { success: false, reason: 'wrong_code' };
  }

  await db.query(`UPDATE otp_codes SET verified = true WHERE id = $1`, [otpRow.id]);

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

function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizePhoneNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('39')) return `+${cleaned}`;
  return `+39${cleaned}`;
}

module.exports = { requestOtp, verifyOtp, verifyToken };
