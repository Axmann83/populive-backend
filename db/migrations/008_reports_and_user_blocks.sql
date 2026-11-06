-- ============================================================
-- 008 — SEGNALAZIONI, BLOCCHI DEGLI UTENTI, SOSPENSIONE
-- ============================================================
-- Novembre 2026, B2 in SPEC-bug-migliorie.md (regola 1.2 di Apple per
-- le app con contenuti degli utenti: segnalare contenuti e profili,
-- bloccare una persona, agire sulle segnalazioni).
--
--  - user_reports: una segnalazione di un profilo, di una foto o di
--    una chat. Tre motivi fissi più un testo facoltativo. snapshot
--    conserva cosa c'era al momento (nome e foto del profilo, ultimi
--    messaggi della chat): chi è segnalato può cambiare le foto, e i
--    messaggi di una chat chiusa si cancellano dopo 30 giorni.
--    Le controllano gli Architetti dalla dashboard: 'reviewed' =
--    violazione confermata (account sospeso), 'dismissed' = archiviata.
--  - user_blocks: chi ha bloccato chi. Il blocco vero e proprio resta
--    nella tabella blocks (motivo 'user_blocked', nelle due
--    direzioni, controllato da tutti gli invii già esistenti), che
--    però non dice chi ha bloccato: questa tabella serve all'elenco
--    dei bloccati nelle Impostazioni e a sbloccare.
--  - users.suspended_at: account sospeso da un Architetto, non può
--    più accedere né usare l'app. NULL = attivo.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id       UUID NOT NULL REFERENCES users(id),
    reported_user_id  UUID NOT NULL REFERENCES users(id),
    context           VARCHAR(20) NOT NULL CHECK (context IN ('profile', 'photo', 'chat')),
    conversation_id   UUID REFERENCES chat_conversations(id) ON DELETE SET NULL,
    reason            VARCHAR(30) NOT NULL CHECK (reason IN ('adult_content', 'harassment', 'fake_or_spam')),
    details           TEXT,
    snapshot          JSONB,
    status            VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at       TIMESTAMPTZ,
    reviewed_by       UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_user_reports_reported ON user_reports(reported_user_id);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id  UUID NOT NULL REFERENCES users(id),
    blocked_id  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES users(id);
