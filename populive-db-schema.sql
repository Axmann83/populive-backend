-- ============================================================
-- POPULIVE — SCHEMA DATABASE MVP (PostgreSQL)
-- ============================================================
-- Principio guida: separare i dati PERMANENTI (qui, in Postgres)
-- dai dati VIVI/TEMPORANEI di una singola serata (che vivranno
-- in Redis, non qui — vedi note in fondo al file).
-- I dati grezzi di posizione NON vengono mai salvati qui:
-- solo il fatto che un check-in sia avvenuto, non le coordinate.
-- ============================================================


-- ------------------------------------------------------------
-- UTENTI
-- ------------------------------------------------------------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name        VARCHAR(50) NOT NULL,
    avatar_emoji        VARCHAR(10),                -- fallback demo/MVP, se manca la foto vera
    photo_url           TEXT,                        -- foto profilo reale (storage esterno, es. S3/Cloudinary)
    bio                 VARCHAR(280),

    profile_type        VARCHAR(20) DEFAULT 'standard', -- 'standard' | 'professional'
    -- 'professional' sblocca il profilo da Instant Influencer:
    -- link ai prodotti sponsorizzati, visibilità nel pannello brand.
    -- Non è auto-attivabile: richiede approvazione/accordo con un brand
    -- (coerente con quanto deciso sulla profilazione per gli ads).

    onboarding_completed BOOLEAN DEFAULT FALSE,       -- true solo dopo aver visto/accettato il flusso consenso

    -- Consenso legale obbligatorio (Privacy Policy + Termini) — i
    -- TESTI VERI arrivano dallo studio legale incaricato, qui
    -- teniamo solo la prova che l'utente ha accettato una versione
    -- specifica, con quando l'ha fatto (utile in caso di dispute
    -- o se il testo cambia in futuro e serve richiedere un nuovo consenso).
    privacy_policy_version_accepted VARCHAR(20),      -- es. 'v1.0' — NULL finché non accetta
    privacy_policy_accepted_at      TIMESTAMPTZ,
    terms_version_accepted          VARCHAR(20),
    terms_accepted_at               TIMESTAMPTZ,

    -- Interruttore di autopresentazione (NON un consenso privacy:
    -- il punteggio è già pubblico in classifica, qui si decide solo
    -- se mostrarlo anche sulla card del proprio profilo — utile per
    -- chi è all'inizio e si sente a disagio con un punteggio basso).
    -- Default visibile, nessun bonus/malus collegato: è una scelta
    -- estetica personale, non un trattamento dati da incentivare.
    show_ranking_on_profile BOOLEAN DEFAULT TRUE,

    is_verified         BOOLEAN DEFAULT FALSE,       -- badge identità reale (gratuito/controllo manuale)
    is_premium          BOOLEAN DEFAULT FALSE,       -- badge a pagamento, moltiplicatore punti
    premium_expires_at  TIMESTAMPTZ,

    -- Impostazioni di consenso (principio: base fissa uguale per tutti + bonus opzionali)
    receive_pulses_enabled          BOOLEAN DEFAULT TRUE,
    sponsored_missions_enabled     BOOLEAN DEFAULT FALSE,
    -- Filtro contatti: chi può inviare Superlike/Pulse+Superlike a questo utente.
    -- Pensato soprattutto per VIP o profili molto contattati che vogliono
    -- alzare la soglia di chi può raggiungerli. Il Like semplice resta
    -- sempre possibile per tutti (è anonimo, non è "contatto diretto").
    contact_filter                 VARCHAR(20) DEFAULT 'everyone',
        -- 'everyone'       → chiunque può inviare Superlike/Pulse+Superlike
        -- 'verified_only'  → solo profili con is_verified = true
        -- 'premium_only'   → solo profili con is_premium = true
    appears_in_historical_search   BOOLEAN DEFAULT TRUE,            -- bacheca storica opt-out

    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Hashtag di autotargetizzazione (#fitness, #nightlife, ecc.)
CREATE TABLE hashtags (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(30) UNIQUE NOT NULL
);

CREATE TABLE user_hashtags (
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    hashtag_id  INT REFERENCES hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, hashtag_id)
);


-- ------------------------------------------------------------
-- LOCALI / ARENE
-- ------------------------------------------------------------
-- Valori di default suggeriti per categoria, da precompilare nel
-- pannello quando si aggiunge un nuovo locale (velocizza l'onboarding
-- per chi non ha esigenze particolari, restano comunque modificabili
-- riga per riga in "venues"):
--   nightclub     22:00 - 06:00   |  soglia suggerita: 30
--   restaurant    19:00 - 24:00   |  soglia suggerita: 15
--   gym           06:00 - 24:00   |  soglia suggerita: 10
--   cocktail_bar  17:00 - 22:00   |  soglia suggerita: 15
--   retail        09:00 - 20:00   |  soglia suggerita: 10
CREATE TABLE venue_type_defaults (
    venue_type              VARCHAR(30) PRIMARY KEY,
    default_open_time       TIME NOT NULL,
    default_close_time      TIME NOT NULL,
    default_checkin_threshold INT NOT NULL,
    default_spending_threshold_cents INT,  -- NULL per categorie dove il bonus spesa non ha senso (es. palestra)
    default_spending_bonus_points    INT
);

-- Principio guida per tutto il pannello di configurazione: chi crea
-- un locale (proprietario reale o utente che crea la versione virtuale)
-- spesso ha poca dimestichezza con la tecnologia e vuole fare in fretta.
-- Ogni campo tecnico (orari, soglia) deve quindi arrivare PRECOMPILATO
-- col default della categoria scelta — la persona conferma con un tap,
-- e personalizza solo se lo desidera esplicitamente. Mai un form vuoto
-- che obbliga a decisioni tecniche fin dal primo utilizzo.

-- NOTA: i locali possono nascere in due modi diversi:
-- 1) is_partner = true  → creato/confermato insieme al proprietario,
--    accordo firmato, la Pulse è riscattabile per una consumazione vera.
-- 2) is_partner = false → creato autonomamente da un utente qualsiasi
--    ("versione virtuale" del locale, nessun accordo, nessuna
--    infrastruttura fisica coinvolta) — radar e classifica funzionano
--    lo stesso, ma la Pulse resta solo punteggio digitale, mai un vero
--    voucher da bancone, finché non arriva un accordo reale.
-- Questo è il meccanismo di crescita "autonoma" di cui parlavamo,
-- reso possibile dalla stessa tabella, senza bisogno di una struttura
-- dati separata.
--
-- QUANDO LA FINTECH SARÀ ATTIVA: nei locali con is_partner = false,
-- l'opzione Pulse andrà nascosta del tutto (non ha senso senza un
-- accordo che garantisca la consumazione reale) — resterà disponibile
-- solo la mancia libera P2P, che non dipende da nessun accordo col
-- locale. Nei locali is_partner = true restano invece disponibili
-- entrambe le opzioni.

