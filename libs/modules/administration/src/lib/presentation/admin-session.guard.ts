import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  ADMIN_IDENTITY_SERVICE,
  type AdminIdentityService,
} from '../application/admin-identity-ports';
import type { AuthenticatedAdmin } from '../application/administration-types';

export const adminSessionCookieName = 'edu_admin_session';

export interface AdminAuthenticatedRequest extends FastifyRequest {
  admin?: AuthenticatedAdmin;
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    @Inject(ADMIN_IDENTITY_SERVICE)
    private readonly identity: AdminIdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();
    const bearer = readSessionBearer(request);
    const administrator =
      bearer === undefined
        ? null
        : await this.identity.getAuthenticatedAdministrator(bearer);
    if (administrator === null) {
      throw new UnauthorizedException({
        code: 'ADMIN_AUTHENTICATION_REQUIRED',
        message: 'Administrator authentication is required.',
      });
    }
    request.admin = administrator;
    return true;
  }
}

export function readSessionBearer(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return undefined;
  const prefix = `${adminSessionCookieName}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return undefined;
}
