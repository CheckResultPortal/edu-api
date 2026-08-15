import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseReadinessClient,
} from '@edu-api/database';
import { jsonApiResource } from '@edu-api/http';

import {
  SERVICE_DEPENDENCIES,
  createServiceDependencies,
  type ServiceDependencies,
} from './service-dependencies';
import { assessServiceReadiness } from './service-readiness';

interface HealthResponse {
  readonly service: string;
  readonly status: 'ok';
}

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(
    private readonly config: ConfigService,
    @Inject(SERVICE_DEPENDENCIES)
    private readonly dependencies: ServiceDependencies,
  ) {}

  getHealth(): HealthResponse {
    return {
      service: this.config.getOrThrow<string>('SERVICE_NAME'),
      status: 'ok',
    };
  }

  async getReadiness(): Promise<HealthResponse> {
    const readiness = await assessServiceReadiness(this.dependencies);

    if (!readiness.ready) {
      throw new Error('Required service dependencies are unavailable.');
    }

    return this.getHealth();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dependencies.close();
  }
}

@Controller('health')
@ApiTags('Operations')
@ApiProduces('application/vnd.api+json')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth() {
    return this.asResource(this.healthService.getHealth());
  }

  @Get('live')
  @ApiOperation({ summary: 'Check API process liveness' })
  @ApiOkResponse({ description: 'The API process is live.' })
  getLive() {
    return this.getHealth();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check API dependency readiness' })
  @ApiOkResponse({ description: 'PostgreSQL and Redis are ready.' })
  @ApiServiceUnavailableResponse({
    description: 'A required dependency is unavailable.',
  })
  async getReadiness() {
    try {
      return this.asResource(await this.healthService.getReadiness());
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Required service dependencies are unavailable.',
      });
    }
  }

  private asResource(health: HealthResponse) {
    return jsonApiResource('health-checks', health.service, {
      status: health.status,
    });
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    {
      provide: SERVICE_DEPENDENCIES,
      inject: [DATABASE_CLIENT, ConfigService],
      useFactory: (database: DatabaseReadinessClient, config: ConfigService) =>
        createServiceDependencies({
          database,
          redisUrl: config.getOrThrow<string>('REDIS_URL'),
        }),
    },
    HealthService,
  ],
})
export class HealthModule {}
