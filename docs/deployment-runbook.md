# Production deployment runbook

`docker-compose.prod.yml` defines PostgreSQL, Redis, the public API, Admin API,
and worker for Coolify or a compatible Docker Compose host. The application
containers run `prisma migrate deploy` before starting; migration deployment is
therefore safe to repeat but must use a backed-up production database.

The Docker build target is `EDU_APP_NAME`, not `APP_NAME`. This avoids a name
collision with Coolify's own application-name variable. Compose supplies the
correct target automatically: `public-api`, `admin-api`, or `worker`.

## Required deployment configuration

Inject these values using the host's secret store, never a committed `.env`
file:

- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL` is composed internally.
- `CORS_ALLOWED_ORIGINS`: a comma-separated, exact HTTPS allowlist; no wildcard.
- `ORDER_PRIVACY_HMAC_KEY`, all administrator and voucher encryption keys, and
  `PAYSTACK_SECRET_KEY`.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `MOOLRE_SMS_VAS_KEY`,
  `MOOLRE_SMS_SENDER_ID`, and `CUSTOMER_SUPPORT_PHONE`.
- `PAYSTACK_CALLBACK_URL` and `ADMIN_APPLICATION_ORIGIN`, both HTTPS public
  origins.

Run an off-host encrypted database backup before the first migration and before
each production schema release. Confirm the public and admin health endpoints
return ready only after PostgreSQL and Redis are healthy.

## Enabling Nalo USSD and Moolre collection

The production compose file defaults `USSD_ENABLED` to `false`. Set it to
`true` only after configuring the real Nalo USERID and Moolre collection
credentials, and inject all of:

- `NALO_USER_ID`;
- `MOOLRE_API_USER`, `MOOLRE_PUBLIC_KEY`, and `MOOLRE_ACCOUNT_NUMBER`.

`NALO_TRUSTED_SOURCE_IPS` is optional. When supplied, it is a comma-separated
IP allowlist; when omitted, EduVoucher follows the production Mould approach
of validating the Nalo USERID and applying rate limits. The handset request
creates a durable payment-prompt outbox event;
the worker makes the Moolre call outside the database transaction, then safely
retries or reconciles it in the background. Do not expose Moolre credentials to
the frontend or substitute unverified client payment state for provider
verification.

## Release checks

1. Confirm `prisma migrate status` is clean and the application logs contain no
   unresolved migration errors.
2. Run a web checkout and a controlled Nalo USSD purchase through provider test
   credentials, including a delayed callback/recovery case.
3. Verify the admin dashboard, inventory/backlog, delivery retry, audit, and
   reconciliation views with a TOTP-authenticated administrator.
4. Confirm email delivery contains the PDF and CSV attachments and the support
   number; confirm SMS/email failure does not allocate a second voucher.
5. Monitor payment recovery, outbox age, paid backlog age, delivery failures,
   reconciliation findings, database connection pressure, and API p95/p99.
