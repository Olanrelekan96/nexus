/* Soft-runs the browser E2E suite (tests/e2e/nexus_e2e.py) as part of `npm test`.
 *
 * E2E needs Python + Playwright + a downloaded Chromium — not every machine running
 * `npm test` has that set up. The previous state was worse than either hard-requiring
 * or skipping it on purpose: `npm test` simply never attempted it, with nothing to
 * tell you that the deepest coverage in the repo (multi-device sync convergence over
 * thousands of randomized sessions, encrypted Drive round-trips, passcode/version-
 * history browser flows) hadn't run. A clean `npm test` looked identical whether or
 * not any of that had been checked.
 *
 * This script closes that gap without breaking the fast local loop for anyone who
 * hasn't installed the optional E2E dependencies: it runs the suite when it can, and
 * when it can't, it fails loudly enough that "npm test passed" never gets mistaken
 * for "the full suite passed." It does not replace `npm run test:e2e`, which still
 * hard-fails on a missing Playwright — use that in CI, or before trusting a change
 * to the sync/crypto path with real long-term data. */
'use strict';
const { execSync, spawnSync } = require('child_process');

function hasPlaywright() {
  try {
    execSync('python3 -c "import playwright.sync_api"', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

if (!hasPlaywright()) {
  console.warn(
    '\n\x1b[33m' +
    '\u26a0  SKIPPING browser E2E tests (tests/e2e/nexus_e2e.py) — Python Playwright not found.\n' +
    '   These are the ONLY tests covering real multi-device sync convergence, encrypted\n' +
    '   Google Drive round-trips, and passcode/version-history browser flows — the rest\n' +
    '   of "npm test" passing does NOT mean that coverage ran.\n' +
    '   Install once with:  pip install playwright && playwright install chromium\n' +
    '   Then verify with:   npm run test:e2e\x1b[0m\n'
  );
  process.exit(0);
}

const result = spawnSync('python3', ['tests/e2e/nexus_e2e.py'], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
