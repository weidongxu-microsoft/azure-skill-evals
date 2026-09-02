from __future__ import annotations

import compileall
import os
from collections.abc import Iterator
from pathlib import Path


EXCLUDED_DIRECTORIES = {
    ".cache",
    ".git",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".vally",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "site-packages",
    "target",
    "venv",
}


def application_files(root: Path) -> Iterator[Path]:
    for directory, subdirectories, filenames in os.walk(root):
        current = Path(directory)
        subdirectories[:] = [
            name
            for name in subdirectories
            if name not in EXCLUDED_DIRECTORIES
            and not (current / name / "SKILL.md").is_file()
        ]
        yield from (
            current / filename
            for filename in filenames
            if filename.endswith(".py")
        )


def main(root: Path = Path.cwd()) -> int:
    passed = True
    for file in sorted(application_files(root)):
        if not compileall.compile_file(file, quiet=1):
            passed = False
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
