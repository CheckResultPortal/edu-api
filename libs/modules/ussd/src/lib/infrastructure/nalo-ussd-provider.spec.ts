import { UssdRequestError } from '../application/ussd-errors';
import { NaloUssdProvider } from './nalo-ussd-provider';

const configuration = { expectedUserId: 'NALOTest' };

describe('NaloUssdProvider', () => {
  const provider = new NaloUssdProvider(configuration);

  it('parses a trusted initial dial into a canonical request', () => {
    expect(
      provider.parseRequest({
        MSGTYPE: true,
        MSISDN: '233244123456',
        NETWORK: 'MTN',
        SESSIONID: 'nalo-session-1',
        USERDATA: '714*5#',
        USERID: 'NALOTest',
      }),
    ).toEqual({
      input: '714*5#',
      isNewSession: true,
      moolreChannel: '13',
      paymentPromptInstructions:
        'If delayed, dial *170# and check pending approvals.',
      msisdn: '233244123456',
      network: 'MTN',
      sessionId: 'nalo-session-1',
    });
  });

  it('parses continuation screens with false MSGTYPE', () => {
    expect(
      provider.parseRequest({
        MSGTYPE: false,
        MSISDN: '233244123456',
        SESSIONID: 'nalo-session-1',
        USERDATA: '2',
        USERID: 'NALOTest',
      }),
    ).toEqual({
      input: '2',
      paymentPromptInstructions:
        'If delayed, check pending approvals in your MoMo menu.',
      isNewSession: false,
      msisdn: '233244123456',
      sessionId: 'nalo-session-1',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
    [1, true],
    [0, false],
    ['1', true],
    ['0', false],
  ])('normalizes MSGTYPE %p', (msgType, expected) => {
    expect(
      provider.parseRequest({
        MSGTYPE: msgType,
        MSISDN: '233244123456',
        SESSIONID: 'nalo-session-1',
        USERDATA: '',
        USERID: 'NALOTest',
      }).isNewSession,
    ).toBe(expected);
  });

  it.each([
    [
      'wrong USERID',
      {
        MSGTYPE: true,
        MSISDN: '233244123456',
        SESSIONID: 'session',
        USERDATA: '1',
        USERID: 'OTHER',
      },
    ],
    [
      'missing USERID',
      {
        MSGTYPE: true,
        MSISDN: '233244123456',
        SESSIONID: 'session',
        USERDATA: '1',
      },
    ],
    [
      'invalid MSGTYPE',
      {
        MSGTYPE: 'not-a-message-type',
        MSISDN: '233244123456',
        SESSIONID: 'session',
        USERDATA: '1',
        USERID: 'NALOTest',
      },
    ],
    [
      'alphabetic MSISDN',
      {
        MSGTYPE: true,
        MSISDN: 'abc',
        SESSIONID: 'session',
        USERDATA: '1',
        USERID: 'NALOTest',
      },
    ],
    [
      'missing USERDATA',
      {
        MSGTYPE: true,
        MSISDN: '233244123456',
        SESSIONID: 'session',
        USERID: 'NALOTest',
      },
    ],
    ['non-object body', 'not-an-object'],
  ])('rejects %s', (_name, payload) => {
    expect(() => provider.parseRequest(payload)).toThrow(UssdRequestError);
  });

  it('renders the Nalo response envelope with the required USERID echo', () => {
    expect(
      provider.buildResponse(
        { input: '2', isNewSession: false, msisdn: '233244123456' },
        { continueSession: true, message: 'Pick one:\n1. WAEC' },
      ),
    ).toEqual({
      MSG: 'Pick one:\n1. WAEC',
      MSGTYPE: true,
      MSISDN: '233244123456',
      USERID: 'NALOTest',
      USERDATA: '2',
    });
  });
});
