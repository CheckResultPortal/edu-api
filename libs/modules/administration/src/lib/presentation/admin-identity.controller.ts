import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { jsonApiResource } from '@edu-api/http';

import {
  AdminAuthenticationError,
  AdminAuthorizationError,
  AdminInvitationError,
  AdminValidationError,
} from '../application/admin-identity-errors';
import {
  ADMIN_IDENTITY_SERVICE,
  type AdminIdentityService,
} from '../application/admin-identity-ports';
import type { AdminRole } from '../application/administration-types';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
  adminSessionCookieName,
  readSessionBearer,
} from './admin-session.guard';

const sessionCookieLifetimeSeconds = 12 * 60 * 60;
type RequestBodySchema = Extract<
  Parameters<typeof ApiBody>[0],
  { schema: unknown }
>['schema'];

const loginRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string' },
  },
};

const totpRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['challengeBearer', 'code'],
  properties: {
    challengeBearer: { type: 'string' },
    code: { type: 'string', pattern: '^\\d{6}$' },
  },
};

const invitationRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'role'],
  properties: {
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['SUPER_ADMIN', 'OPERATIONS_ADMIN'] },
  },
};

const acceptInvitationRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['invitationBearer', 'password'],
  properties: {
    invitationBearer: { type: 'string' },
    password: { type: 'string' },
  },
};

@Controller('admin')
@ApiTags('Administration identity')
@ApiProduces('application/vnd.api+json')
export class AdminIdentityController {
  constructor(
    @Inject(ADMIN_IDENTITY_SERVICE)
    private readonly identity: AdminIdentityService,
  ) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an administrator password and begin MFA' })
  @ApiOkResponse({ description: 'A short-lived MFA challenge was created.' })
  @ApiBody({ schema: loginRequestSchema })
  async beginLogin(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const input = parseLoginBody(body);
    try {
      const result = await this.identity.beginLogin(
        input,
        requestContext(request),
      );
      return jsonApiResource('admin-login-challenges', 'current', {
        challengeBearer: result.challengeBearer,
        purpose: result.purpose,
        ...(result.enrollmentSecret === undefined
          ? {}
          : { totpSecret: result.enrollmentSecret }),
      });
    } catch (error) {
      throw this.asException(error, true);
    }
  }

