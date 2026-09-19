-- ============================================================
-- 002 — GALLERIA FOTO PROFILO (users.photo_urls)
-- ============================================================
-- Aggiunta il 18/9 direttamente in populive-db-schema.sql: fino a
-- 6 foto in ordine, mostrate per intero solo nel profilo a tutto
-- schermo. photo_url resta la foto principale (= photo_urls[1]).
-- Questa migrazione serve ai database creati PRIMA di quella
-- modifica; su un DB nuovo la colonna esiste già (IF NOT EXISTS).
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_urls TEXT[] DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_photo_urls_max_six') THEN
    ALTER TABLE users ADD CONSTRAINT users_photo_urls_max_six
      CHECK (array_length(photo_urls, 1) IS NULL OR array_length(photo_urls, 1) <= 6);
  END IF;
END $$;