-- ============================================================
-- current_business_date(venue_id) — risolve il problema della
-- mezzanotte per i locali che restano aperti oltre le 00:00.
-- ============================================================
-- Se il locale chiude "prima" (nel quadrante dell'orologio) di
-- quando apre, vuol dire che attraversa la mezzanotte: se in
-- questo momento sono le 3 del mattino e il locale ha aperto ieri
-- sera, questa funzione restituisce ANCORA la data di ieri —
-- perché è ancora "la serata di ieri", anche se l'orologio segna
-- già domani.
CREATE OR REPLACE FUNCTION current_business_date(p_venue_id UUID)
RETURNS DATE AS $$
DECLARE
  v_open  TIME;
  v_close TIME;
  v_now_time TIME := now()::TIME;
BEGIN
  SELECT default_open_time, default_close_time
  INTO v_open, v_close
  FROM venues WHERE id = p_venue_id;

  -- Locale che attraversa la mezzanotte (es. discoteca 22:00-06:00)
  -- e siamo ancora nelle ore piccole di stamattina: la sessione
  -- appartiene ancora a ieri.
  IF v_close < v_open AND v_now_time < v_close THEN
    RETURN (now()::DATE - INTERVAL '1 day')::DATE;
  END IF;

  RETURN now()::DATE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- POPOLAMENTO INIZIALE DA DATASET APERTI (Overture Maps / OSM)
-- ============================================================
-- La tabella "venues" si popola in blocco da dataset aperti
-- (Overture Maps in primis, OpenStreetMap come complemento),
-- filtrando per TUTTE le categorie rilevanti fin da subito —
-- non solo nightlife: bar, ristoranti, palestre, cocktail bar,
-- retail. Ogni riga importata nasce con is_partner = false
-- (locale "virtuale", coerente con quanto deciso) e venue_type
-- assegnato in base alla categoria del dataset di origine, che
-- determina automaticamente gli orari/soglia di default da
-- venue_type_defaults. Quando un locale firma un accordo vero,
-- basta aggiornare is_partner = true sulla stessa riga — nessuna
-- duplicazione, nessun dato da re-inserire da zero.
-- ============================================================

CREATE TABLE venues (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(100) NOT NULL,
    area                VARCHAR(100),                -- es. "Roma · Trastevere"
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    checkin_threshold   INT DEFAULT 20,               -- soglia di attivazione classifica locale
    spending_threshold_cents INT,                      -- soglia di spesa al tavolo che sblocca il bonus punti (personalizzabile per locale)
    spending_bonus_points    INT,                       -- punti fissi assegnati al superamento della soglia (mai proporzionali all'importo)
    is_partner          BOOLEAN DEFAULT FALSE,        -- ha un accordo firmato (Pulse riscattabile davvero)

    -- Orari operativi: ogni tipo di locale ha il suo "giorno" configurabile.
    -- Esempi: palestra 06:00-24:00, ristorante 19:00-24:00, discoteca 22:00-06:00.
    venue_type          VARCHAR(30) NOT NULL,         -- 'gym' | 'restaurant' | 'nightclub' | ...
    default_open_time   TIME NOT NULL,                -- es. '22:00'
    default_close_time  TIME NOT NULL,                -- es. '06:00' (può essere "prima" di open_time: significa dopo mezzanotte)

    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Una "sessione Arena" = una singola serata in un singolo locale.
-- Serve per sapere quando si azzera la classifica locale e quando si è attivata.
--
-- IMPORTANTE per i locali che attraversano la mezzanotte (es. discoteca
-- aperta 22:00-06:00): session_date è la data di APERTURA, non quella
-- del calendario in ogni istante. Quindi un check-in fatto alle 3 del
-- mattino di martedì appartiene ancora alla sessione datata "lunedì" —
-- è ancora "la serata di lunedì", solo che orologio segna già martedì.
-- Questo evita di spezzare in due una singola nottata.
CREATE TABLE arena_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id            UUID REFERENCES venues(id),
    session_date        DATE NOT NULL,                 -- data di apertura, non di calendario "live"
    opened_at           TIMESTAMPTZ,                    -- timestamp esatto di apertura
    closed_at           TIMESTAMPTZ,                    -- timestamp esatto di chiusura (fine serata)
    is_active           BOOLEAN DEFAULT FALSE,          -- true quando raggiunge checkin_threshold
    activated_at        TIMESTAMPTZ,
    is_open_for_checkin BOOLEAN DEFAULT TRUE,           -- true durante l'orario operativo, false dopo la chiusura
    UNIQUE (venue_id, session_date)
);

CREATE TABLE checkins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    checked_in_at       TIMESTAMPTZ DEFAULT now(),
    checked_out_at      TIMESTAMPTZ    -- valorizzato alla disconnessione WebSocket
                                        -- (o, se non rilevata, alla chiusura della sessione
                                        -- Arena — stima "best effort", mai perfetta al secondo)
    -- Nessuna colonna di posizione GPS grezza qui, di proposito.
);


-- ------------------------------------------------------------
-- INTERAZIONI (Like / Superlike)
-- ------------------------------------------------------------
CREATE TABLE interactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id           UUID REFERENCES users(id),
    receiver_id         UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    type                VARCHAR(10) NOT NULL,         -- 'like' | 'superlike'
    counts_for_points   BOOLEAN DEFAULT TRUE,         -- false oltre il rate limit giornaliero
    status              VARCHAR(15) DEFAULT 'sent',   -- 'sent' | 'matched' | 'ignored' | 'rejected'
    created_at          TIMESTAMPTZ DEFAULT now()
);


