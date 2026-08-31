from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ServiceBusConfig:
    fully_qualified_namespace: str
    queue_name: str

    @classmethod
    def from_environment(cls) -> "ServiceBusConfig":
        namespace = os.environ.get("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE")
        queue_name = os.environ.get("SERVICE_BUS_QUEUE_NAME")
        missing = [
            name
            for name, value in (
                ("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", namespace),
                ("SERVICE_BUS_QUEUE_NAME", queue_name),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                f"Missing required environment variable(s): {', '.join(missing)}"
            )
        return cls(
            fully_qualified_namespace=namespace,
            queue_name=queue_name,
        )
