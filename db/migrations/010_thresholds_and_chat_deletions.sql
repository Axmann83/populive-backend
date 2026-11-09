-- ============================================================
-- 010 — SOGLIE DEI LOCALI (M3) E CHAT ELIMINATE (M4)
-- ============================================================
-- Novembre 2026, lotto 7 di SPEC-bug-migliorie.md (decisioni del
-- 01/11).
--
-- M3 — due soglie diverse:
--  - venues.checkin_threshold: quante persone servono perché il radar
--    della serata si attivi. Da ora 2 per tutti i locali, sempre, e
--    non si modifica (prima 10–20 a seconda del tipo di locale).
--    Anche i locali esistenti passano a 2.
--  - venues.min_users_for_local_ranking: minimo di persone per
--    mostrare la classifica locale. Resta modificabile dalla
--    dashboard; per i locali NUOVI il valore iniziale passa da 5 a 20.
--    Quelli esistenti restano come sono.
--
-- M4 — le chat si conservano sempre (niente più "Conserva" né
-- l'interruttore chat_keep_required) e ognuno può eliminare una chat
-- solo per sé, come su WhatsApp: conversation_deletions ricorda
-- quando. La chat torna nell'elenco di chi l'ha eliminata solo se
-- l'altra persona scrive dopo, e mostra i soli messaggi successivi a
-- deleted_at. Eliminarla di nuovo sposta deleted_at in avanti.
-- Le colonne user_a_wants_keep / user_b_wants_keep restano (innocue,
-- non più lette): toglierle non serve a niente.
-- ============================================================

UPDATE venues SET checkin_threshold = 2 WHERE checkin_threshold IS DISTINCT FROM 2;
ALTER TABLE venues ALTER COLUMN checkin_threshold SET DEFAULT 2;
UPDATE venue_type_defaults SET default_checkin_threshold = 2;

ALTER TABLE venues ALTER COLUMN min_users_for_local_ranking SET DEFAULT 20;

DELETE FROM feature_flags WHERE feature_key = 'chat_keep_required';

CREATE TABLE IF NOT EXISTS conversation_deletions (
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);
