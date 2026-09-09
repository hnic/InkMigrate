"""Regression tests for validate-tokens.cjs.

The validator used to skip any line containing ``var(--`` outright, so a
hardcoded value sharing a line with a token reference (extremely common in
real CSS, and universal in minified CSS where everything is one line) went
undetected. These tests drive the CLI via ``node`` and assert it flags such
cases. They are pytest-based so the repository's existing pytest CI runs them.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "validate-tokens.cjs"
assert SCRIPT.is_file(), f"validator script not found at {SCRIPT}"


def _run(tmp_path: Path, css: str) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    (tmp_path / "sample.css").write_text(css)
    return subprocess.run(
        [node, str(SCRIPT), "--dir", str(tmp_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )


def test_flags_hardcoded_hex_sharing_line_with_token(tmp_path):
    """A hardcoded hex on the same line as a var() token is still a violation."""
    result = _run(
        tmp_path,
        ".btn { background: #FF6B6B; color: var(--color-primary); }\n",
    )
    assert "#FF6B6B" in result.stdout, result.stdout + result.stderr
    assert result.returncode == 1, result.stdout + result.stderr


def test_token_only_line_reports_no_violation(tmp_path):
    """A line that references only tokens produces no false positives."""
    result = _run(
        tmp_path,
        ".btn { background: var(--color-bg); color: var(--color-primary); }\n",
    )
    assert "No token violations" in result.stdout, result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr


def test_flags_multiple_violations_in_minified_one_line_css(tmp_path):
    """Minified one-line CSS: every hardcoded value on the line is reported."""
    result = _run(
        tmp_path,
        ".a{color:#FF6B6B;margin:12px}.b{color:var(--color-bg);padding:8px}\n",
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert result.stdout.count("Line 1:") >= 3, result.stdout + result.stderr


def test_recurses_into_nested_subdirectories(tmp_path):
    """Violations in nested subdirectories are found."""
    nested = tmp_path / "components"
    nested.mkdir()
    (nested / "sample.css").write_text(".a { color: #ABC; }\n")
    result = _run(tmp_path, "")  # root file stays clean
    assert "#ABC" in result.stdout, result.stdout + result.stderr
    assert result.returncode == 1, result.stdout + result.stderr
