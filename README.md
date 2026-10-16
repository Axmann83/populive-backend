# PopuLive — Backend

API REST + WebSocket + motore a orari. Node.js, Express, Socket.IO, PostgreSQL, Redis.

## Avvio in locale

Prerequisiti: **Node.js ≥ 20.6** e **Docker Desktop** avviato (per Postgres e Redis).

```bash
npm run setup            # npm install + avvia i container + schema + dati di prova
npm run dev              # server con auto-reload su http://localhost:3001
```

`npm run dev` usa **nodemon**: ad ogni modifica a un file `.js` o a `.env.dev` il server si riavvia da solo (digita `rs` + Invio per forzarlo).

### Login in locale

Non serve Twilio: in `.env.dev` è attivo `DEV_OTP_BYPASS=true`, quindi **qualunque numero di telefono entra con il codice `123456`** (valore di `APP_REVIEW_TEST_OTP_CODE`), senza SMS.

```bash
curl -X POST http://localhost:3001/api/auth/request-otp -H "Content-Type: application/json" -d '{"phoneNumber":"+393331234567"}'
```

```bash
curl -X POST http://localhost:3001/api/auth/verify-otp -H "Content-Type: application/json" -d '{"phoneNumber":"+393331234567","code":"123456"}'
```

La risposta contiene il `token` JWT da mandare negli endpoint protetti (header `Authorization: Bearer <token>`).

## Variabili d'ambiente

Il server legge **solo** `process.env`: non apre nessun file di configurazione da solo. I file `.env*` vengono passati esplicitamente a Node con `--env-file`, e questo avviene unicamente in `npm run dev`.

| File | Git | Chi lo legge | Contenuto |
| --- | --- | --- | --- |
| `.env.dev` | committato | `npm run dev` e gli script `db:*` | Configurazione di sviluppo, solo valori locali non sensibili (DB Docker, porta 3001, bypass OTP) |
| `.env` | **ignorato** | `npm run dev` e gli script `db:*` (con precedenza su `.env.dev`) | Opzionale: segreti personali, es. chiavi Stripe/Twilio di test, `FIREBASE_SERVICE_ACCOUNT`. `npm run dev` lo legge se esiste (`--env-file-if-exists`, Node 22.9 o successivo). **Mai** un `DATABASE_URL` di produzione qui |
| — | — | `npm start` | **Nessun file.** In produzione le variabili si impostano nel pannello del servizio di hosting |

| Variabile | Obbligatoria | Note |
| --- | --- | --- |
| `PORT` | no | Default `3000`. In locale `3001` (da `.env.dev`); su Railway viene assegnata automaticamente |
| `DATABASE_URL` | **sì** | Stringa di connessione Postgres. Se manca il server non parte |
| `REDIS_URL` | **sì** | Stringa di connessione Redis |
| `JWT_SECRET` | **sì** | Firma dei token di sessione. In produzione una stringa lunga e casuale |
| `NODE_ENV` | consigliata | **Imposta `production` in produzione**: disattiva per costruzione il bypass OTP anche se `DEV_OTP_BYPASS` fosse impostato per errore |
| `FRONTEND_BASE_URL` | no | URL del frontend, usato da Stripe per i redirect dopo il pagamento |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | in produzione | Invio e verifica OTP via SMS |
| `APP_REVIEW_TEST_PHONE_NUMBER`, `APP_REVIEW_TEST_OTP_CODE` | no | Numero e codice fisso per i revisori degli store (richiede "Custom Verification Code" attivo su Twilio) |
| `DEV_OTP_BYPASS` | solo locale | `true` = salta Twilio, qualunque numero entra con `APP_REVIEW_TEST_OTP_CODE`. Ignorato se `NODE_ENV=production` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | in produzione | Acquisti in-app e webhook. Senza chiavi gli endpoint di pagamento falliscono, tutto il resto funziona |
| `FIREBASE_SERVICE_ACCOUNT` | in produzione | Notifiche push (Firebase Cloud Messaging, Android e iOS): il JSON dell'account di servizio Firebase (su Railway, il contenuto del file) oppure il percorso del file (in locale, nel `.env`). Senza, le push sono spente e tutto il resto funziona |

