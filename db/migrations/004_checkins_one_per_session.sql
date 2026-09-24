-- ============================================================
-- 004 — UN SOLO CHECK-IN PER PERSONA PER SERATA
-- ============================================================
-- handleCheckin controlla "è già dentro?" su Redis e POI scrive in
-- Postgres: due richieste arrivate insieme (doppio tocco, QR aperto
-- due volte, o React StrictMode in sviluppo che lancia l'effetto
-- del check-in automatico due volte) passavano entrambe il
-- controllo e creavano due righe identiche. Oltre alla riga doppia,
-- il contatore Redis della soglia veniva incrementato due volte.
--
-- Decisione presa con l'utente (24/9): una persona ha UNA sola riga
-- per serata. Chi esce e rientra riapre la stessa riga
-- (checked_out_at torna NULL), non ne crea una nuova — coerente con
-- il set Redis "già entrato", che vale per tutta la serata.
--
-- Prima di creare l'indice vanno tolti i doppioni già esistenti,
-- altrimenti la creazione fallisce. Teniamo la riga col check-in
-- più vecchio (a parità, quella con id minore): è l'arrivo vero.
-- Nessuna tabella punta a checkins.id, cancellare è sicuro.
-- ============================================================
DELETE FROM checkins c
USING checkins keep
WHERE c.user_id = keep.user_id
  AND c.arena_session_id = keep.arena_session_id
  AND (keep.checked_in_at, keep.id) < (c.checked_in_at, c.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkins_user_session ON checkins (user_id, arena_session_id);
