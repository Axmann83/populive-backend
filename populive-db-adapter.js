/**
 * ============================================================
 * POPULIVE — ADATTATORE DATABASE
 * ============================================================
 * In tutto il codice scritto finora (handleCheckin, sendPulse,
 * awardPoints, ecc.) abbiamo sempre chiamato:
 *   - db.query(sql, params)    → ci aspettiamo UNA riga (o niente)
 *   - db.queryAll(sql, params) → ci aspettiamo un ARRAY di righe
 *
 * La libreria vera per Postgres in Node ("pg") non funziona così:
 * pool.query() restituisce sempre un oggetto risultato con dentro
 * un array "rows", mai direttamente la riga o le righe. Questo file
 * è il "traduttore" — prende la libreria vera e la fa comportare
 * come tutto il resto del codice si aspetta, così non dobbiamo
 * riscrivere decine di funzioni già pronte.
 * ============================================================
 */

const { Pool } = require('pg');

function createDb(connectionString) {
  const pool = new Pool({ connectionString });

  return {
    // Una sola riga (o null se la query non trova nulla) — usato
    // per "trovami questo utente", "questa sessione esiste?", ecc.
    async query(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows.length > 0 ? result.rows[0] : null;
    },

    // Tutte le righe come array — usato per liste (classifica,
    // membri di una squadra, marker da valutare, ecc.)
    async queryAll(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },

    // Accesso diretto al pool originale, per i rari casi in cui
    // serve una transazione vera (più query che devono andare a
    // buon fine insieme o fallire insieme) — non usato ancora nel
    // nostro codice, ma bene tenerlo pronto.
    pool,

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb };
