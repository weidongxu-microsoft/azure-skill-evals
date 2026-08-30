from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any

from azure.core import MatchConditions
from azure.cosmos.exceptions import CosmosHttpResponseError

from model import TodoItem


LOGGER = logging.getLogger(__name__)


class TodoConflictError(RuntimeError):
    pass


def _raise_repository_error(operation: str, error: CosmosHttpResponseError) -> None:
    if error.status_code == 412:
        raise TodoConflictError(
            f"{operation} rejected because the ToDo item changed",
        ) from error
    if error.status_code == 404:
        raise LookupError(f"{operation} could not find the ToDo item") from error
    if error.status_code == 409:
        raise FileExistsError(f"{operation} found an existing ToDo item") from error
    raise error


def _charge_hook(operation: str):
    def capture(headers: Mapping[str, str], _response: Any) -> None:
        charge = headers.get("x-ms-request-charge", "unknown")
        LOGGER.info("%s consumed %s RU", operation, charge)

    return capture


class SyncTodoRepository:
    def __init__(self, container: Any) -> None:
        self._container = container

    def create(self, item: TodoItem) -> TodoItem:
        try:
            document = self._container.create_item(
                body=item.to_document(),
                partition_key=item.category,
                response_hook=_charge_hook("sync create"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("create", error)

    def read(self, item_id: str, category: str) -> TodoItem:
        try:
            document = self._container.read_item(
                item=item_id,
                partition_key=category,
                response_hook=_charge_hook("sync read"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("read", error)

    def update(self, item: TodoItem) -> TodoItem:
        if not item.etag:
            raise ValueError("An ETag from a prior read is required")
        try:
            document = self._container.replace_item(
                item=item.id,
                body=item.to_document(),
                partition_key=item.category,
                etag=item.etag,
                match_condition=MatchConditions.IfNotModified,
                response_hook=_charge_hook("sync update"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("update", error)

    def delete(self, item_id: str, category: str) -> None:
        try:
            self._container.delete_item(
                item=item_id,
                partition_key=category,
                response_hook=_charge_hook("sync delete"),
            )
        except CosmosHttpResponseError as error:
            _raise_repository_error("delete", error)

    def query_by_category(
        self,
        category: str,
        page_size: int = 25,
    ) -> Iterator[list[TodoItem]]:
        query = "SELECT * FROM c WHERE c.category = @category"
        parameters = [{"name": "@category", "value": category}]
        try:
            results = self._container.query_items(
                query=query,
                parameters=parameters,
                max_item_count=page_size,
                response_hook=_charge_hook("sync query page"),
            )
            pager = results.by_page()
            for page in pager:
                items = [TodoItem.from_document(document) for document in page]
                token = getattr(pager, "continuation_token", None)
                LOGGER.info(
                    "sync query page count=%d continuation=%s",
                    len(items),
                    token,
                )
                yield items
        except CosmosHttpResponseError as error:
            _raise_repository_error("query", error)


class AsyncTodoRepository:
    def __init__(self, container: Any) -> None:
        self._container = container

    async def create(self, item: TodoItem) -> TodoItem:
        try:
            document = await self._container.create_item(
                body=item.to_document(),
                partition_key=item.category,
                response_hook=_charge_hook("async create"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("create", error)

    async def read(self, item_id: str, category: str) -> TodoItem:
        try:
            document = await self._container.read_item(
                item=item_id,
                partition_key=category,
                response_hook=_charge_hook("async read"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("read", error)

    async def update(self, item: TodoItem) -> TodoItem:
        if not item.etag:
            raise ValueError("An ETag from a prior read is required")
        try:
            document = await self._container.replace_item(
                item=item.id,
                body=item.to_document(),
                partition_key=item.category,
                etag=item.etag,
                match_condition=MatchConditions.IfNotModified,
                response_hook=_charge_hook("async update"),
            )
            return TodoItem.from_document(document)
        except CosmosHttpResponseError as error:
            _raise_repository_error("update", error)

    async def delete(self, item_id: str, category: str) -> None:
        try:
            await self._container.delete_item(
                item=item_id,
                partition_key=category,
                response_hook=_charge_hook("async delete"),
            )
        except CosmosHttpResponseError as error:
            _raise_repository_error("delete", error)

    async def query_by_category(
        self,
        category: str,
        page_size: int = 25,
    ) -> AsyncIterator[list[TodoItem]]:
        query = "SELECT * FROM c WHERE c.category = @category"
        parameters = [{"name": "@category", "value": category}]
        try:
            results = self._container.query_items(
                query=query,
                parameters=parameters,
                max_item_count=page_size,
                response_hook=_charge_hook("async query page"),
            )
            pager = results.by_page()
            async for page in pager:
                items = [TodoItem.from_document(document) async for document in page]
                token = getattr(pager, "continuation_token", None)
                LOGGER.info(
                    "async query page count=%d continuation=%s",
                    len(items),
                    token,
                )
                yield items
        except CosmosHttpResponseError as error:
            _raise_repository_error("query", error)
