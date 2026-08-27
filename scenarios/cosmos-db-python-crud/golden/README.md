# Cosmos DB Python reference application

This application is a known-good implementation of the Cosmos DB Python CRUD
stimulus. It provides positive evidence that all deterministic grader rules can
be satisfied by runnable, lint-clean Python code.

Set `COSMOS_ENDPOINT`, install `requirements.txt`, authenticate with Azure CLI
or managed identity, and run:

```powershell
python cosmos_crud.py
```

The application is not the only accepted implementation. Graders must continue
to accept equivalent API usage and code structures.

