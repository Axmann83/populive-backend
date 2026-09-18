/**
 * ============================================================
 * POPULIVE — VERIFICA CHE OGNI QUERY DEL CODICE SIA VALIDA SUL DB
 * ============================================================
 * Uso:  npm run db:validate
 *
 * Estrae tutte le stringhe SQL passate a db.query / db.queryAll
 * nei file .js e chiede a Postgres di "prepararle" (PREPARE):
 * il database controlla tabelle, colonne e sintassi SENZA
 * eseguire nulla. Utile dopo ogni modifica allo schema per
 * scoprire subito una colonna dimenticata, invece di aspettare
 * che un utente finisca su quell'endpoint.
 *
 * Errori del tipo "could not determine data type of parameter"
 * vengono ignorati: dipendono da come Postgres inferisce i tipi
 * dei $1, $2... e non indicano un problema reale.
 * ============================================================
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
// .env (segreti locali, opzionale) ha la precedenza su .env.dev
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, '.env.dev'));

function extractQueries() {
  const out = [];
  for (const f of fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /\b(?:db|pool|client)\.(?:query|queryAll)\(\s*(`([\s\S]*?)`|'([^']*)'|"([^"]*)")/g;
    let m;
    while ((m = re.exec(src))) {
      // ${...} dentro i template literal = SQL costruito dinamicamente
      // (nome di colonna, condizione WHERE aggiuntiva, intervallo...).
      // Non ne conosciamo il valore a questo punto: nei casi noti lo
      // sostituiamo con qualcosa di neutro, altrimenti lo togliamo.
      const sql = (m[2] ?? m[3] ?? m[4])
        .replace(/SET\s+\$\{[^}]*\}\s*=/g, 'SET created_at =') // UPDATE t SET ${colonna} = ...
        .replace(/\$\{[^}]*\}\s+days/g, '1 days') // interval '${n} days'
        .replace(/\$\$\{[^}]*\}/g, '$1') // $${paramIndex} → parametro numerato dinamico
        .replace(/\$\{[^}]*\}/g, ''); // frammenti WHERE opzionali
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ file: f, line, sql });
    }
  }
  return out;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const queries = extractQueries();
  const problems = [];
  let i = 0;
  for (const q of queries) {
    i++;
    const nParams = Math.max(0, ...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => parseInt(m[1])));
    const types = Array.from({ length: nParams }, () => 'unknown').join(', ');
    const prep = `PREPARE _chk_${i}${nParams ? `(${types})` : ''} AS ${q.sql}`;
    try {
      await client.query(prep);
      await client.query(`DEALLOCATE _chk_${i}`);
    } catch (err) {
      if (
        /could not determine data type|is of type .* but expression is of type|inconsistent types deduced|operator does not exist: .* unknown/i.test(
          err.message
        )
      )
        continue;
      problems.push({ ...q, error: err.message });
    }
  }
  await client.end();

  console.log(`Query controllate: ${queries.length}`);
  if (problems.length === 0) {
    console.log('Tutte le query sono compatibili con lo schema attuale.');
    return;
  }
  console.log(`Problemi trovati: ${problems.length}\n`);
  for (const p of problems) console.log(`${p.file}:${p.line}\n   ${p.error}\n`);
  process.exit(1);
}

// Parser .env minimale (evita una dipendenza in più solo per questo script)
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