-- ------------------------------------------------------------
-- PULSE
-- ------------------------------------------------------------
CREATE TABLE pulses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id           UUID REFERENCES users(id),
    receiver_id         UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),

    drink_type          VARCHAR(50) NOT NULL,         -- 'spritz' | 'birra' | 'cocktail' ...
    price_cents         INT NOT NULL,
    tier                VARCHAR(15) NOT NULL,         -- 'standalone' | 'like' | 'super'

    status              VARCHAR(15) DEFAULT 'pending',-- 'pending' | 'accepted' | 'ignored' | 'rejected' | 'redeemed' | 'expired'
    chat_unlocked        BOOLEAN DEFAULT FALSE,        -- true solo se il contatto è stato sbloccato (super: su accept: like: su match)
    guesses_remaining    INT,                           -- solo per tier='like', scalato in base alla dimensione dell'Arena

    redeem_code         VARCHAR(10),                  -- generato solo quando accettata
    redeem_activated_at TIMESTAMPTZ,                   -- quando parte il timer dei 60s
    redeem_expires_at   TIMESTAMPTZ,

    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Tentativi del mini-gioco "indovina chi ti ha inviato la Pulse+Like"
CREATE TABLE pulse_guess_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pulse_id         UUID REFERENCES pulses(id),
    guessed_user_id UUID REFERENCES users(id),
    was_correct     BOOLEAN,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Blocchi (rifiuto esplicito di Pulse/Superlike blocca il mittente)
