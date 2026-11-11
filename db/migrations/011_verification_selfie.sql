-- ============================================================
-- 011 — VERIFICATO CON SELFIE E GESTO (lotto 9)
-- ============================================================
-- Novembre 2026, lotto 9 di SPEC-bug-migliorie.md (decisione
-- dell'utente dell'11/11): il badge Verificato è gratis. Chi lo chiede
-- riceve un gesto a caso (es. "pollice in su"), scatta un selfie mentre
-- lo fa e lo invia; un Architetto, dalla dashboard (sezione Verifiche),
-- confronta il selfie con le foto del profilo e approva o rifiuta.
--
-- verification_requests esisteva già (acquisto del badge con revisione
-- manuale), ma nessuna schermata mostrava le richieste. Stati:
--   'challenge' — gesto assegnato, selfie non ancora inviato
--   'pending'   — selfie inviato, da guardare in dashboard
--   'approved' / 'rejected'
-- ============================================================

ALTER TABLE verification_requests
    ADD COLUMN IF NOT EXISTS gesture        VARCHAR(40),
    ADD COLUMN IF NOT EXISTS selfie_url     TEXT,
    ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by    UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS reject_reason  VARCHAR(40);

CREATE INDEX IF NOT EXISTS verification_requests_status_idx
    ON verification_requests (status, submitted_at);
