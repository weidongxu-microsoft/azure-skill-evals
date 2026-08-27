# Event Hubs Python reference application

Set `EVENT_HUBS_CONNECTION_STRING`, `EVENT_HUB_NAME`,
`BLOB_STORAGE_CONNECTION_STRING`, and `BLOB_CHECKPOINT_CONTAINER`. Then run:

```powershell
python -m pip install -r requirements.txt
python event_hubs.py
```

The application sends ten events, then receives and checkpoints events for up
to 30 seconds. The graders also accept equivalent current-SDK implementations.
