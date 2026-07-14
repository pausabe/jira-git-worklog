import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This file lives at <root>/server/src/paths.ts (dev, via tsx)
// or <root>/server/dist/paths.js (build). Both resolve the same way.
const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the monorepo root (contains package.json workspaces). */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

/** Absolute path to the server workspace directory. */
export const SERVER_DIR = path.resolve(here, '..');

/** Local, gitignored data directory for link mappings and the imputation ledger. */
export const DATA_DIR = path.join(SERVER_DIR, 'data');

/**
 * Absolute path to the compiled web assets (web/dist).
 * Exists only after `npm run build --workspace web` has been executed.
 */
export const WEB_DIST_DIR = path.join(PROJECT_ROOT, 'web', 'dist');
