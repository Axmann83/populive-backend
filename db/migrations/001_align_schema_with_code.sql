-- ============================================================
-- 001 — ALLINEA LO SCHEMA BASE AL CODICE ATTUALE
-- ============================================================
-- populive-db-schema.sql è fermo alla versione MVP: il codice nel
-- frattempo ha aggiunto tabelle (feature flag, missioni, architetti,
-- notifiche ignorate...) e molte colonne (login via telefono, saldi
-- Pulse/Superlike, ghost mode...). Questo file aggiunge tutto ciò
-- che manca, ricavato query per query dal codice (vedi
-- npm run db:validate). Tutto è idempotente (IF NOT EXISTS).
-- ============================================================

-- ------------------------------------------------------------
-- USERS — login via telefono, saldi, preferenze, notifiche
-- ------------------------------------------------------------
ALTER TABLE users ALTER COLUMN display_name DROP NOT NULL; -- l'utente nasce "vuoto" dopo l'OTP, il nome arriva con l'onboarding
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_number                 VARCHAR(30) UNIQUE,
    ADD COLUMN IF NOT EXISTS deleted_at                   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_test_account              BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS gender_for_stats             VARCHAR(20),
    ADD COLUMN IF NOT EXISTS ghost_mode_enabled           BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS haptic_notifications_enabled BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS instant_influencer_category  VARCHAR(50),
    -- saldi Pulse / Superlike
    ADD COLUMN IF NOT EXISTS free_pulses_balance          INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS paid_pulse_credits           INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_free_pulse_grant_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superlike_balance            INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_superlike_grant_at      TIMESTAMPTZ,
    -- posizione (solo per missioni sponsorizzate, con consenso)
    ADD COLUMN IF NOT EXISTS last_latitude                DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_longitude               DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_updated_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_seen_at                 TIMESTAMPTZ,
    -- "visto"/"ripulisci tutto" per notifiche, Pulse e Centro Like
    ADD COLUMN IF NOT EXISTS notifications_last_seen_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notifications_cleared_before TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pulses_cleared_before        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS like_center_last_seen_at     TIMESTAMPTZ;

-- ------------------------------------------------------------
-- VENUES — prezzo Pulse, commissioni, soglia classifica, categoria
-- ------------------------------------------------------------
ALTER TABLE venues
    ADD COLUMN IF NOT EXISTS category                    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS pulse_price_cents           INT,
    ADD COLUMN IF NOT EXISTS commission_venue_pct        INT,
    ADD COLUMN IF NOT EXISTS min_users_for_local_ranking INT DEFAULT 5;   -- il codice (createVirtualVenue) assume default 5

-- ------------------------------------------------------------
-- BLOCKS — motivo, scadenza, sessione di riferimento
-- ------------------------------------------------------------
ALTER TABLE blocks
    ADD COLUMN IF NOT EXISTS arena_session_id UUID REFERENCES arena_sessions(id),
    ADD COLUMN IF NOT EXISTS reason           VARCHAR(30),   -- 'match' | 'rejection' | 'user_blocked' | 'ignored_cooldown'
    ADD COLUMN IF NOT EXISTS expires_at       TIMESTAMPTZ;

-- ------------------------------------------------------------
-- PULSES — pagamento e locale di riscatto
-- ------------------------------------------------------------
ALTER TABLE pulses
    ADD COLUMN IF NOT EXISTS payment_status    VARCHAR(20),
    ADD COLUMN IF NOT EXISTS redeemed_venue_id UUID REFERENCES venues(id);

-- ------------------------------------------------------------
-- CHAT — ultima lettura per il contatore "non letti"
-- ------------------------------------------------------------
ALTER TABLE chat_conversations
    ADD COLUMN IF NOT EXISTS user_a_last_read_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS user_b_last_read_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- NUOVE TABELLE
-- ------------------------------------------------------------
-- Interruttori di funzionalità gestiti dalla dashboard.
-- Se la riga manca il codice considera la funzione ACCESA.
CREATE TABLE IF NOT EXISTS feature_flags (
    feature_key  VARCHAR(50) PRIMARY KEY,
    is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at   TIMESTAMPTZ DEFAULT now()
);
INSERT INTO feature_flags (feature_key, is_enabled) VALUES
    ('top_connector', true),
    ('big_spender', true),
    ('instant_influencer', true),
    ('chat_keep_required', true)
ON CONFLICT (feature_key) DO NOTHING;

-- Chi può usare la dashboard di amministrazione.
CREATE TABLE IF NOT EXISTS architects (
    user_id     UUID PRIMARY KEY REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Notifiche/Pulse nascoste singolarmente dall'utente.
CREATE TABLE IF NOT EXISTS dismissed_notifications (
    user_id     UUID REFERENCES users(id),
    entry_key   VARCHAR(80) NOT NULL,   -- es. 'pulse_view-<uuid>', 'like-<uuid>'
    created_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, entry_key)
);

-- Prodotti mostrati sul profilo di un Instant Influencer.
CREATE TABLE IF NOT EXISTS instant_influencer_products (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id),
    product_name  VARCHAR(100) NOT NULL,
    product_url   TEXT,
    sort_order    INT DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instant_influencer_products_user ON instant_influencer_products(user_id);

-- Missioni sponsorizzate (create dalla dashboard, completate via QR).
CREATE TABLE IF NOT EXISTS sponsored_missions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sponsor_name    VARCHAR(100) NOT NULL,
    venue_id        UUID REFERENCES venues(id),
    claim_text      VARCHAR(280) NOT NULL,
    bonus_points    INT NOT NULL,
    radius_meters   INT DEFAULT 2000,
    hashtag_filter  TEXT[],
    date_from       TIMESTAMPTZ NOT NULL,
    date_to         TIMESTAMPTZ NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mission_completions (
    mission_id    UUID REFERENCES sponsored_missions(id),
    user_id       UUID REFERENCES users(id),
    completed_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (mission_id, user_id)
);

-- ------------------------------------------------------------
-- PAGAMENTI — pacchetto 5 Pulse per locale, tracciamento Stripe
-- ------------------------------------------------------------
ALTER TABLE venues ADD COLUMN IF NOT EXISTS pulse_bundle_5_price_cents INT;
ALTER TABLE pulses ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(100);
