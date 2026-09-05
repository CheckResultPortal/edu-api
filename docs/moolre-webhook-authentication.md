# Moolre callback authentication

Payments owns this change. The collection webhook documentation supplied by the
provider defines `data.secret`. Public API validates it before making a status
request. Status verification and existing reference, amount, currency and
idempotency checks remain required before payment success effects.

Set `MOOLRE_WEBHOOK_SECRET` in public-api runtime secrets to the callback secret
configured with Moolre before deploying. It is required when USSD is enabled.
The worker does not receive callbacks and does not require this secret.
Never log callback bodies or credentials. Authentication uses fixed-size SHA-256
digests with timing-safe comparison; work is linear in the bounded request body.

No schema, indexes, events, transactions or allocation behavior change. Invalid
credentials return 401 without provider calls or database effects. Provider
verification failures retain the existing retry/recovery behavior. Monitor 401
and 503 responses after deployment. Rotation requires coordinating the provider
callback secret with the API deployment. Rollback restores status-only validation;
retain status verification and prefer a forward configuration fix.

Acceptance: correct secret reaches status verification; missing, malformed,
incorrect or unconfigured secrets fail closed; worker needs no callback secret;
public API rejects missing configuration when USSD is enabled.
