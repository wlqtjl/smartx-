#!/usr/bin/env node
/**
 * Build helper: copy raw SQL migration files from `src/storage/migrations/`
 * into the compiled `dist/` tree. tsc only emits `.ts`, so without this step
 * `loadMigrations()` would not find any files at runtime after a production
 * build. Invoked by the `build` npm script.
 */
const { cpSync, existsSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const src = 'src/storage/migrations';
const dest = 'dist/server/src/storage/migrations';

if (!existsSync(src)) {
  console.error(`[copy-migrations] source not found: ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
