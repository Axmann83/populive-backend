-- ============================================================
-- 007 — TOKEN DEI DISPOSITIVI PER LE NOTIFICHE PUSH
-- ============================================================
-- Ottobre 2026, D3 nella spec: chi resta nel radar con l'app chiusa
-- (D14) deve sapere di Like, Superlike, Pulse, match e messaggi.
-- Le push passano da Firebase Cloud Messaging, sia su Android sia su
-- iOS (Firebase inoltra ad APNs): qui si tiene il token FCM di ogni
-- dispositivo.
--  - Una persona può avere più dispositivi (telefono nuovo, tablet):
--    una riga per token, non per utente.
--  - Il token identifica il dispositivo, non la persona: se sullo
--    stesso telefono entra un altro account, la riga passa a lui
--    (vincolo UNIQUE su token + ON CONFLICT nel backend).
--  - last_seen_at si aggiorna a ogni avvio dell'app: serve a capire
--    quali token sono vecchi. Quelli che Firebase dichiara non più
--    validi si cancellano al primo invio fallito.
-- ============================================================
CREATE TABLE IF NOT EXISTS push_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token         TEXT NOT NULL UNIQUE,
    platform      VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
