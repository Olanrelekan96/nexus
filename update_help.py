#!/usr/bin/env python3
"""Maintain the in-app Nexus Help/Tutorial.

Release rule:
  1. Update js/00-state-and-helpers.js when a user-visible feature changes.
  2. Add/refresh its section in NEXUS_HELP_FEATURE_CATALOG and the maintained
     guide sections used by ensureCompleteHelpGuide().
  3. Increment NEXUS_HELP_GUIDE_VERSION for material guide revisions.
  4. Run `npm test` and boot the app once to verify Help coverage.

This script is intentionally conservative: it does not rewrite user notebook
content. The app performs the safe append-on-missing-section migration at boot.
It only reports the current source-level Help contract so a release can be
checked consistently from the repository root.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / "js" / "00-state-and-helpers.js"
TEXT = STATE_FILE.read_text(encoding="utf-8")

m = re.search(r"var NEXUS_HELP_GUIDE_VERSION\s*=\s*(\d+)\s*;", TEXT)
version = int(m.group(1)) if m else None
catalog = re.findall(r"\{id:'[^']+', title:'([^']+)'\}", TEXT[TEXT.find('var NEXUS_HELP_FEATURE_CATALOG'):TEXT.find('function getHelpGuideCoverage')])

print(f"Nexus Help/Tutorial guide version: {version}")
print(f"Maintained feature topics: {len(catalog)}")
for i, title in enumerate(catalog, 1):
    print(f"{i:02d}. {title}")
print("\nMaintenance contract: every user-visible feature/setting/command/search/data-format/workflow change must update the Help/Tutorial in the same release.")
print("Run: npm test")
