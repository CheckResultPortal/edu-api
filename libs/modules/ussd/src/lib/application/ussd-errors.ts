/**
 * USSD module errors. Messages are safe to show on a customer handset.
 */
export class UssdRequestError extends Error {
  constructor() {
    super('The USSD request could not be trusted.');
  }
}

export class UssdFlowError extends Error {
  constructor(message: string) {
    super(message);
  }
}