CREATE TABLE blocks (
    blocker_id      UUID REFERENCES users(id),
    blocked_id      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

-- Visite al profilo (per i punti "profile_view" e l'anti-abuso:
-- una sola visita che genera punti per coppia viewer/visto/Arena)
CREATE TABLE profile_views (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    viewer_id           UUID REFERENCES users(id),
    viewed_user_id      UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    created_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE (viewer_id, viewed_user_id, arena_session_id)
);

-- Braccialetti founder (i ~100 pezzi limitati): chi li possiede
-- ottiene il moltiplicatore, ma SOLO sul globale, mai sul locale.
CREATE TABLE founder_bracelets (
    user_id         UUID PRIMARY KEY REFERENCES users(id),
    bracelet_code   VARCHAR(20) UNIQUE NOT NULL,
    assigned_at     TIMESTAMPTZ DEFAULT now()
);


-- ------------------------------------------------------------
-- PUNTI (ledger append-only — mai un semplice contatore da sovrascrivere)
-- ------------------------------------------------------------
-- Ogni riga è un evento che ha generato punti. Il totale locale o globale
-- si calcola sommando le righe pertinenti — questo ci permette di avere
-- sia la classifica locale (filtrata per arena_session_id) sia quella
-- globale (somma di tutte le righe di un utente) dallo stesso dato,
-- senza rischiare disallineamenti tra due contatori separati.
CREATE TABLE points_ledger (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),  -- NULL per punti non legati a una serata (es. missioni globali)
    points              INT NOT NULL,
    source              VARCHAR(30) NOT NULL,          -- 'like_received' | 'superlike_received' | 'pulse_received' | 'mission' | 'founder_bonus' ...
    counts_toward_local BOOLEAN DEFAULT TRUE,           -- false per bonus founder (solo globale)
    created_at          TIMESTAMPTZ DEFAULT now()
);


