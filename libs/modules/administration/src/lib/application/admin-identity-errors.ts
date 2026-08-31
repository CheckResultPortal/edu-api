export class AdminAuthenticationError extends Error {
  constructor() {
    super('The supplied administrator credentials are invalid.');
  }
}

export class AdminAuthorizationError extends Error {
  constructor() {
    super('The administrator is not permitted to perform this action.');
  }
}

export class AdminInvitationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AdminValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AdminPasswordResetError extends Error {
  constructor(message = 'Administrator password reset is not usable.') {
    super(message);
    this.name = 'AdminPasswordResetError';
  }
}
