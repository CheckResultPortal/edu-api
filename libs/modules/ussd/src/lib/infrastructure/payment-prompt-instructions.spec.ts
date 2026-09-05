import { paymentPromptInstructions } from './payment-prompt-instructions';

describe('delayed prompt guidance', () => {
  it.each([
    ['13', '*170#'],
    ['6', '*110#'],
    ['7', '*500#'],
  ])('uses the wallet menu for %s', (channel, code) => {
    const guidance = paymentPromptInstructions(channel);
    expect(guidance).toContain(code);
    expect(guidance).not.toContain('sent');
    const message = `Approve the Mobile Money prompt for GHS 99999999.99 when it arrives.\nOrder code: 123456\n${guidance}\nDo not pay again.`;
    expect(message.length).toBeLessThanOrEqual(182);
  });
  it('does not guess a network for unknown channels', () => {
    expect(paymentPromptInstructions()).toContain('your MoMo menu');
  });
});
