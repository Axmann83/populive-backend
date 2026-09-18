// ============================================================
// POPULIVE — REGOLE ESLINT
// ============================================================
// Cosa controlla:
//  - errori veri (variabili non definite, codice irraggiungibile...)
//  - variabili/import/parametri dichiarati e mai usati
//  - console.log dimenticati (per i log del server usare
//    console.info / console.warn / console.error)
//  - == al posto di ===, var al posto di const/let, ecc.
// La formattazione (virgole, spazi, a capo) NON è qui: la fa
// Prettier, e eslint-config-prettier spegne le regole in conflitto.
// ============================================================
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },

  js.configs.recommended,
  prettier,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_', // (req, _res, next) → _res è volutamente ignorato
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // catch (err) vuoto è accettabile
          ignoreRestSiblings: true,
        },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty-pattern': 'off', // il codice usa `async function f({}, { db })` per coerenza di firma
    },
  },

  // Gli script da riga di comando stampano il loro output con console.log: è il loro mestiere
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