-- ------------------------------------------------------------
-- CATALOGO ACQUISTI IN-APP (estensibile senza toccare il codice)
-- ------------------------------------------------------------
-- Ogni cosa acquistabile — crediti Like extra, badge Verificato,
-- profilo Premium, futuri pacchetti che scopriremo funzionare
-- studiando il mercato — è una riga qui, non una funzione a parte.
-- Aggiungere un nuovo prodotto = INSERT, non una nuova funzione.
CREATE TABLE iap_products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             VARCHAR(50) UNIQUE NOT NULL,     -- es. 'like_credits_20', 'verified_badge', 'premium_1_month'
    display_name    VARCHAR(100) NOT NULL,
    description     VARCHAR(280),
    price_cents     INT NOT NULL,
    product_type    VARCHAR(30) NOT NULL,
        -- 'like_credits' | 'verified_badge' | 'premium_subscription' | 'pulse_bundle' | ...
        -- Nuovi tipi si aggiungono qui in futuro, non richiedono
        -- una nuova tabella: basta insegnare a applyPurchaseEffect
        -- (nel codice) a riconoscere il nuovo tipo.
    effect_config   JSONB NOT NULL,
        -- Parametri flessibili per tipo, es:
        --   like_credits          → {"credits": 20, "scope": "per_session"}
        --   premium_subscription  → {"duration_days": 30}
        --   verified_badge        → {"requires_manual_review": true}
    is_active       BOOLEAN DEFAULT TRUE,             -- disattivabile senza cancellarlo (storico acquisti resta valido)
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Storico di ogni acquisto effettuato — anche questa tabella non
-- cambia mai struttura quando aggiungiamo nuovi prodotti al catalogo.
CREATE TABLE user_purchases (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id),
    product_id              UUID REFERENCES iap_products(id),
    arena_session_id        UUID REFERENCES arena_sessions(id),  -- NULL se non legato a una singola serata
    external_transaction_id VARCHAR(100),   -- riferimento Stripe/Apple/Google quando la fintech è attiva
    purchased_at            TIMESTAMPTZ DEFAULT now(),
    expires_at               TIMESTAMPTZ    -- per prodotti a tempo (es. Premium mensile)
);

CREATE INDEX idx_purchases_user ON user_purchases(user_id);

-- Coda di revisione manuale per il badge Verificato — anche se
-- acquistato, non si attiva mai in automatico (protezione contro
-- i finti VIP di cui parlavamo all'inizio: qualcuno del team deve
-- confermare l'identità reale prima di accendere is_verified).
CREATE TABLE verification_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),
    purchase_id     UUID REFERENCES user_purchases(id),
    status          VARCHAR(15) DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);
-- ------------------------------------------------------------
-- TOP CONNECTOR — terzo pilastro dello status (oltre Popular/Spender)
-- ------------------------------------------------------------
-- IMPORTANTE: lo status di Connector e il suo bonus (voto x2) sono
-- SEMPRE legati a una singola arena_session, mai permanenti — stessa
-- regola già applicata al braccialetto Founder. Nessuna colonna
-- "is_connector" fissa sull'utente: si ricalcola da zero ogni sera.

-- "Squad" fisica: un Connector fa scansionare il proprio QR a chi
-- entra con lui — i punti che i membri generano quella sera
-- (spesa, like ricevuti) si riflettono anche a lui.
CREATE TABLE squad_memberships (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id        UUID REFERENCES users(id),  -- NULL se la squad nasce da un tavolo, non da un Connector
    member_id           UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    table_qr_code       VARCHAR(50),  -- identifica il tavolo fisico, per lo split del bonus spesa
    joined_at           TIMESTAMPTZ DEFAULT now(),
    UNIQUE (member_id, arena_session_id)  -- un utente può stare in UNA sola squad per sessione
);

-- Stato Connector calcolato PER SESSIONE — non una colonna fissa
-- sull'utente. Ricalcolato/aggiornato durante la serata man mano
-- che i Punti Contribuzione salgono; sparisce con la sessione.
CREATE TABLE connector_status (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id),
    arena_session_id        UUID REFERENCES arena_sessions(id),
    contribution_points     INT DEFAULT 0,
    is_top_connector        BOOLEAN DEFAULT FALSE,  -- true se dentro la soglia (es. top 5% dell'Arena)
    UNIQUE (user_id, arena_session_id)
);

