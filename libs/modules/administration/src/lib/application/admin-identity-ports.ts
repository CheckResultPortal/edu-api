import type {
  AdminAuthChallengePurpose,
  AdminRole,
  AuthenticatedAdmin,
  RequestContext,
} from './administration-types';

export const ADMIN_IDENTITY_SERVICE = Symbol('ADMIN_IDENTITY_SERVICE');

export interface AdminIdentityService {
  beginLogin(
    input: BeginAdminLoginInput,
    context: RequestContext,
  ): Promise<BeginAdminLoginResult>;
  completeLogin(
    input: CompleteAdminLoginInput,
    context: RequestContext,
  ): Promise<CompleteAdminLoginResult>;
  inviteAdministrator(
    actor: AuthenticatedAdmin,
    input: InviteAdministratorInput,
    context: RequestContext,
  ): Promise<AdminInvitationResult>;
  resendAdministratorInvitation(
    actor: AuthenticatedAdmin,
    invitationPublicId: string,
    context: RequestContext,
  ): Promise<AdminInvitationResult>;
  revokeAdministratorInvitation(
    actor: AuthenticatedAdmin,
    invitationPublicId: string,
    context: RequestContext,
  ): Promise<void>;
  acceptAdministratorInvitation(
    input: AcceptAdministratorInvitationInput,
    context: RequestContext,
  ): Promise<AcceptAdministratorInvitationResult>;
  getAuthenticatedAdministrator(
    sessionBearer: string,
  ): Promise<AuthenticatedAdmin | null>;
  revokeSession(sessionBearer: string, context: RequestContext): Promise<void>;
}

export interface BeginAdminLoginInput {
  readonly email: string;
  readonly password: string;
}

export interface BeginAdminLoginResult {
  readonly challengeBearer: string;
  readonly enrollmentSecret?: string;
  readonly purpose: AdminAuthChallengePurpose;
}

export interface CompleteAdminLoginInput {
  readonly challengeBearer: string;
  readonly code: string;
}

export interface CompleteAdminLoginResult {
  readonly sessionBearer: string;
}

export interface InviteAdministratorInput {
  readonly email: string;
  readonly role: AdminRole;
}

export interface AdminInvitationResult {
  readonly expiresAt: Date;
  readonly publicId: string;
}

export interface AcceptAdministratorInvitationInput {
  readonly invitationBearer: string;
  readonly password: string;
}

export interface AcceptAdministratorInvitationResult {
  readonly enrollmentBearer: string;
  readonly totpSecret: string;
}
