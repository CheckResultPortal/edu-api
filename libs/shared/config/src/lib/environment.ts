import { z } from 'zod';

const nodeEnvironmentSchema = z.enum([
  'development',
  'test',
  'staging',
  'production',
]);

const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
]);

const commonEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),

  SERVICE_NAME: z.string().trim().min(1),

  LOG_LEVEL: logLevelSchema.default('log'),

  DATABASE_URL: z.url(),

  REDIS_URL: z.url(),
});

const httpEnvironmentSchema = commonEnvironmentSchema.extend({
  HOST: z.string().trim().min(1).default('0.0.0.0'),

  PORT: z.coerce.number().int().min(1).max(65_535),
});

export const publicApiEnvironmentSchema = httpEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});

export const adminApiEnvironmentSchema = httpEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
});

export const workerEnvironmentSchema = commonEnvironmentSchema;

export type PublicApiEnvironment = z.infer<typeof publicApiEnvironmentSchema>;

export type AdminApiEnvironment = z.infer<typeof adminApiEnvironmentSchema>;

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

function parseEnvironment<TSchema extends z.ZodType>(
  schema: TSchema,
  values: Record<string, unknown>,
): z.infer<TSchema> {
  const result = schema.safeParse(values);

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const field = issue.path.join('.') || 'environment';

        return `${field}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${messages}`);
  }

  return result.data;
}

export function validatePublicApiEnvironment(
  values: Record<string, unknown>,
): PublicApiEnvironment {
  return parseEnvironment(publicApiEnvironmentSchema, values);
}

export function validateAdminApiEnvironment(
  values: Record<string, unknown>,
): AdminApiEnvironment {
  return parseEnvironment(adminApiEnvironmentSchema, values);
}

export function validateWorkerEnvironment(
  values: Record<string, unknown>,
): WorkerEnvironment {
  return parseEnvironment(workerEnvironmentSchema, values);
}
