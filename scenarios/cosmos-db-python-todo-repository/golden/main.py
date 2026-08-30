from __future__ import annotations

import asyncio
import logging

from factory import async_container, sync_container
from model import TodoItem
from repository import AsyncTodoRepository, SyncTodoRepository


def run_sync_demo() -> None:
    with sync_container() as container:
        repository = SyncTodoRepository(container)
        created = repository.create(
            TodoItem.new("sync-1", "Write tests", "Cover repository behavior", "work"),
        )
        current = repository.read(created.id, created.category)
        for page in repository.query_by_category(current.category):
            print(f"sync page: {page}")
        current.completed = True
        updated = repository.update(current)
        print(f"sync updated: {updated}")
        repository.delete(updated.id, updated.category)


async def run_async_demo() -> None:
    async with async_container() as container:
        repository = AsyncTodoRepository(container)
        created = await repository.create(
            TodoItem.new("async-1", "Ship sample", "Run the async demo", "work"),
        )
        current = await repository.read(created.id, created.category)
        async for page in repository.query_by_category(current.category):
            print(f"async page: {page}")
        current.completed = True
        updated = await repository.update(current)
        print(f"async updated: {updated}")
        await repository.delete(updated.id, updated.category)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    run_sync_demo()
    asyncio.run(run_async_demo())


if __name__ == "__main__":
    main()
