/**
 * ============================================================
 * POPULIVE — TETTO SUI PUNTI BONUS (equità Connector / Big Spender)
 * ============================================================
 * Decisione presa insieme all'utente (18/9), dopo una riflessione
 * sul fatto che i punti bonus (riflesso squadra 15%, bonus scoperta,
 * talent scout di fine serata — tutti in populive-connector-engine.js
 * — più il bonus spesa al tavolo di Big Spender) rischiavano di far
 * dominare sempre PR e grandi spendaccioni sia in classifica locale
 * che generale, un problema serio perché la generale un domani
 * pagherà soldi veri (Paid for Likes Revolution, v. memoria
 * populive-visione-futura).
 *
 * NIENTE terza classifica (scartata esplicitamente — confonderebbe
 * l'utente). Invece: un TETTO UNICO su TUTTI i punti bonus insieme
 * (Connector + Big Spender nello stesso calderone, mai tetti separati
 * per meccanica), applicato SOLO nel momento in cui si sommano i
 * punti per le classifiche — il ledger permanente (points_ledger)
 * non viene MAI toccato o riscritto. La somma finale per la
 * classifica è sempre: "tutti i punti NON bonus, per intero, più i
 * punti bonus fino al tetto".
 *
 * Due livelli, entrambi dinamici (mai un numero fisso):
 *   - Tetto di SERATA — protegge la classifica LOCALE di stasera,
 *     calcolato sui punti di quella singola arena_session.
 *   - Tetto MENSILE — protegge la classifica GENERALE nel lungo
 *     periodo: applicato mese di calendario per mese di calendario
 *     (mai un tetto unico su tutta la vita dell'account, che si
 *     ricalcolerebbe all'infinito ogni volta che cambia il primo in
 *     classifica) e poi sommato — così un mese già chiuso resta
 *     fermo per sempre.
 *
 * Il tetto = il MAGGIORE tra:
 *   (A) un minimo di sicurezza fisso (serve SOLO nelle fasi iniziali
 *       o nelle serate ancora poco attive, per non azzerare il
 *       valore dei bonus quando i punti organici sono ancora bassi
 *       — proprio quando servono di più i PR per creare massa
 *       critica);
 *   (B) un moltiplicatore applicato ai punti ORGANICI (SOLO
 *       interazioni dirette ricevute — Like, Superlike, Pulse in
 *       ogni variante — MAI missioni, visite profilo o punti da
 *       mittente) della persona in cima a QUELLA classifica in QUEL
 *       periodo. Si auto-calibra da solo, niente numeri da ritarare
 *       a mano col crescere dell'app — quando l'attività organica
 *       sale, il moltiplicatore prende il sopravvento da solo.
 *
 * I badge Top Connector e Top Spender in sé (calcolo a percentile su
 * TUTTI i punti di contribuzione, senza tetto — chi li VINCE) restano
 * completamente estranei a questo file: lì è una gara diretta tra
 * pari (PR contro PR, spesa contro spesa), giusto che vinca il
 * migliore — v. populive-connector-engine.js.
 *
 * Il tetto è sempre SILENZIOSO — mai comunicato a chi lo raggiunge,
 * stesso spirito della soglia minima classifica locale
 * (checkLocalRankingThreshold in populive-ranking-queries.js).
 *
 * VALORI ANCORA DA TARARE (esplicitamente lasciati "da decidere"
 * nella discussione con l'utente — stesso principio di BASE_POINTS
 * in populive-points-engine.js: piccoli, interi, cambiabili da un
 * solo posto quando arriveranno i numeri veri dalle serate).
 * ============================================================
 */

const BONUS_CAP_MULTIPLIER = 1.75; // via di mezzo nel range 1,5–2x discusso con l'utente — DA TARARE
const BONUS_CAP_FLOOR_SESSION = 40; // punti bonus minimi garantiti per serata, prima che il moltiplicatore prenda il sopravvento — DA TARARE
const BONUS_CAP_FLOOR_MONTHLY = 400; // stesso principio, su base mensile — DA TARARE

// Letterali SQL fissi (nessun input utente coinvolto — sempre gli
// stessi source della tabella BASE_POINTS/nomi già usati altrove nel
// codice), interpolati direttamente invece che come parametri
// posizionali: rende i due frammenti CTE sotto riusabili senza dover
// far combaciare a mano gli indici $n con la query che li ospita.
// table_activity_bonus_1/2/3 (19/9) — bonus "tavolo più attivo" di
// fine serata, si divide tra tutti i partecipanti del tavolo — v.
// awardTopTableActivityBonuses in populive-connector-engine.js.
const BONUS_CAP_SOURCES_SQL = `ARRAY['squad_reflection','connector_discovery_bonus','connector_top_talent_1','connector_top_talent_2','connector_top_talent_3','table_spending_threshold','table_activity_bonus_1','table_activity_bonus_2','table_activity_bonus_3']`;
const ORGANIC_REFERENCE_SOURCES_SQL = `ARRAY['like_received','superlike_received','pulse_standalone','pulse_like','pulse_like_match','pulse_super','like_match']`;