## Script disponibili

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | Server in modalità sviluppo con riavvio automatico (legge `.env.dev` e, se esiste, `.env`) |
| `npm start` | Server "nudo" per la produzione (le variabili arrivano dall'ambiente) |
| `npm run setup` | Prima installazione completa: dipendenze, container, schema, seed |
| `npm run db:up` | Avvia Postgres + Redis e applica le migrazioni mancanti |
| `npm run db:down` | Ferma i container (i dati restano) |
| `npm run db:reset` | **Cancella tutto**, ricrea il DB da zero e ricarica il seed |
| `npm run db:migrate` | Applica le migrazioni non ancora eseguite |
| `npm run db:seed` | Carica i dati di prova (`db/seed-dev.sql`, rieseguibile senza duplicati) |
| `npm run db:validate` | Estrae tutte le query SQL dal codice e le fa validare a Postgres: segnala tabelle/colonne mancanti |
| `npm run db:psql` | Apre una shell `psql` nel container |
| `npm run check` | ESLint + controllo formattazione Prettier |
| `npm run lint` / `npm run lint:fix` | Solo ESLint, con o senza correzione automatica |
| `npm run format` | Riformatta tutto con Prettier |

## Database

- **Connessione locale:** `postgres://populive:populive@localhost:5432/populive` — Redis su `redis://localhost:6379` (definiti in `docker-compose.yml`).
- **Schema:** `populive-db-schema.sql` è lo schema base (MVP). `db/migrations/*.sql` contiene le modifiche successive, applicate in ordine alfabetico una sola volta ciascuna (registro nella tabella `schema_migrations`). La migrazione `001` allinea lo schema base a tutto ciò che il codice usa oggi (tabelle `feature_flags`, `architects`, `sponsored_missions`… e le colonne aggiunte nel tempo).
- **Funzioni SQL:** `current_business_date(venue_id)` dà la data della serata di un locale, in ora italiana (`Europe/Rome`, migrazione `006`) qualunque sia il fuso del database (UTC in locale e su Supabase).
- **Aggiungere una modifica allo schema:** crea `db/migrations/008_<descrizione>.sql` (numero successivo all'ultimo esistente), poi `npm run db:migrate`. Lancia `npm run db:validate` per verificare che codice e schema siano allineati.
- **Dati di prova** (`db/seed-dev.sql`): tre locali a Roma, catalogo prodotti, hashtag, default per tipo di locale. Gli utenti non sono nel seed: si creano con il login.
- **Dashboard admin:** gli endpoint `/api/dashboard/*` richiedono che l'utente sia nella tabella `architects`. Per promuovere il tuo utente locale:

```bash
npm run db:psql
```

```sql
INSERT INTO architects (user_id) SELECT id FROM users WHERE phone_number = '+393331234567';
```

## Qualità del codice

**ESLint** + **Prettier** sono configurati (`eslint.config.js`, `.prettierrc`) e girano da soli ad ogni `git commit` tramite husky + lint-staged (installati automaticamente da `npm install`): se un file ha errori il commit viene rifiutato; la formattazione viene sistemata automaticamente sui file in commit.

Regole principali:

- `console.log` vietato nel codice del server: usa `console.info` / `console.warn` / `console.error` (negli script in `scripts/` è permesso)
- variabili, import e parametri non usati vietati (prefisso `_` per ignorarli di proposito)
- `===` obbligatorio, `const`/`let` al posto di `var`
- terminazioni di riga sempre LF (`.gitattributes`), virgolette singole, 120 colonne

## Deploy in produzione

Il progetto è pensato per un hosting tipo **Railway** collegato al repository git: ad ogni push fa `npm install` e `npm start`. Checklist:

1. Impostare nel pannello tutte le variabili obbligatorie della tabella sopra, più `NODE_ENV=production`, Twilio e Stripe.
2. **Non** impostare `DEV_OTP_BYPASS`.
3. Applicare lo schema al database di produzione: `DATABASE_URL=<url produzione> npm run db:migrate` (oppure eseguire a mano `populive-db-schema.sql` e poi i file in `db/migrations/`). Non caricare `db/seed-dev.sql` in produzione.
4. Configurare su Stripe il webhook verso `https://<dominio>/api/stripe/webhook`.
5. Per le notifiche push: `FIREBASE_SERVICE_ACCOUNT` con il contenuto del JSON dell'account di servizio Firebase (progetto `populive-2eaa9`).

## Struttura

- `populive-api-server.js` — entry point: endpoint HTTP, middleware auth, avvio scheduler
- `populive-*-logic.js` / `-engine.js` / `-queries.js` — logica pura, riceve `{ db, redis, io }`
- `populive-db-adapter.js` — wrapper su `pg` (`query` → una riga o `null`, `queryAll` → array)
- `populive-websocket-rooms.js` — stanze Socket.IO per Arena/utente
- `populive-push.js` — notifiche push via Firebase (token dei dispositivi in `push_tokens`, migrazione `007`; `POST`/`DELETE /api/push/token`), chiamate senza `await` accanto agli eventi socket di Like, Superlike, Pulse, match e messaggi
- `populive-scheduler.js` — apertura/chiusura automatica delle serate e uscite dopo 24 ore (vedi sotto)
- `db/` — migrazioni e seed · `scripts/` — utilità DB (migrate, seed, validate)
- `docker-compose.yml` — Postgres 16 + Redis 7 per lo sviluppo locale

## Serate e presenza nel radar

- **Una serata per locale e per giorno**, secondo gli orari del locale in ora italiana. Lo scheduler (ogni 5 minuti) la
  porta in tre momenti: *aperta agli ingressi* (dentro l'orario) → *chiusa agli ingressi* (fuori orario: niente nuovi
  check-in, ma chi c'è resta dentro) → *finita* (quando inizia la serata successiva dello stesso locale, oppure fuori
  orario quando non resta più nessuno). Chiusura delle chat, rimborsi delle Pulse e bonus di fine serata scattano
  quando la serata finisce. Apertura = chiusura (es. `06:00`–`06:00`) vuol dire aperto 24 ore: la serata cambia
  all'orario di apertura.
- **La presenza è il check-in, non la connessione:** chi chiude l'app o blocca il telefono resta nella serata e nel
  radar degli altri. Si esce solo per uno di questi motivi (`checkins.checked_out_reason`): `manual` (pulsante "Esci
  dal locale", `POST /api/checkin/leave`), `other_checkin` (check-in in un'altra serata), `distance` (geofence,
  `POST /api/checkin/location-ping`), `session_end` (fine serata), `expired` (24 ore dopo il check-in). Si rientra
  solo con un nuovo QR.
- `GET /api/checkin/current` dice in quale serata l'utente risulta dentro: l'app lo usa per riprenderla quando non la
  ricorda (altro dispositivo, dati cancellati).