  @Post('auth/totp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify mandatory administrator TOTP MFA' })
  @ApiOkResponse({ description: 'A secure administrator session was created.' })
  @ApiBody({ schema: totpRequestSchema })
  async completeLogin(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseTotpBody(body);
    try {
      const result = await this.identity.completeLogin(
        input,
        requestContext(request),
      );
      setSessionCookie(reply, result.sessionBearer);
      return jsonApiResource('admin-sessions', 'current', {
        authenticated: true,
      });
    } catch (error) {
      throw this.asException(error, true);
    }
  }

  @Delete('auth/session')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(adminSessionCookieName)
  @ApiOperation({ summary: 'Revoke the current administrator session' })
  @ApiNoContentResponse({ description: 'The current session was revoked.' })
  async logout(
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const bearer = readSessionBearer(request);
    if (bearer !== undefined) {
      await this.identity.revokeSession(bearer, requestContext(request));
    }
    clearSessionCookie(reply);
  }

  @Post('invitations')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiCookieAuth(adminSessionCookieName)
  @ApiOperation({ summary: 'Invite an administrator as a Super Admin' })
  @ApiCreatedResponse({
    description: 'The invitation was queued for email delivery.',
  })
  @ApiBody({ schema: invitationRequestSchema })
  async inviteAdministrator(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const input = parseInviteBody(body);
    try {
      const result = await this.identity.inviteAdministrator(
        requiredAdmin(request),
        input,
        requestContext(request),
      );
      return jsonApiResource('admin-invitations', result.publicId, {
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Post('invitations/:publicId/resend')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiCookieAuth(adminSessionCookieName)
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiOperation({
    summary: 'Invalidate and resend an administrator invitation',
  })
  async resendAdministratorInvitation(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const result = await this.identity.resendAdministratorInvitation(
        requiredAdmin(request),
        publicId,
        requestContext(request),
      );
      return jsonApiResource('admin-invitations', result.publicId, {
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Delete('invitations/:publicId')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(adminSessionCookieName)
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiOperation({ summary: 'Revoke a pending administrator invitation' })
  async revokeAdministratorInvitation(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ): Promise<void> {
    try {
      await this.identity.revokeAdministratorInvitation(
        requiredAdmin(request),
        publicId,
        requestContext(request),
      );
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation and start TOTP enrollment' })
  @ApiBody({ schema: acceptInvitationRequestSchema })
  async acceptAdministratorInvitation(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const input = parseAcceptInvitationBody(body);
    try {
      const result = await this.identity.acceptAdministratorInvitation(
        input,
        requestContext(request),
      );
      return jsonApiResource('admin-totp-enrollments', 'current', {
        challengeBearer: result.enrollmentBearer,
        totpSecret: result.totpSecret,
      });
    } catch (error) {
      throw this.asException(error);
    }
  }

  private asException(error: unknown, genericAuthentication = false) {
    if (error instanceof AdminAuthenticationError) {
      return new UnauthorizedException({
        code: 'ADMIN_AUTHENTICATION_FAILED',
        message: 'The supplied administrator credentials are invalid.',
      });
    }
    if (error instanceof AdminAuthorizationError) {
      return new ForbiddenException({
        code: 'ADMIN_ACTION_FORBIDDEN',
        message: 'The administrator is not permitted to perform this action.',
      });
    }
    if (
      error instanceof AdminInvitationError ||
      error instanceof AdminValidationError
    ) {
      return new BadRequestException({
        code:
          error instanceof AdminInvitationError
            ? 'ADMIN_INVITATION_INVALID'
            : 'ADMIN_INPUT_INVALID',
        message: genericAuthentication
          ? 'The supplied administrator credentials are invalid.'
          : error.message,
      });
    }
    throw error;
  }
}

function parseLoginBody(body: unknown): { email: string; password: string } {
  const object = objectBody(body);
  return {
    email: stringField(object, 'email'),
    password: stringField(object, 'password'),
  };
}

function parseTotpBody(body: unknown): {
  challengeBearer: string;
  code: string;
} {
  const object = objectBody(body);
  return {
    challengeBearer: stringField(object, 'challengeBearer'),
    code: stringField(object, 'code'),
  };
}

function parseInviteBody(body: unknown): { email: string; role: AdminRole } {
  const object = objectBody(body);
  const role = stringField(object, 'role');
  if (role !== 'SUPER_ADMIN' && role !== 'OPERATIONS_ADMIN') {
    throw new BadRequestException({
      code: 'ADMIN_INPUT_INVALID',
      message: 'Administrator role is invalid.',
    });
  }
  return { email: stringField(object, 'email'), role };
}

function parseAcceptInvitationBody(body: unknown): {
  invitationBearer: string;
  password: string;
} {
  const object = objectBody(body);
  return {
    invitationBearer: stringField(object, 'invitationBearer'),
    password: stringField(object, 'password'),
  };
}

function objectBody(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException({
      code: 'ADMIN_INPUT_INVALID',
      message: 'Request body must be an object.',
    });
  }
  return body as Readonly<Record<string, unknown>>;
}

function stringField(
  body: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new BadRequestException({
      code: 'ADMIN_INPUT_INVALID',
      message: `${name} is required.`,
    });
  }
  return value;
}

function requiredAdmin(request: AdminAuthenticatedRequest) {
  if (request.admin === undefined) {
    throw new ForbiddenException({
      code: 'ADMIN_AUTHENTICATION_REQUIRED',
      message: 'Administrator authentication is required.',
    });
  }
  return request.admin;
}

function requestContext(request: AdminAuthenticatedRequest) {
  return { correlationId: request.id };
}

function setSessionCookie(reply: FastifyReply, bearer: string): void {
  reply.header(
    'set-cookie',
    `${adminSessionCookieName}=${bearer}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionCookieLifetimeSeconds}`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${adminSessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  );
}
