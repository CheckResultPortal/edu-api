import { dirname, resolve, sep } from 'node:path';

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { EmailAttachment } from './email-provider';

const pdfMake = require('pdfmake') as typeof import('pdfmake');

export interface VoucherDeliveryArtifactInput {
  readonly deliveryPublicId: string;
  readonly orderPublicReference: string;
  readonly pin: string;
  readonly productName: string;
  readonly resultCheckerUrl?: string;
  readonly serialNumber: string;
  readonly supportPhone: string;
}

let fontsConfigured = false;

export async function generateVoucherDeliveryArtifacts(
  input: VoucherDeliveryArtifactInput,
): Promise<readonly EmailAttachment[]> {
  configureFonts();
  const basename = `eduvoucher-${input.deliveryPublicId}`;
  const definition: TDocumentDefinitions = {
    info: {
      title: `${input.productName} voucher`,
      subject: 'Purchased result-checker voucher credentials',
      author: 'EduVoucher',
    },
    pageSize: 'A5',
    pageMargins: [36, 36, 36, 36],
    defaultStyle: { font: 'Roboto', color: '#172033', fontSize: 10 },
    content: [
      { text: 'EDUVOUCHER', color: '#19533e', bold: true, fontSize: 11 },
      {
        text: 'Your result-checker voucher',
        bold: true,
        fontSize: 20,
        margin: [0, 8, 0, 4],
      },
      {
        text: input.productName,
        color: '#516078',
        fontSize: 11,
        margin: [0, 0, 0, 20],
      },
      voucherField('Serial number', input.serialNumber),
      voucherField('PIN', input.pin),
      {
        text: `Order reference: ${input.orderPublicReference}`,
        color: '#516078',
        margin: [0, 18, 0, 4],
      },
      ...(input.resultCheckerUrl === undefined
        ? []
        : [
            {
              text: `Official result-checker site: ${input.resultCheckerUrl}`,
              link: input.resultCheckerUrl,
              color: '#19533e',
              margin: [0, 0, 0, 4] as [number, number, number, number],
            },
          ]),
      {
        text: `Need help? Call ${input.supportPhone}.`,
        bold: true,
        margin: [0, 18, 0, 4],
      },
      {
        text: 'Keep this document private. EduVoucher support will never ask you to post your PIN publicly.',
        color: '#516078',
        fontSize: 9,
      },
    ],
    footer: (currentPage, pageCount) => ({
      text: `EduVoucher - Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      color: '#7a879d',
      fontSize: 8,
      margin: [0, 12, 0, 0],
    }),
  };
  const pdf = await pdfMake.createPdf(definition).getBuffer();
  const csv = Buffer.from(
    `serialNumber,pin\r\n${csvField(input.serialNumber)},${csvField(input.pin)}\r\n`,
    'utf8',
  );
  return [
    {
      contentBase64: pdf.toString('base64'),
      contentType: 'application/pdf',
      filename: `${basename}.pdf`,
    },
    {
      contentBase64: csv.toString('base64'),
      contentType: 'text/csv; charset=utf-8',
      filename: `${basename}.csv`,
    },
  ];
}

function voucherField(label: string, value: string): Content {
  return {
    stack: [
      { text: label.toUpperCase(), color: '#516078', fontSize: 8 },
      {
        text: value,
        bold: true,
        fontSize: 16,
        margin: [0, 5, 0, 0] as [number, number, number, number],
      },
    ],
    margin: [0, 0, 0, 10] as [number, number, number, number],
  };
}

function csvField(value: string): string {
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function configureFonts(): void {
  if (fontsConfigured) return;
  const regular = require.resolve('pdfmake/fonts/Roboto/Roboto-Regular.ttf');
  const fontsDirectory = dirname(regular);
  const allowedPrefix = `${resolve(fontsDirectory)}${sep}`;
  pdfMake.addFonts({
    Roboto: {
      normal: regular,
      bold: require.resolve('pdfmake/fonts/Roboto/Roboto-Medium.ttf'),
      italics: require.resolve('pdfmake/fonts/Roboto/Roboto-Italic.ttf'),
      bolditalics: require.resolve(
        'pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf',
      ),
    },
  });
  pdfMake.setLocalAccessPolicy((path) =>
    `${resolve(path)}${path.endsWith(sep) ? sep : ''}`.startsWith(
      allowedPrefix,
    ),
  );
  pdfMake.setUrlAccessPolicy(() => false);
  fontsConfigured = true;
}