-- Stato Top Spender — stesso principio del Connector: calcolato
-- PER SESSIONE, mai un badge permanente, basato sui punti da
-- spesa al tavolo di QUESTA sola serata.
CREATE TABLE spender_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    is_top_spender      BOOLEAN DEFAULT FALSE,
    UNIQUE (user_id, arena_session_id)
);
-- Marker temporaneo per il motore predittivo: un Connector vota
-- (like/Pulse) un profilo; se quel profilo "esplode" entro la
-- finestra di tempo, il job schedulato assegna credito retroattivo.
CREATE TABLE connector_discovery_markers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id        UUID REFERENCES users(id),
    discovered_user_id  UUID REFERENCES users(id),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    points_at_vote_time INT NOT NULL,           -- punti del "discovered" al momento del voto
    created_at          TIMESTAMPTZ DEFAULT now(),
    evaluated_at        TIMESTAMPTZ,             -- valorizzato quando il job passa a controllare
    bonus_awarded        BOOLEAN DEFAULT FALSE
);
-- I Pulse non offrono più un elenco fisso uguale per tutti i
-- locali: ogni bevanda è una riga qui, ed è collegata SOLO ai
-- locali che la offrono davvero (v. venue_drink_catalog sotto).
-- Questo evita di promettere consumazioni che il bancone non può
-- davvero erogare — stesso principio di fondo della Pulse legata
-- a un accordo col locale.
CREATE TABLE brand_sponsors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,          -- es. "Belvedere Vodka"
    contact_email   VARCHAR(150),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE drink_products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(100) NOT NULL,        -- es. "Moscow Mule Belvedere"
    base_price_cents    INT NOT NULL,
    brand_sponsor_id    UUID REFERENCES brand_sponsors(id),  -- NULL = drink generico, non sponsorizzato
    sponsor_discount_cents INT DEFAULT 0,              -- quanto sconta il brand sul prezzo per l'utente
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Collega ogni bevanda ai SOLI locali che la offrono davvero —
-- una Pulse "Belvedere" appare come opzione solo nei locali che
-- hanno confermato di avere quel prodotto al bancone.
CREATE TABLE venue_drink_catalog (
    venue_id            UUID REFERENCES venues(id),
    drink_product_id    UUID REFERENCES drink_products(id),
    PRIMARY KEY (venue_id, drink_product_id)
);

-- Storico sponsorizzazioni per la fatturazione ai brand (fee di
-- visibilità + eventuale commissione per riscatto reale — stesso
-- doppio modello di ricavo già usato per l'Instant Influencer).
CREATE TABLE brand_sponsorship_deals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_sponsor_id        UUID REFERENCES brand_sponsors(id),
    drink_product_id        UUID REFERENCES drink_products(id),
    placement_fee_cents     INT,        -- quanto paga il brand per la visibilità nel catalogo
    commission_per_redeem_cents INT,    -- eventuale commissione per ogni Pulse riscattata di questo drink
    starts_at               TIMESTAMPTZ,
    ends_at                 TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- CHAT 1-A-1 — si apre solo dopo uno sblocco (Pulse+Superlike,
-- match nel minigioco Pulse+Like, o Superlike semplice accettato).
-- Si chiude ALL'USO alla fine della sessione (mai per sempre),
-- per limitare il rischio di stalking nei giorni successivi — ma
-- i messaggi restano archiviati internamente (mai cancellati
-- all'istante) per poter gestire eventuali segnalazioni di abuso.
-- ------------------------------------------------------------
CREATE TABLE chat_conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    arena_session_id    UUID REFERENCES arena_sessions(id),
    user_a_id           UUID REFERENCES users(id),
    user_b_id           UUID REFERENCES users(id),
    unlocked_via        VARCHAR(20) NOT NULL,  -- 'pulse_super' | 'pulse_like_match' | 'superlike' | 'like_reciprocal'
    created_at          TIMESTAMPTZ DEFAULT now(),
    closed_at           TIMESTAMPTZ,             -- valorizzato quando la sessione chiude: chat non più usabile
    -- Preferenza "conserva la chat oltre la serata" — BILATERALE:
    -- resta viva solo se ENTRAMBI la vogliono. Ognuno può cambiare
    -- idea in ogni momento, anche dopo che è già stata conservata:
    -- se anche uno solo passa a "cancella", si chiude per entrambi
    -- all'istante (mai una decisione unilaterale che vincola l'altro).
    user_a_wants_keep   BOOLEAN DEFAULT FALSE,
    user_b_wants_keep   BOOLEAN DEFAULT FALSE,
    UNIQUE (arena_session_id, user_a_id, user_b_id)
);

