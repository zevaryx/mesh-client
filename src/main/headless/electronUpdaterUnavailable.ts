/**
 * Headless stand-in for `electron-updater` (aliased by `scripts/build-headless.mjs`).
 *
 * `updater.ts` loads electron-updater with a guarded `require` and falls back to the GitHub
 * release check when it throws. Headless always runs that check (`releaseCheckOnly`), so this
 * module only guarantees the Electron auto-updater never ships in the server bundle.
 */
throw new Error('electron-updater is not available in headless builds');
