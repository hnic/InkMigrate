#!/usr/bin/env python3
"""
shadcn/ui Component Installer

Add shadcn/ui components to project with automatic dependency handling.
Wraps shadcn CLI for programmatic component installation.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional


class ShadcnInstaller:
    """Handle shadcn/ui component installation."""

    def __init__(self, project_root: Optional[Path] = None, dry_run: bool = False):
        """
        Initialize installer.

        Args:
            project_root: Project root directory (default: current directory)
            dry_run: If True, show actions without executing
        """
        self.project_root = project_root or Path.cwd()
        self.dry_run = dry_run
        self.components_json = self.project_root / "components.json"

    def check_shadcn_config(self) -> bool:
        """
        Check if shadcn is initialized in project.

        Returns:
            True if components.json exists
        """
        return self.components_json.exists()

    def get_installed_components(self) -> List[str]:
        """
        Get list of already installed components.

        Returns:
            List of installed component names
        """
        if not self.check_shadcn_config():
            return []

        try:
            with open(self.components_json) as f:
                config = json.load(f)

            components_dir = self._resolve_alias(
                config.get("aliases", {}).get("components", "components")
            )
            ui_dir = components_dir / "ui"

            if not ui_dir.exists():
                return []

            return [f.stem for f in ui_dir.glob("*.tsx") if f.is_file()]
        except (json.JSONDecodeError, KeyError, OSError):
            return []

    def _resolve_alias(self, alias: str) -> Path:
        """
        Resolve a components.json alias (e.g. '@/components') to a directory.

        Stripping the '@/' prefix alone is wrong for the common setup where
        tsconfig.json maps '@/*' onto a subdirectory, e.g.
        "paths": {"@/*": ["./src/*"]} places components in src/components/ui.
        Consults tsconfig.json path mappings before falling back to the
        project root.

        Returns:
            Path to the alias target, relative paths resolved against project root
        """
        if not alias.startswith("@/"):
            return self.project_root / alias

        prefix, _, rest = alias.partition("/")
        base = ""
        tsconfig = self.project_root / "tsconfig.json"
        if tsconfig.exists():
            try:
                ts = json.loads(tsconfig.read_text())
                paths = ts.get("compilerOptions", {}).get("paths", {})
                for pattern, targets in paths.items():
                    if pattern == f"{prefix}/*" and targets:
                        target = str(targets[0])
                        # './src/*' -> './src'; non-wildcard targets map directly
                        base = target[:-2] if target.endswith("/*") else target
                        break
            except (json.JSONDecodeError, OSError, TypeError):
                pass

        return self.project_root / base / rest

    def _get_shadcn_version(self) -> str:
        """Read shadcn version from project package.json; fall back to a pinned default."""
        pkg_json = self.project_root / "package.json"
        if pkg_json.exists():
            try:
                pkg = json.loads(pkg_json.read_text())
                for section in ("dependencies", "devDependencies"):
                    version = pkg.get(section, {}).get("shadcn")
                    if version:
                        return version.lstrip("^~>=<").split()[0]
            except (json.JSONDecodeError, KeyError):
                pass
        return "2.3.0"  # pinned fallback; update when newer stable release is needed

    def _run_shadcn(self, cmd: List[str]) -> subprocess.CompletedProcess:
        """
        Run an npx command non-interactively.

        Resolves the npx executable via PATH (on Windows subprocess can't run
        'npx' directly — it needs npx.cmd, which shutil.which finds), closes
        stdin, and applies a timeout so a confirmation prompt (from npx or the
        shadcn CLI) fails fast instead of hanging an unattended run.

        Raises:
            subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError (npx missing)
        """
        npx = shutil.which(cmd[0]) or cmd[0]
        return subprocess.run(
            [npx] + cmd[1:],
            cwd=self.project_root,
            capture_output=True,
            text=True,
            check=True,
            stdin=subprocess.DEVNULL,
            timeout=600,
        )

    def add_components(
        self, components: List[str], overwrite: bool = False
    ) -> tuple[bool, str]:
        """
        Add shadcn/ui components.

        Args:
            components: List of component names to add
            overwrite: If True, overwrite existing components

        Returns:
            Tuple of (success, message)
        """
        if not components:
            return False, "No components specified"

        if not self.check_shadcn_config():
            return (
                False,
                "shadcn not initialized. Run 'npx shadcn@latest init' first",
            )

        # Check which components already exist
        installed = self.get_installed_components()
        already_installed = [c for c in components if c in installed]

        if already_installed and not overwrite:
            return (
                False,
                f"Components already installed: {', '.join(already_installed)}. "
                "Use --overwrite to reinstall",
            )

        # Build command
        shadcn_version = self._get_shadcn_version()
        cmd = ["npx", f"shadcn@{shadcn_version}", "add", "--yes"] + components

        if overwrite:
            cmd.append("--overwrite")

        if self.dry_run:
            return True, f"Would run: {' '.join(cmd)}"

        # Execute command
        try:
            result = self._run_shadcn(cmd)

            success_msg = f"Successfully added components: {', '.join(components)}"
            if result.stdout:
                success_msg += f"\n\nOutput:\n{result.stdout}"

            return True, success_msg

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to add components: {e.stderr or e.stdout or str(e)}"
            return False, error_msg
        except subprocess.TimeoutExpired:
            return False, "Failed to add components: timed out after 600 seconds"
        except FileNotFoundError:
            return False, "npx not found. Ensure Node.js is installed"

    def add_all_components(self, overwrite: bool = False) -> tuple[bool, str]:
        """
        Add all available shadcn/ui components.

        Args:
            overwrite: If True, overwrite existing components

        Returns:
            Tuple of (success, message)
        """
        if not self.check_shadcn_config():
            return (
                False,
                "shadcn not initialized. Run 'npx shadcn@latest init' first",
            )

        shadcn_version = self._get_shadcn_version()
        cmd = ["npx", f"shadcn@{shadcn_version}", "add", "--all", "--yes"]

        if overwrite:
            cmd.append("--overwrite")

        if self.dry_run:
            return True, f"Would run: {' '.join(cmd)}"

        try:
            result = self._run_shadcn(cmd)

            success_msg = "Successfully added all components"
            if result.stdout:
                success_msg += f"\n\nOutput:\n{result.stdout}"

            return True, success_msg

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to add all components: {e.stderr or e.stdout or str(e)}"
            return False, error_msg
        except subprocess.TimeoutExpired:
            return False, "Failed to add all components: timed out after 600 seconds"
        except FileNotFoundError:
            return False, "npx not found. Ensure Node.js is installed"

    def list_installed(self) -> tuple[bool, str]:
        """
        List installed components.

        Returns:
            Tuple of (success, message with component list)
        """
        if not self.check_shadcn_config():
            return False, "shadcn not initialized"

        installed = self.get_installed_components()

        if not installed:
            return True, "No components installed"

        return True, f"Installed components:\n" + "\n".join(f"  - {c}" for c in sorted(installed))


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Add shadcn/ui components to your project",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Add single component
  python shadcn_add.py button

  # Add multiple components
  python shadcn_add.py button card dialog

  # Add all components
  python shadcn_add.py --all

  # Overwrite existing components
  python shadcn_add.py button --overwrite

  # Dry run (show what would be done)
  python shadcn_add.py button card --dry-run

  # List installed components
  python shadcn_add.py --list
        """,
    )

    parser.add_argument(
        "components",
        nargs="*",
        help="Component names to add (e.g., button, card, dialog)",
    )

    parser.add_argument(
        "--all",
        action="store_true",
        help="Add all available components",
    )

    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing components",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without executing",
    )

    parser.add_argument(
        "--list",
        action="store_true",
        help="List installed components",
    )

    parser.add_argument(
        "--project-root",
        type=Path,
        help="Project root directory (default: current directory)",
    )

    args = parser.parse_args()

    # Reject conflicting modes instead of silently discarding arguments
    if args.list and (args.components or args.all):
        parser.error("--list cannot be combined with component names or --all")
    if args.all and args.components:
        parser.error("--all cannot be combined with individual component names")

    # Initialize installer
    installer = ShadcnInstaller(
        project_root=args.project_root,
        dry_run=args.dry_run,
    )

    # Handle list command
    if args.list:
        success, message = installer.list_installed()
        print(message)
        sys.exit(0 if success else 1)

    # Handle add all command
    if args.all:
        success, message = installer.add_all_components(overwrite=args.overwrite)
        print(message)
        sys.exit(0 if success else 1)

    # Handle add specific components
    if not args.components:
        parser.print_help()
        sys.exit(1)

    success, message = installer.add_components(
        args.components,
        overwrite=args.overwrite,
    )

    print(message)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
