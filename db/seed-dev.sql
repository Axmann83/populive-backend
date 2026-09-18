-- ============================================================
-- POPULIVE — DATI DI PROVA PER LO SVILUPPO LOCALE
-- ============================================================
-- Uso:  npm run db:seed        (rieseguibile: non duplica nulla)
--
-- NON è una migrazione: sono solo dati finti per avere qualcosa
-- sulla mappa e nel catalogo acquisti appena avviato il server.
-- Gli utenti NON si creano qui: nascono dal login via OTP.
-- ============================================================

-- Orari e soglie di default per tipo di locale
INSERT INTO venue_type_defaults (venue_type, default_open_time, default_close_time, default_checkin_threshold, default_spending_threshold_cents, default_spending_bonus_points) VALUES
    ('nightclub',    '22:00', '06:00', 20, 10000, 50),
    ('ristorante',   '19:00', '24:00', 15,  8000, 30),
    ('palestra',     '06:00', '24:00', 10,  NULL, NULL),
    ('cocktail_bar', '17:00', '22:00', 15,  5000, 20),
    ('retail',       '09:00', '20:00', 10,  NULL, NULL)
ON CONFLICT (venue_type) DO NOTHING;

-- Tre locali a Roma (uno partner con Pulse acquistabili)
INSERT INTO venues (id, name, area, latitude, longitude, checkin_threshold, is_partner, venue_type, default_open_time, default_close_time, pulse_price_cents, pulse_bundle_5_price_cents, commission_venue_pct, min_users_for_local_ranking, spending_threshold_cents, spending_bonus_points)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'Club Demo',        'Roma · Testaccio',  41.8760, 12.4750, 20, true,  'nightclub',    '22:00', '06:00', 800, 3500, 70, 5, 10000, 50),
    ('22222222-2222-2222-2222-222222222222', 'Cocktail Bar Demo','Roma · Trastevere', 41.8890, 12.4700, 15, true,  'cocktail_bar', '17:00', '22:00', 600, 2500, 70, 5,  5000, 20),
    ('33333333-3333-3333-3333-333333333333', 'Palestra Demo',    'Roma · Prati',      41.9070, 12.4600, 10, false, 'palestra',     '06:00', '24:00', NULL, NULL, NULL, 5, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Catalogo acquisti in-app
INSERT INTO iap_products (sku, display_name, description, price_cents, product_type, effect_config) VALUES
    ('like_credits_20',     '20 Like extra',       'Venti Like in più per la serata in corso',    299,  'like_credits',  '{"credits": 20, "scope": "session"}'),
    ('superlike_pack_5',    '5 Superlike',         'Cinque Superlike, validi per sempre',         499,  'like_credits',  '{"credits": 5, "scope": "permanent", "kind": "superlike"}'),
    ('verified_badge',      'Badge Verificato',    'Identità confermata, per sempre',             0,    'verified_badge','{}'),
    ('premium_subscription','Premium 1 mese',      'Badge Premium e moltiplicatore punti x1.5',   999,  'premium',       '{"months": 1, "multiplier": 1.5}')
ON CONFLICT (sku) DO NOTHING;

-- Hashtag di base per l'onboarding
INSERT INTO hashtags (name) VALUES ('musica'), ('aperitivo'), ('sport'), ('techno'), ('vino'), ('foodie')
ON CONFLICT DO NOTHING;
