-- ============================================================
-- 006 — LA DATA DELLA SERATA SI CALCOLA IN ORA ITALIANA
-- ============================================================
-- current_business_date (schema base) confrontava gli orari del
-- locale con now()::TIME, cioè con l'ora del fuso del database: in
-- locale e su Supabase è UTC. Un locale "22:00-06:00" apriva quindi
-- alle 00:00 italiane (23:00 d'inverno) e la data della serata
-- cambiava alla mezzanotte UTC. L'app è solo per l'Italia: gli
-- orari dei locali sono sempre ora italiana (Europe/Rome, ora
-- legale compresa), indipendentemente dal fuso del database.
--
-- Seconda correzione (ottobre 2026, D14 nella spec): un locale con
-- apertura = chiusura (es. 06:00-06:00) è aperto 24 ore su 24, e la
-- sua serata cambia all'orario di apertura. Prima per le ore prima
-- dell'apertura restituiva la data di oggi invece di quella di ieri.
-- ============================================================
CREATE OR REPLACE FUNCTION current_business_date(p_venue_id UUID)
RETURNS DATE AS $$
DECLARE
  v_open  TIME;
  v_close TIME;
  v_local TIMESTAMP := now() AT TIME ZONE 'Europe/Rome';
BEGIN
  SELECT default_open_time, default_close_time
  INTO v_open, v_close
  FROM venues WHERE id = p_venue_id;

  -- Locale che attraversa la mezzanotte (es. discoteca 22:00-06:00),
  -- o aperto 24 ore (apertura = chiusura), e siamo ancora prima
  -- dell'orario di chiusura/riapertura di stamattina: la serata è
  -- ancora quella di ieri.
  IF v_close <= v_open AND v_local::TIME < v_close THEN
    RETURN (v_local::DATE - INTERVAL '1 day')::DATE;
  END IF;

  RETURN v_local::DATE;
END;
$$ LANGUAGE plpgsql;
