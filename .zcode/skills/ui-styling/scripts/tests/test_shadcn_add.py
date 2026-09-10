"""Tests for shadcn_add.py"""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from shadcn_add import ShadcnInstaller


class TestShadcnInstaller:
    """Test ShadcnInstaller class."""

    @pytest.fixture
    def temp_project(self, tmp_path):
        """Create temporary project structure."""
        project_root = tmp_path / "test-project"
        project_root.mkdir()

        # Create components.json
        components_json = project_root / "components.json"
        components_json.write_text(
            json.dumps({
                "style": "new-york",
                "aliases": {
                    "components": "@/components",
                    "utils": "@/lib/utils"
                }
            })
        )

        # Create components directory
        ui_dir = project_root / "components" / "ui"
        ui_dir.mkdir(parents=True)

        return project_root

    def test_init_default_project_root(self):
        """Test initialization with default project root."""
        installer = ShadcnInstaller()
        assert installer.project_root == Path.cwd()
        assert installer.dry_run is False

    def test_init_custom_project_root(self, tmp_path):
        """Test initialization with custom project root."""
        installer = ShadcnInstaller(project_root=tmp_path)
        assert installer.project_root == tmp_path

    def test_init_dry_run(self):
        """Test initialization with dry run mode."""
        installer = ShadcnInstaller(dry_run=True)
        assert installer.dry_run is True

    def test_check_shadcn_config_exists(self, temp_project):
        """Test checking for existing shadcn config."""
        installer = ShadcnInstaller(project_root=temp_project)
        assert installer.check_shadcn_config() is True

    def test_check_shadcn_config_not_exists(self, tmp_path):
        """Test checking for non-existent shadcn config."""
        installer = ShadcnInstaller(project_root=tmp_path)
        assert installer.check_shadcn_config() is False

    def test_get_installed_components_empty(self, temp_project):
        """Test getting installed components when none exist."""
        installer = ShadcnInstaller(project_root=temp_project)
        installed = installer.get_installed_components()
        assert installed == []

    def test_get_installed_components_with_files(self, temp_project):
        """Test getting installed components when files exist."""
        ui_dir = temp_project / "components" / "ui"

        # Create component files
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")
        (ui_dir / "card.tsx").write_text("export const Card = () => {}")

        installer = ShadcnInstaller(project_root=temp_project)
        installed = installer.get_installed_components()

        assert sorted(installed) == ["button", "card"]

    def test_get_installed_components_no_config(self, tmp_path):
        """Test getting installed components without config."""
        installer = ShadcnInstaller(project_root=tmp_path)
        installed = installer.get_installed_components()
        assert installed == []

    def test_get_installed_components_tsconfig_src_alias(self, tmp_path):
        """Aliases mapped through tsconfig '@/*': ['./src/*'] must resolve to
        src/components/ui, not components/ui."""
        project_root = tmp_path / "test-project"
        project_root.mkdir()

        (project_root / "components.json").write_text(
            json.dumps({
                "aliases": {"components": "@/components"}
            })
        )
        (project_root / "tsconfig.json").write_text(
            json.dumps({
                "compilerOptions": {"paths": {"@/*": ["./src/*"]}}
            })
        )

        ui_dir = project_root / "src" / "components" / "ui"
        ui_dir.mkdir(parents=True)
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")

        installer = ShadcnInstaller(project_root=project_root)
        assert installer.get_installed_components() == ["button"]

    @staticmethod
    def _project_with_tsconfig(tmp_path, paths, base_url=None):
        """Create a project whose tsconfig maps the given paths."""
        project_root = tmp_path / "test-project"
        project_root.mkdir()
        compiler_options = {"paths": paths}
        if base_url is not None:
            compiler_options["baseUrl"] = base_url
        (project_root / "tsconfig.json").write_text(
            json.dumps({"compilerOptions": compiler_options})
        )
        return project_root

    def test_resolve_alias_multi_entry_targets_uses_first(self, tmp_path):
        """Multi-entry target lists resolve via the first entry."""
        project_root = self._project_with_tsconfig(
            tmp_path, {"@/*": ["./src/*", "./app/*"]}
        )
        installer = ShadcnInstaller(project_root=project_root)
        assert installer._resolve_alias("@/components") == project_root / "src" / "components"

    def test_resolve_alias_non_wildcard_target_maps_directly(self, tmp_path):
        """A non-wildcard target under a '@/*' pattern maps directly
        (no '/*' slicing)."""
        project_root = self._project_with_tsconfig(
            tmp_path, {"@/*": ["./custom-base"]}
        )
        installer = ShadcnInstaller(project_root=project_root)
        assert installer._resolve_alias("@/components") == project_root / "custom-base" / "components"

    def test_resolve_alias_without_at_prefix_ignores_tsconfig(self, tmp_path):
        """Aliases without the '@/' prefix resolve relative to the project
        root without consulting tsconfig."""
        project_root = self._project_with_tsconfig(
            tmp_path, {"@/*": ["./src/*"]}
        )
        installer = ShadcnInstaller(project_root=project_root)
        assert installer._resolve_alias("components") == project_root / "components"

    def test_resolve_alias_jsonc_tsconfig_parses(self, tmp_path):
        """tsconfig.json with comments/trailing commas (JSONC) must still
        resolve, not silently fall back to the project root."""
        project_root = tmp_path / "test-project"
        project_root.mkdir()
        (project_root / "tsconfig.json").write_text(
            """{
              // path aliases
              "compilerOptions": {
                "paths": {
                  "@/*": ["./src/*",], /* trailing comma */
                },
              },
            }"""
        )
        installer = ShadcnInstaller(project_root=project_root)
        assert installer._resolve_alias("@/components") == project_root / "src" / "components"

    def test_resolve_alias_base_url_with_bare_wildcard_target(self, tmp_path):
        """baseUrl-relative mapping: {"baseUrl": "src", "paths": {"@/*": ["*"]}}
        must resolve within src/, not produce a literal '*' path segment."""
        project_root = self._project_with_tsconfig(
            tmp_path, {"@/*": ["*"]}, base_url="src"
        )
        installer = ShadcnInstaller(project_root=project_root)
        assert installer._resolve_alias("@/components") == project_root / "src" / "components"

    def test_add_components_no_components(self, temp_project):
        """Test adding components with empty list."""
        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components([])

        assert success is False
        assert "No components specified" in message

    def test_add_components_no_config(self, tmp_path):
        """Test adding components without shadcn config."""
        installer = ShadcnInstaller(project_root=tmp_path)
        success, message = installer.add_components(["button"])

        assert success is False
        assert "not initialized" in message

    def test_add_components_already_installed(self, temp_project):
        """Test adding components that are already installed."""
        ui_dir = temp_project / "components" / "ui"
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is False
        assert "already installed" in message
        assert "button" in message

    def test_add_components_mixed_already_installed(self, temp_project):
        """A batch mixing installed and missing components must be rejected
        as a whole (no partial install), naming only the installed ones and
        never reaching npx."""
        ui_dir = temp_project / "components" / "ui"
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")

        installer = ShadcnInstaller(project_root=temp_project)

        with patch("subprocess.run") as mock_run:
            success, message = installer.add_components(["button", "card"])

        assert success is False
        assert "already installed" in message
        assert "button" in message
        assert "card" not in message
        mock_run.assert_not_called()

    def test_add_components_with_overwrite(self, temp_project):
        """Test adding components with overwrite flag."""
        ui_dir = temp_project / "components" / "ui"
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")

        installer = ShadcnInstaller(project_root=temp_project)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                stdout="Component added successfully",
                returncode=0
            )

            success, message = installer.add_components(["button"], overwrite=True)

            assert success is True
            assert "Successfully added" in message
            mock_run.assert_called_once()

            # Verify --overwrite flag was passed
            call_args = mock_run.call_args[0][0]
            assert "--overwrite" in call_args

    def test_add_components_dry_run(self, temp_project):
        """Test adding components in dry run mode."""
        installer = ShadcnInstaller(project_root=temp_project, dry_run=True)
        success, message = installer.add_components(["button", "card"])

        assert success is True
        assert "Would run:" in message
        assert "button" in message
        assert "card" in message

    @patch("subprocess.run")
    def test_add_components_success(self, mock_run, temp_project):
        """Test successful component addition."""
        mock_run.return_value = MagicMock(
            stdout="Components added successfully",
            stderr="",
            returncode=0
        )

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button", "card"])

        assert success is True
        assert "Successfully added" in message
        assert "button" in message
        assert "card" in message

        # Verify correct command was called
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        # npx is resolved via shutil.which, so it may be an absolute path
        # (npx / npx.cmd / npx.exe depending on platform)
        assert Path(call_args[0]).name in ("npx", "npx.cmd", "npx.exe", "npx.bat")
        assert call_args[1].startswith("shadcn@")  # version from package.json/pinned fallback
        assert call_args[2] == "add"
        assert "button" in call_args
        assert "card" in call_args

    @patch("subprocess.run")
    def test_add_components_resolves_package_json_version(self, mock_run, temp_project):
        """The shadcn version comes from package.json with range prefixes
        stripped, not just the pinned fallback."""
        mock_run.return_value = MagicMock(
            stdout="Component added successfully",
            stderr="",
            returncode=0
        )
        (temp_project / "package.json").write_text(
            json.dumps({"devDependencies": {"shadcn": "^2.4.5"}})
        )

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is True
        call_args = mock_run.call_args[0][0]
        assert call_args[1] == "shadcn@2.4.5"

    @patch("subprocess.run")
    def test_add_components_non_semver_version_uses_fallback(self, mock_run, temp_project):
        """Non-semver specifiers (workspace:*, git URLs) can't be resolved by
        npx; the pinned default must be used instead."""
        mock_run.return_value = MagicMock(
            stdout="Component added successfully",
            stderr="",
            returncode=0
        )
        (temp_project / "package.json").write_text(
            json.dumps({"dependencies": {"shadcn": "workspace:*"}})
        )

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is True
        call_args = mock_run.call_args[0][0]
        assert call_args[1] == "shadcn@2.3.0"

    @patch("subprocess.run")
    def test_add_components_subprocess_error(self, mock_run, temp_project):
        """Test component addition with subprocess error."""
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "cmd", stderr="Error occurred"
        )

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is False
        assert "Failed to add" in message

    @patch("subprocess.run")
    def test_add_components_timeout(self, mock_run, temp_project):
        """Test component addition timing out (_run_shadcn applies a 600s timeout)."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="npx", timeout=600)

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is False
        assert "timed out" in message

    @patch("subprocess.run")
    def test_add_all_components_timeout(self, mock_run, temp_project):
        """Test add-all timing out with its distinct message."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="npx", timeout=600)

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_all_components()

        assert success is False
        assert "timed out" in message
        assert "Failed to add all components" in message

    @patch("subprocess.run")
    def test_add_components_npx_not_found(self, mock_run, temp_project):
        """Test component addition when npx is not found."""
        mock_run.side_effect = FileNotFoundError()

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_components(["button"])

        assert success is False
        assert "npx not found" in message

    def test_add_all_components_no_config(self, tmp_path):
        """Test adding all components without config."""
        installer = ShadcnInstaller(project_root=tmp_path)
        success, message = installer.add_all_components()

        assert success is False
        assert "not initialized" in message

    def test_add_all_components_dry_run(self, temp_project):
        """Test adding all components in dry run mode."""
        installer = ShadcnInstaller(project_root=temp_project, dry_run=True)
        success, message = installer.add_all_components()

        assert success is True
        assert "Would run:" in message
        assert "--all" in message

    @patch("subprocess.run")
    def test_add_all_components_success(self, mock_run, temp_project):
        """Test successful addition of all components."""
        mock_run.return_value = MagicMock(
            stdout="All components added",
            returncode=0
        )

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.add_all_components()

        assert success is True
        assert "Successfully added all" in message

        # Verify --all flag was passed
        call_args = mock_run.call_args[0][0]
        assert "--all" in call_args

    def test_list_installed_no_config(self, tmp_path):
        """Test listing installed components without config."""
        installer = ShadcnInstaller(project_root=tmp_path)
        success, message = installer.list_installed()

        assert success is False
        assert "not initialized" in message

    def test_list_installed_empty(self, temp_project):
        """Test listing installed components when none exist."""
        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.list_installed()

        assert success is True
        assert "No components installed" in message

    def test_list_installed_with_components(self, temp_project):
        """Test listing installed components when they exist."""
        ui_dir = temp_project / "components" / "ui"
        (ui_dir / "button.tsx").write_text("export const Button = () => {}")
        (ui_dir / "card.tsx").write_text("export const Card = () => {}")

        installer = ShadcnInstaller(project_root=temp_project)
        success, message = installer.list_installed()

        assert success is True
        assert "button" in message
        assert "card" in message
