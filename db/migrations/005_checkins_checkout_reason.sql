-- ============================================================
-- 005 — PERCHÉ UN CHECK-IN È STATO CHIUSO
-- ============================================================
-- Il geofencing (evaluateLocationPing, 18/9) chiude il check-in di
-- chi si è allontanato dal locale, ma il primo join_arena successivo
-- (riconnessione del socket, app ricaricata) lo riapriva da solo:
-- quella riapertura esiste per la disconnessione (schermo bloccato,
-- app in background), non per chi è davvero uscito. Verificato il
-- 28/9 con due utenti di prova: dopo il check-out per distanza,
-- una semplice riconnessione rimetteva la persona nel radar.
--
-- Serve quindi ricordare il MOTIVO della chiusura:
--   'distance' → chiuso dal geofence: join_arena NON lo riapre,
--                si rientra solo scansionando di nuovo il QR
--   NULL       → disconnessione, chiusura serata, cambio locale:
--                comportamento di sempre
-- ============================================================
ALTER TABLE checkins
    ADD COLUMN IF NOT EXISTS checked_out_reason VARCHAR(20);
