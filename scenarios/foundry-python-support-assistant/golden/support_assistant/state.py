from __future__ import annotations

import json
from copy import deepcopy
from typing import Protocol

from azure.core import MatchConditions
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import ContainerClient

from .models import AssistantState, state_from_dict, state_to_dict


class StateStore(Protocol):
    def load(self) -> AssistantState: ...

    def save(self, state: AssistantState) -> None: ...


class BlobStateStore:
    def __init__(self, container: ContainerClient, blob_name: str) -> None:
        self._container = container
        self._blob = container.get_blob_client(blob_name)

    def initialize(self) -> None:
        self._container.get_container_properties()

    def load(self) -> AssistantState:
        try:
            downloader = self._blob.download_blob()
            value = json.loads(downloader.readall())
            state = state_from_dict(value)
            state.etag = downloader.properties.etag
            state.loaded = True
            return state
        except ResourceNotFoundError:
            return AssistantState(loaded=True)

    def save(self, state: AssistantState) -> None:
        if not state.loaded:
            raise RuntimeError("State must be loaded before it can be saved.")
        content = json.dumps(
            state_to_dict(state), indent=2, separators=(",", ": ")
        ).encode()
        if state.etag is None:
            response = self._blob.upload_blob(
                content,
                overwrite=False,
            )
        else:
            response = self._blob.upload_blob(
                content,
                overwrite=True,
                etag=state.etag,
                match_condition=MatchConditions.IfNotModified,
            )
        state.etag = response.get("etag")


class MemoryStateStore:
    def __init__(self) -> None:
        self._state = AssistantState(loaded=True)
        self._save_count = 0
        self.fail_on_save: int | None = None

    def load(self) -> AssistantState:
        state = deepcopy(self._state)
        state.loaded = True
        return state

    def save(self, state: AssistantState) -> None:
        self._save_count += 1
        if self.fail_on_save == self._save_count:
            raise OSError("simulated durable save failure")
        self._state = deepcopy(state)