CREATE TABLE chat_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID REFERENCES chat_conversations(id),
    sender_id           UUID REFERENCES users(id),
    body                VARCHAR(1000) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX idx_chat_conversations_users ON chat_conversations(user_a_id, user_b_id);

-- NOTA: la cancellazione fisica dei messaggi 30 giorni dopo closed_at
-- va aggiunta al "motore a orari" (job schedulato) quando lo
-- scriveremo per davvero — per ora closed_at blocca solo l'USO,
-- non cancella nulla fisicamente.

CREATE INDEX idx_checkins_session ON checkins(arena_session_id);
CREATE INDEX idx_interactions_receiver ON interactions(receiver_id, status);
CREATE INDEX idx_pulses_receiver_status ON pulses(receiver_id, status);
CREATE INDEX idx_points_user ON points_ledger(user_id);
CREATE INDEX idx_points_session ON points_ledger(arena_session_id);


-- ============================================================
-- NOTA: cosa NON sta in Postgres, e vive invece in Redis
-- ============================================================
-- - "Chi è nel radar in questo momento" per ogni Arena attiva
--   (lista in memoria, si svuota a fine serata)
-- - Il conteggio check-in live verso la soglia di attivazione
-- - Le "stanze" WebSocket per gli aggiornamenti in tempo reale
-- Questi dati sono temporanei per natura: Postgres li riceve
-- solo come EVENTO STORICO (la riga in "checkins"), ma lo stato
-- "vivo" del radar non deve appesantire il database relazionale.
-- ============================================================


-- ============================================================
-- IL "MOTORE A ORARI": apertura/chiusura automatica delle serate
-- ============================================================
-- Un programma (worker) gira ogni pochi minuti e fa due cose,
-- per ogni venue, controllando l'ora corrente contro
-- default_open_time / default_close_time:
--
-- 1) APERTURA (all'orario di apertura del locale):
--    - crea una nuova riga in arena_sessions per quella data
--      (session_date = data di apertura, is_open_for_checkin = true)
--    - il radar/contatore in Redis riparte da zero per quella sessione
--
-- 2) CHIUSURA (all'orario di chiusura del locale):
--    - imposta is_open_for_checkin = false e closed_at = now()
--      sulla sessione di quella serata (niente nuovi check-in)
--    - la classifica locale resta visibile ma "congelata" (sola
--      lettura) fino alla prossima apertura, poi sparisce sostituita
--      dalla nuova sessione del giorno dopo
--    - il worker CANCELLA lo stato live in Redis di quella sessione
--      (lista radar, contatore soglia, stanze WebSocket) — i punti
--      restano invece per sempre in points_ledger, nulla si perde
--
-- Esempio pratico con orari diversi per tipo di locale:
--   palestra:     open 06:00 → close 24:00  (stesso giorno di calendario)
--   ristorante:   open 19:00 → close 24:00  (stesso giorno di calendario)
--   discoteca:    open 22:00 → close 06:00  (attraversa la mezzanotte:
--                 chiude usando l'ora del GIORNO DOPO, ma resta
--                 assegnata alla session_date del giorno di apertura)
--
-- Pseudocodice del controllo "il locale attraversa la mezzanotte?":
--   se default_close_time < default_open_time
--      allora l'orario di chiusura effettivo è (session_date + 1 giorno) alle default_close_time
--   altrimenti
--      l'orario di chiusura effettivo è session_date alle default_close_time
-- ============================================================

