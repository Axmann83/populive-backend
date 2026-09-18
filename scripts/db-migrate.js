/**
 * ============================================================
 * POPULIVE — APPLICA SCHEMA E MIGRAZIONI AL DATABASE LOCALE
 * ============================================================
 * Uso:  npm run db:migrate      (legge DATABASE_URL da .env)
 *
 * Ordine di esecuzione:
 *   1) populive-db-schema.sql          (schema base, solo se DB vuoto)
 *   2) db/migrations/*.sql             (in ordine alfabetico)
 *
 * Ogni file viene eseguito UNA sola volta: il nome viene
 * registrato nella tabella schema_migrations. Per aggiungere una
 * modifica allo schema basta creare un nuovo file numerato in
 * db/migrations/ e rilanciare questo comando.
 * ============================================================
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
// .env (segreti locali, opzionale) ha la precedenza su .env.dev
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, '.env.dev'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL mancante: copia .env.example in .env');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
  const applied = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));

  const files = [
    { name: '000_base_schema', file: path.join(ROOT, 'populive-db-schema.sql') },
    ...fs
      .readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: f.replace(/\.sql$/, ''), file: path.join(ROOT, 'db', 'migrations', f) })),
  ];

  let count = 0;
  for (const m of files) {
    if (applied.has(m.name)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    process.stdout.write(`→ ${m.name} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name]);
      await client.query('COMMIT');
      console.log('ok');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('ERRORE');
      console.error(err.message);
      await client.end();
      process.exit(1);
    }
  }
  console.log(count === 0 ? 'Database già aggiornato.' : `Applicate ${count} migrazioni.`);
  await client.end();
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
