-- ============================================================
-- 009 — PULSE COMPRATE PER SERATA (Stripe), SCADENZA A FINE SERATA
-- ============================================================
-- Novembre 2026, M11 in SPEC-bug-migliorie.md (piano in
-- SPEC-acquisti-in-app.md, "Pulse via Stripe"). Una Pulse è una
-- consumazione vera al bancone: si compra con Stripe per UNA serata
-- di UN locale, al prezzo di quella serata, e scade (senza rimborso)
-- all'orario di chiusura del locale, con un avviso un'ora prima.
--
--  - arena_sessions.pulse_price_cents: prezzo di una Pulse stasera.
--    Nasce dal prezzo predefinito del locale (venues.pulse_price_cents,
--    di default 10 €); l'Architetto lo cambia dalla dashboard. Le
--    Pulse già comprate tengono il prezzo pagato (pulse_purchases).
--  - arena_sessions.pulse_deadline: fine della serata per le Pulse =
--    orario di chiusura del locale (N6). Per i locali aperti 24 ore è
--    l'ora in cui nasce la serata nuova. La serata vera (closeSession)
--    può finire più tardi: per le Pulse conta questa.
--  - arena_sessions.pulse_reminder_sent_at: avviso di fine serata già
--    mandato (una volta sola per serata).
--  - arena_sessions.pulses_expired_at: scadenza già fatta (saldi
--    azzerati, Pulse non ritirate scadute), una volta sola.
--  - pulse_purchases: un acquisto su Stripe. L'id della sessione di
--    Checkout è UNICO: lo stesso pagamento accredita una volta sola,
--    anche se il webhook arriva due volte.
--  - pulse_night_balances: saldo per persona e serata. Disponibili =
--    comprate + restituite (Pulse rifiutate) - usate - scadute; il
--    CHECK impedisce di andare sotto zero anche con due invii insieme.
--  - Tolti i crediti globali (users.paid_pulse_credits), le Pulse
--    gratis settimanali (free_pulses_balance) e il pacchetto da 5 per
--    locale (N4, N5: l'app non è mai stata usata davvero, nessun
--    credito da rimborsare).
-- ============================================================

-- Prezzo predefinito del locale: 10 € se non impostato.
ALTER TABLE venues ALTER COLUMN pulse_price_cents SET DEFAULT 1000;
UPDATE venues SET pulse_price_cents = 1000 WHERE pulse_price_cents IS NULL OR pulse_price_cents <= 0;

ALTER TABLE arena_sessions
    ADD COLUMN IF NOT EXISTS pulse_price_cents      INT,
    ADD COLUMN IF NOT EXISTS pulse_deadline         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pulse_reminder_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pulses_expired_at      TIMESTAMPTZ;

-- Orario di chiusura di una serata, in ora italiana (come
-- current_business_date, migrazione 006). session_date è la data di
-- APERTURA: un locale che chiude "prima" di aprire (22:00-06:00) o
-- aperto 24 ore (apertura = chiusura) finisce il giorno dopo.
CREATE OR REPLACE FUNCTION pulse_deadline_for(p_venue_id UUID, p_session_date DATE)
RETURNS TIMESTAMPTZ AS $$
    SELECT ((p_session_date + CASE WHEN v.default_close_time <= v.default_open_time THEN 1 ELSE 0 END)
            + v.default_close_time) AT TIME ZONE 'Europe/Rome'
    FROM venues v
    WHERE v.id = p_venue_id
$$ LANGUAGE sql STABLE;

-- Ogni serata nasce con prezzo e fine già fissati, chiunque la crei
-- (scheduler, check-in arrivato prima dello scheduler, script di
-- prova): un trigger invece di ripeterlo in ogni INSERT.
CREATE OR REPLACE FUNCTION arena_sessions_pulse_defaults()
RETURNS trigger AS $$
BEGIN
    IF NEW.pulse_price_cents IS NULL THEN
        NEW.pulse_price_cents := COALESCE((SELECT pulse_price_cents FROM venues WHERE id = NEW.venue_id), 1000);
    END IF;
    IF NEW.pulse_deadline IS NULL THEN
        NEW.pulse_deadline := pulse_deadline_for(NEW.venue_id, NEW.session_date);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_arena_sessions_pulse_defaults ON arena_sessions;
CREATE TRIGGER trg_arena_sessions_pulse_defaults
    BEFORE INSERT ON arena_sessions
    FOR EACH ROW EXECUTE FUNCTION arena_sessions_pulse_defaults();

-- Serate già esistenti. Quelle vecchie hanno la fine nel passato: il
-- primo giro dello scheduler le fa scadere (nessun dato vero).
UPDATE arena_sessions a
SET pulse_price_cents = COALESCE(a.pulse_price_cents, v.pulse_price_cents, 1000),
    pulse_deadline    = COALESCE(a.pulse_deadline, pulse_deadline_for(a.venue_id, a.session_date))
FROM venues v
WHERE v.id = a.venue_id AND (a.pulse_price_cents IS NULL OR a.pulse_deadline IS NULL);

CREATE INDEX IF NOT EXISTS idx_arena_sessions_pulse_deadline
    ON arena_sessions(pulse_deadline) WHERE pulses_expired_at IS NULL;

CREATE TABLE IF NOT EXISTS pulse_purchases (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id),
    arena_session_id            UUID NOT NULL REFERENCES arena_sessions(id),
    quantity                    INT NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    unit_price_cents            INT NOT NULL CHECK (unit_price_cents > 0),
    total_cents                 INT NOT NULL CHECK (total_cents > 0),
    stripe_checkout_session_id  VARCHAR(255) UNIQUE,
    stripe_payment_intent_id    VARCHAR(255),
    -- 'pending'  = Checkout aperto, non ancora pagato
    -- 'paid'     = pagato e accreditato
    -- 'refunded' = pagato quando la serata era già finita: rimborsato
    -- 'expired'  = Checkout abbandonato (scaduto senza pagamento)
    -- 'test'     = account di prova, accreditato senza Stripe
    status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'refunded', 'expired', 'test')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                     TIMESTAMPTZ,
    refunded_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pulse_purchases_user_session ON pulse_purchases(user_id, arena_session_id);
CREATE INDEX IF NOT EXISTS idx_pulse_purchases_pending ON pulse_purchases(user_id, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pulse_night_balances (
    user_id           UUID NOT NULL REFERENCES users(id),
    arena_session_id  UUID NOT NULL REFERENCES arena_sessions(id),
    purchased         INT NOT NULL DEFAULT 0,
    used              INT NOT NULL DEFAULT 0,
    returned          INT NOT NULL DEFAULT 0,
    expired           INT NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, arena_session_id),
    CHECK (purchased >= 0 AND used >= 0 AND returned >= 0 AND expired >= 0),
    CHECK (purchased + returned - used - expired >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pulse_night_balances_session ON pulse_night_balances(arena_session_id);

-- La Pulse non è più un drink scelto dal listino (N2): vale una
-- consumazione al prezzo della serata, scelta al bancone.
ALTER TABLE pulses ALTER COLUMN drink_type DROP NOT NULL;

ALTER TABLE users
    DROP COLUMN IF EXISTS paid_pulse_credits,
    DROP COLUMN IF EXISTS free_pulses_balance,
    DROP COLUMN IF EXISTS last_free_pulse_grant_at;

ALTER TABLE venues DROP COLUMN IF EXISTS pulse_bundle_5_price_cents;
