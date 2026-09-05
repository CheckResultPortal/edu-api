# Safe delivery failure logging

Communication owns these diagnostic messages. Replace raw console exception
logging with the configured StructuredLogger and fixed messages containing only
delivery public references. Never pass exception messages, objects, stacks,
contacts, credentials or decrypted voucher material to this logging boundary.

No schema, indexes, API, events, state transitions, retries or allocation behavior
change. Logging occurs in the existing preparation/send catch blocks, outside
database transactions, with constant-size messages. The worker's configured log
level controls output. Monitor these errors alongside persisted attempt outcomes.
Tests inject sensitive exception text and confirm it cannot reach the logger.
Rollback removes diagnostics only; no migration is required.
