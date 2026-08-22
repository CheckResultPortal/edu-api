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
        USERDATA: '714*5#',
        USERID: 'NALOTest',
      }),
    ).toEqual({
      input: '714*5#',
      isNewSession: true,
      msisdn: '233244123456',
    });
  });

  it('parses continuation screens with false MSGTYPE', () => {
    expect(
      provider.parseRequest({
        MSGTYPE: false,
        MSISDN: '233244123456',
        USERDATA: '2',
        USERID: 'NALOTest',
      }),
    ).toEqual({ input: '2', isNewSession: false, msisdn: '233244123456' });
  });

  it.each([
    ['wrong USERID', { MSGTYPE: true, MSISDN: '233244123456', USERDATA: '1', USERID: 'OTHER' }],
    ['missing USERID', { MSGTYPE: true, MSISDN: '233244123456', USERDATA: '1' }],
    ['non-boolean MSGTYPE', { MSGTYPE: 'true', MSISDN: '233244123456', USERDATA: '1', USERID: 'NALOTest' }],
    ['alphabetic MSISDN', { MSGTYPE: true, MSISDN: 'abc', USERDATA: '1', USERID: 'NALOTest' }],
    ['missing USERDATA', { MSGTYPE: true, MSISDN: '233244123456', USERID: 'NALOTest' }],
    ['non-object body', 'not-an-object'],
  ])('rejects %s', (_name, payload) => {
    expect(() => provider.parseRequest(payload)).toThrow(UssdRequestError);
  });

  it('renders the Nalo response envelope without extra fields', () => {
    expect(
      provider.buildResponse(
        { input: '2', isNewSession: false, msisdn: '233244123456' },
        { continueSession: true, message: 'Pick one:\n1. WAEC' },
      ),
    ).toEqual({
      MSG: 'Pick one:\n1. WAEC',
      MSGTYPE: true,
      MSISDN: '233244123456',
      USERDATA: '2',
    });
  });
});
