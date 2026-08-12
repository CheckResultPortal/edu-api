import { LoggerService } from '@nestjs/common';

type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface StructuredLoggerOptions {
  readonly environment: string;
  readonly level: LogLevel;
  readonly service: string;
}

const enabledLevels: Record<LogLevel, readonly LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  log: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  verbose: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

export class StructuredLogger implements LoggerService {
  constructor(private readonly options: StructuredLoggerOptions) {}

  log(message: string, context?: string): void {
    this.write('log', message, context);
  }

  error(message: string, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: string, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: string, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: string, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: string, context?: string): void {
    this.write('fatal', message, context);
  }

  request(fields: {
    readonly correlationId: string;
    readonly durationMs: number;
    readonly method: string;
    readonly route: string;
    readonly statusCode: number;
  }): void {
    this.write('log', 'HTTP request completed', undefined, undefined, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    context?: string,
    trace?: string,
    fields?: Record<string, string | number>,
  ): void {
    if (!enabledLevels[this.options.level].includes(level)) {
      return;
    }

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.options.service,
      environment: this.options.environment,
      message,
      ...(context ? { context } : {}),
      ...(trace ? { trace } : {}),
      ...fields,
    });

    if (level === 'error' || level === 'fatal') {
      process.stderr.write(`${entry}\n`);
      return;
    }

    process.stdout.write(`${entry}\n`);
  }
}
