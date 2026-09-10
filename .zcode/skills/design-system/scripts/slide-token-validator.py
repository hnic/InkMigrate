#!/usr/bin/env python3
"""
Slide Token Validator (Legacy Wrapper)
Now delegates to html-token-validator.py for unified HTML validation.

For new usage, prefer:
  python html-token-validator.py --type slides
  python html-token-validator.py --type infographics
  python html-token-validator.py                       # All HTML assets
"""

import sys
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
UNIFIED_VALIDATOR = SCRIPT_DIR / 'html-token-validator.py'


def main():
    """Delegate to unified html-token-validator.py with --type slides."""
    args = sys.argv[1:]

    # Default to slides type only when the caller hasn't chosen one (the
    # child ignores --type when specific files are given)
    has_type = any(a in ('-t', '--type') or a.startswith('--type=') for a in args)
    if not has_type:
        args = ['--type', 'slides'] + args
    cmd = [sys.executable, str(UNIFIED_VALIDATOR)] + args

    result = subprocess.run(cmd)
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
