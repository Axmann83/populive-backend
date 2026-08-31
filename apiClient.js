const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:3000';

/**
 * ============================================================
 * POPULIVE — CLIENT API CENTRALIZZATO
 * ============================================================
 * Prima, ogni schermata mandava un header "x-user-id" scritto a
 * mano — un sistema che chiunque poteva falsificare (bastava
 * scrivere un ID a caso per "diventare" un altro utente). Ora
 * l'identità vera arriva da un token firmato dal server al login,
 * e questo file è l'UNICO posto che lo gestisce: lo salva, lo
 * legge, lo aggiunge automaticamente a ogni richiesta. Tutte le
 * altre schermate chiamano semplicemente apiFetch(...) invece di
 * fetch(...), senza doversi preoccupare del token.
 * ============================================================
 */

const TOKEN_KEY = 'pl_token';
const USER_ID_KEY = 'pl_user_id';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setSession(token, userId) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_ID_KEY, userId);
  } catch { /* ignorato — se localStorage non è disponibile, la sessione
                semplicemente non sopravvive a un refresh, ma l'app non crasha */ }
}

function getStoredUserId() {
  try { return localStorage.getItem(USER_ID_KEY); } catch { return null; }
}

function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_ID_KEY);
  } catch { /* ignorato */ }
}

/**
 * ============================================================
 * ULTIMO LOCALE — per sopravvivere a un aggiornamento pagina
 * ============================================================
 * L'essere "dentro" un'Arena vive solo in memoria (arenaSessionId),
 * quindi un semplice refresh lo cancellava sempre, costringendo a
 * riscansionare il QR anche restando fisicamente nello stesso
 * locale — un problema vero, trovato durante un test dal vivo.
 * Qui salviamo SOLO il venueId (mai l'arenaSessionId, che va
 * comunque richiesto di nuovo al server ad ogni avvio: se il
 * locale nel frattempo ha chiuso l'Arena, richiamare /api/checkin
 * lo scopre da solo, niente di forzato o finto).
 * ============================================================
 */
const LAST_VENUE_KEY = 'pl_last_venue_id';

function getLastVenueId() {
  try { return localStorage.getItem(LAST_VENUE_KEY); } catch { return null; }
}

function setLastVenueId(venueId) {
  try { localStorage.setItem(LAST_VENUE_KEY, venueId); } catch { /* ignorato */ }
}

function clearLastVenueId() {
  try { localStorage.removeItem(LAST_VENUE_KEY); } catch { /* ignorato */ }
}

/**
 * Sostituto di fetch() che aggiunge da solo il token, se presente.
 * Se il server risponde 401 (token scaduto/non valido), ripuliamo
 * la sessione salvata — così l'app sa di dover tornare al login
 * invece di restare bloccata a ripetere richieste che falliranno
 * sempre.
 */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearSession();
  }

  return res;
}

export { API_BASE, getToken, getStoredUserId, setSession, clearSession, apiFetch, getLastVenueId, setLastVenueId, clearLastVenueId };

/**
 * ============================================================
 * POSIZIONE GPS — per le missioni sponsorizzate
 * ============================================================
 * Chiede il permesso al browser SOLO quando viene chiamata (mai
 * all'avvio dell'app senza motivo) — va richiamata unicamente
 * quando la persona ha già attivato il consenso "Ricevi missioni
 * sponsorizzate", mai prima. Fallisce in silenzio se il permesso
 * viene negato o il browser non supporta la geolocalizzazione —
 * niente di grave, la persona semplicemente non riceverà missioni
 * finché non concede l'accesso.
 * ============================================================
 */
function requestAndSendLocation(userId) {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        await apiFetch(`/api/profile/${userId}/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          }),
        });
      } catch {
        // Silenzioso — un aggiornamento di posizione mancato non è
        // mai un problema grave, semplicemente riproveremo la
        // prossima occasione utile (prossima apertura dell'app).
      }
    },
    () => { /* permesso negato o errore — nessun blocco per la persona */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

export { requestAndSendLocation };

/**
 * ============================================================
 * CARICAMENTO FOTO PROFILO (29/8)
 * ============================================================
 * Estratta da ProfileCreation.jsx (dove viveva da sola, mai
 * condivisa) perché ora serve ANCHE da Settings.jsx — permettere di
 * cambiare la foto anche DOPO la registrazione iniziale, non solo
 * la prima volta. Stessa identica logica, un solo posto da
 * mantenere invece di due copie che rischiano di disallinearsi.
 * Non serve mai l'API Secret lato client, solo cloud name + preset
 * (entrambi pubblici, sicuri da avere nel codice frontend).
 * ============================================================
 */
const CLOUDINARY_CLOUD_NAME = 'rjkegdrp';
const CLOUDINARY_UPLOAD_PRESET = 'populive_profile_photos';

async function uploadPhotoToStorage(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: 'POST', body: formData }
  );

  if (!res.ok) {
    throw new Error('Upload verso Cloudinary non riuscito');
  }

  const data = await res.json();
  return data.secure_url; // questo è l'URL da salvare in photo_url
}

export { uploadPhotoToStorage };
