-- ============================================================
-- 003 — CONNECTOR PROFESSIONISTI (PR) E PRE-ASSEGNAZIONE TAVOLI
-- ============================================================
-- Introdotti nel codice il 19/9 (populive-connector-engine.js):
--  - users.is_professional_connector: flag attivato dalla dashboard,
--    mai auto-attivabile. Chi lo ha può "prendersi" un tavolo prima
--    che arrivi il primo membro (claimTableAsProfessionalConnector).
--  - table_connector_assignments: il tavolo pre-assegnato. Se esiste
--    una riga qui vince sempre sulla scelta spontanea in
--    squad_memberships (vedi resolveTableConnectorId).
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_professional_connector BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS table_connector_assignments (
    arena_session_id  UUID REFERENCES arena_sessions(id),
    table_qr_code     VARCHAR(50) NOT NULL,
    connector_id      UUID REFERENCES users(id),
    created_at        TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (arena_session_id, table_qr_code)   -- un solo Connector pre-assegnato per tavolo e serata
);
