"""Shared test bootstrap: put the scripts directory on sys.path so the test
modules can import shadcn_add / tailwind_config_gen directly."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
