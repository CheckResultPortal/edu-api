import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

// Opt in with a disposable local test database, never the application DATABASE_URL.
const url = process.env.TEST_WORKER_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('worker notification migration', () => {
  const schema = `worker_test_${randomUUID().replace(/-/g, '')}`;
  let writer: Client;
  let listener: Client;
  const received: string[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

  beforeAll(async () => {
    if (
      !url ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
    ) {
      throw new Error('Use a disposable local TEST_WORKER_DATABASE_URL.');
    }
    writer = new Client({ connectionString: url });
    listener = new Client({ connectionString: url });
    await writer.connect();
    await listener.connect();
    await writer.query(`CREATE SCHEMA "${schema}"`);
    await writer.query(`SET search_path TO "${schema}"`);
    await writer.query(`
      CREATE TABLE "OutboxEvent" ("eventType" text);
      CREATE TABLE "CommunicationDelivery" ("state" text, "nextAttemptAt" timestamptz);
      CREATE TABLE "VoucherRetrievalEmailDelivery" ("state" text, "nextAttemptAt" timestamptz);
    `);
    await writer.query(
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20260906120000_worker_notifications/migration.sql',
        ),
        'utf8',
      ),
    );
    listener.on('notification', (message) => {
      if (message.payload) received.push(message.payload);
    });
    await listener.query('LISTEN edu_worker_work');
  });

  afterAll(async () => {
    if (writer) {
      await writer.query('ROLLBACK');
      await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await writer.end();
    }
    await listener?.end();
  });

  it('signals only committed work and coalesces a batch to a topic', async () => {
    received.length = 0;
    await writer.query('BEGIN');
    await writer.query(
      `INSERT INTO "OutboxEvent" VALUES ('PaymentSucceeded'), ('PaymentSucceeded')`,
    );
    await settle();
    expect(received).toEqual([]);
    await writer.query('COMMIT');
    await settle();
    expect(received).toEqual(['PaymentSucceeded']);
    received.length = 0;
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO "OutboxEvent" VALUES ('VoucherAllocated')`);
    await writer.query('ROLLBACK');
    await settle();
    expect(received).toEqual([]);
  });

  it('wakes new delivery and manual retry but does not loop on processing or sent', async () => {
    received.length = 0;
    await writer.query(
      `INSERT INTO "CommunicationDelivery" VALUES ('PENDING', now())`,
    );
    await settle();
    expect(received).toEqual(['CommunicationDelivery']);
    received.length = 0;
    await writer.query(
      `UPDATE "CommunicationDelivery" SET "state" = 'PROCESSING'`,
    );
    await writer.query(`UPDATE "CommunicationDelivery" SET "state" = 'SENT'`);
    await settle();
    expect(received).toEqual([]);
    await writer.query(
      `UPDATE "CommunicationDelivery" SET "state" = 'RETRYING', "nextAttemptAt" = now()`,
    );
    await writer.query(
      `INSERT INTO "VoucherRetrievalEmailDelivery" VALUES ('PENDING', now())`,
    );
    await settle();
    expect(received).toEqual([
      'CommunicationDelivery',
      'VoucherRetrievalEmailDelivery',
    ]);
  });
});
