from __future__ import annotations

import os


def detect_environment() -> str:
    if any(
        os.getenv(name)
        for name in (
            "CI",
            "TF_BUILD",
            "BUILD_SOURCESDIRECTORY",
            "AZURE_PIPELINE_WORKSPACE",
        )
    ):
        return "ci"
    if os.getenv("IDENTITY_ENDPOINT") or os.getenv("MSI_ENDPOINT"):
        return "production"
    return "dev"
