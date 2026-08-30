# Cosmos DB pagination

Run with an optional saved continuation token:

```powershell
dotnet run --project CosmosPagination.csproj -- "<token>"
```

Set `COSMOS_CONNECTION_STRING`; `COSMOS_DATABASE` and `COSMOS_CONTAINER` are
optional.

`FeedIterator<T>` exposes page boundaries, continuation tokens, and request
charges directly. LINQ is useful for composing typed predicates with
`GetItemLinqQueryable<T>()`; convert the query with `ToFeedIterator()` when the
application still needs explicit asynchronous page control.
