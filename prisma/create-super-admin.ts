import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Pool } from 'pg';
import { hashAdminPassword } from '@edu-api/administration';

function loadEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const root = path.resolve(__dirname, '..');
for (const file of [
  path.join(root, '.env.local'),
  path.join(root, '.env'),
  path.join(root, 'apps/admin-api/.env.local'),
  path.join(root, 'apps/admin-api/.env'),
  path.join(root, 'apps/public-api/.env.local'),
  path.join(root, 'apps/public-api/.env'),
  path.join(root, 'apps/worker/.env.local'),
  path.join(root, 'apps/worker/.env'),
]) {
  loadEnv(file);
}

async function promptForValue(
  label: string,
  options: { secret?: boolean } = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${label} must be provided through the environment when this command is not run interactively.`,
    );
  }

  if (!options.secret) {
    const terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await new Promise<string>((resolve) => {
        terminal.question(`${label}: `, resolve);
      });
    } finally {
      terminal.close();
    }
  }

  process.stdout.write(`${label}: `);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      process.stdout.write('\n');
      resolve(value);
    };
    const cancel = (): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      process.stdout.write('\n');
      reject(new Error('Initial Super Admin creation cancelled.'));
    };
    const onData = (key: string): void => {
      if (key === '\r' || key === '\n') {
        finish();
      } else if (key === '\u0003') {
        cancel();
      } else if (key === '\b' || key === '\u007f') {
        value = value.slice(0, -1);
      } else if (key >= ' ') {
        value += key;
      }
    };
    input.on('data', onData);
  });
}

async function createSuperAdmin(): Promise<void> {
  const email = (
    process.env.ADMIN_INITIAL_SUPER_ADMIN_EMAIL ??
    (await promptForValue('Initial Super Admin email'))
  )
    .trim()
    .toLowerCase();
  const passwordFromEnvironment =
    process.env.ADMIN_INITIAL_SUPER_ADMIN_PASSWORD;
  const password =
    passwordFromEnvironment ??
    (await promptForValue('Initial Super Admin password', { secret: true }));
  const confirmPassword =
    process.env.ADMIN_INITIAL_SUPER_ADMIN_PASSWORD_CONFIRMATION ??
    (passwordFromEnvironment === undefined
      ? await promptForValue('Confirm initial Super Admin password', {
          secret: true,
        })
      : password);

  if (!email || !email.includes('@')) {
    throw new Error('Initial Super Admin email must be a valid email address.');
  }
  if (!password || password.length < 14) {
    throw new Error(
      'Initial Super Admin password is required (min 14 characters).',
    );
  }
  if (password !== confirmPassword) {
    throw new Error('Initial Super Admin passwords do not match.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required in .env or environment.');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const existing = await pool.query(
      `SELECT id FROM "AdminUser" WHERE role = 'SUPER_ADMIN' LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      throw new Error('A Super Admin already exists.');
    }

    const passwordHash = await hashAdminPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO "AdminUser" ("publicId", email, "passwordHash", role, "isInitialSuperAdmin", "isActive", "failedAuthenticationCount", "passwordChangedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, 'SUPER_ADMIN', true, true, 0, NOW(), NOW(), NOW())
         RETURNING id, "publicId"`,
        [email, passwordHash],
      );
      const admin = result.rows[0];
      await client.query(
        `INSERT INTO "AdminSecurityEvent" ("adminUserId", "eventType", "correlationId", metadata, "occurredAt")
         VALUES ($1, 'INITIAL_SUPER_ADMIN_CREATED', 'initial-super-admin-script', $2, NOW())`,
        [admin.id, JSON.stringify({ adminPublicId: admin.publicId })],
      );
      await client.query('COMMIT');
      process.stdout.write(
        `Super Admin ${admin.publicId} created. TOTP enrollment required at first login.\n`,
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void createSuperAdmin();
