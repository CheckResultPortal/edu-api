/** Network-specific wallet menu guidance; channel values belong in this adapter. */
export function paymentPromptInstructions(channel?: string): string {
  const menu =
    channel === '13'
      ? '*170#'
      : channel === '6'
        ? '*110#'
        : channel === '7'
          ? '*500#'
          : null;
  return menu === null
    ? 'If delayed, check pending approvals in your MoMo menu.'
    : `If delayed, dial ${menu} and check pending approvals.`;
}
