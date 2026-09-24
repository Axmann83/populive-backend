/**
 * Carica db/seed-dev.sql nel database locale (dati di prova).
 * Uso:  npm run db:seed
 *       node scripts/db-seed.js percorso/altro-file.sql   (un altro file SQL)
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
// .env (segreti locali, opzionale) ha la precedenza su .env.dev
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, '.env.dev'));

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const sqlFile = path.resolve(ROOT, process.argv[2] || path.join('db', 'seed-dev.sql'));
  await client.query(fs.readFileSync(sqlFile, 'utf8'));
  const { rows } = await client.query(`
    SELECT (SELECT COUNT(*) FROM venues) AS venues,
           (SELECT COUNT(*) FROM iap_products) AS products,
           (SELECT COUNT(*) FROM hashtags) AS hashtags
  `);
  console.log(
    `${path.relative(ROOT, sqlFile)} caricato — locali: ${rows[0].venues}, prodotti: ${rows[0].products}, hashtag: ${rows[0].hashtags}`
  );
  await client.end();
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