/**
 * Frammento CTE riusabile — punti-per-classifica di ogni utente in
 * UNA arena_session (serata), con il tetto di serata già applicato.
 * Usare come `WITH ${localCappedPointsCte('$1')} SELECT ... FROM
 * local_capped_points lcp ...`, dove l'argomento è il placeholder
 * posizionale ($1, $2, ...) già usato dal chiamante per
 * l'arena_session_id — nessun parametro proprio da aggiungere, dato
 * che le costanti sopra sono letterali SQL, non parametri.
 * Espone una riga per utente (solo chi ha almeno un punto stasera):
 * local_capped_points(user_id, capped_points).
 */
function localCappedPointsCte(arenaSessionIdPlaceholder) {
  return `
    bonus_agg AS (
      SELECT
        user_id,
        COALESCE(SUM(points) FILTER (WHERE source = ANY(${BONUS_CAP_SOURCES_SQL})), 0) AS bonus_points,
        COALESCE(SUM(points) FILTER (WHERE source = ANY(${ORGANIC_REFERENCE_SOURCES_SQL})), 0) AS organic_reference_points,
        COALESCE(SUM(points) FILTER (WHERE NOT (source = ANY(${BONUS_CAP_SOURCES_SQL}))), 0) AS non_bonus_points
      FROM points_ledger
      WHERE arena_session_id = ${arenaSessionIdPlaceholder} AND counts_toward_local = true
      GROUP BY user_id
    ),
    session_cap AS (
      SELECT GREATEST(${BONUS_CAP_FLOOR_SESSION}, ${BONUS_CAP_MULTIPLIER} * COALESCE(MAX(organic_reference_points), 0)) AS cap_value
      FROM bonus_agg
    ),
    local_capped_points AS (
      SELECT ba.user_id, ba.non_bonus_points + LEAST(ba.bonus_points, sc.cap_value) AS capped_points
      FROM bonus_agg ba CROSS JOIN session_cap sc
    )
  `;
}

/**
 * Stesso principio, ma per TUTTA la storia di un utente, con il
 * tetto applicato mese di calendario per mese di calendario (mai un
 * tetto unico su tutta la vita dell'account). Nessun parametro:
 * guarda tutta points_ledger senza filtri — chi la usa filtra dopo,
 * nella query principale, su utente/hashtag/genere/limite come già
 * faceva prima.
 * Espone una riga per utente (solo chi ha almeno un punto in tutta
 * la sua storia): global_capped_points(user_id, capped_points).
 */
function globalCappedPointsCte() {
  return `
    bonus_by_month AS (
      SELECT
        user_id,
        date_trunc('month', created_at) AS month,
        COALESCE(SUM(points) FILTER (WHERE source = ANY(${BONUS_CAP_SOURCES_SQL})), 0) AS bonus_points,
        COALESCE(SUM(points) FILTER (WHERE source = ANY(${ORGANIC_REFERENCE_SOURCES_SQL})), 0) AS organic_reference_points
      FROM points_ledger
      GROUP BY user_id, date_trunc('month', created_at)
    ),
    monthly_cap AS (
      SELECT month, GREATEST(${BONUS_CAP_FLOOR_MONTHLY}, ${BONUS_CAP_MULTIPLIER} * COALESCE(MAX(organic_reference_points), 0)) AS cap_value
      FROM bonus_by_month
      GROUP BY month
    ),
    capped_bonus_per_user AS (
      SELECT bbm.user_id, SUM(LEAST(bbm.bonus_points, mc.cap_value)) AS capped_bonus_total
      FROM bonus_by_month bbm
      JOIN monthly_cap mc ON mc.month = bbm.month
      GROUP BY bbm.user_id
    ),
    non_bonus_per_user AS (
      SELECT
        user_id,
        COALESCE(SUM(points) FILTER (WHERE NOT (source = ANY(${BONUS_CAP_SOURCES_SQL}))), 0) AS non_bonus_total
      FROM points_ledger
      GROUP BY user_id
    ),
    global_capped_points AS (
      SELECT
        COALESCE(nb.user_id, cb.user_id) AS user_id,
        COALESCE(nb.non_bonus_total, 0) + COALESCE(cb.capped_bonus_total, 0) AS capped_points
      FROM non_bonus_per_user nb
      FULL OUTER JOIN capped_bonus_per_user cb ON cb.user_id = nb.user_id
    )
  `;
}

module.exports = {
  BONUS_CAP_MULTIPLIER,
  BONUS_CAP_FLOOR_SESSION,
  BONUS_CAP_FLOOR_MONTHLY,
  BONUS_CAP_SOURCES_SQL,
  ORGANIC_REFERENCE_SOURCES_SQL,
  localCappedPointsCte,
  globalCappedPointsCte,
};
