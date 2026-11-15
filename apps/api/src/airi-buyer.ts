import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Currency, toMajor } from '@novate/core';

/** Runs `airi-cli` with these arguments and returns what it printed, parsed as JSON. */
export type AiriCli = (args: string[]) => Promise<unknown>;

export interface AiriPayment {
  cli: AiriCli;
  /** Where novate is, and the buyer's key for it. */
  apiUrl: string;
  apiKey: string;
  dealId: string;
  /** Name on the card. Airi's credential carries none. */
  cardName: string;
  /** Which saved card to use. If not given, the buyer picks with `chooseCard`. */
  paymentMethodId?: string;
  chooseCard: (methods: AiriPaymentMethod[]) => Promise<string>;
  /** The buyer has to open this link and approve with a passkey. */
  askApproval: (url: string, summary: string) => void;
  /** How long to wait between asking novate for a final answer. */
  pollMs?: number;
  fetch?: typeof fetch;
}

export interface AiriPaymentMethod {
  paymentMethodId: string;
  [field: string]: unknown;
}

interface CardOffer {
  amount: string;
  currency: Currency;
  merchant: { name: string; url: string; country: string };
}

interface DealForApproval {
  deal: {
    terms: {
      lines: { description: string; quantity: number; unitPrice: string }[];
      incoterm?: string;
      shipmentDate?: string;
      deliveryDate?: string;
    };
  };
}

interface PaymentAnswer {
  status: string;
  reason?: string;
  paymentId?: string;
}

const CREDENTIAL_ATTEMPTS = 6;
/** Five minutes at the default pace: long enough for the monitor to settle a lost answer. */
const PAYMENT_CHECKS = 60;
const POLL_MS = 5_000;
const NO_FINAL_ANSWER = 'novate has no final answer yet, so this payment may still complete';

/** Every string in the credential by its field name, however it is nested. */
function flatten(value: unknown, out = new Map<string, string>()): Map<string, string> {
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object') flatten(item, out);
    else if (item !== null && item !== undefined) out.set(key.toLowerCase(), String(item));
  }
  return out;
}

function expiryOf(fields: Map<string, string>): { expiryMonth: string; expiryYear: string } {
  const month = fields.get('expirymonth') ?? fields.get('expmonth');
  const year = fields.get('expiryyear') ?? fields.get('expyear');
  if (month && year) {
    return {
      expiryMonth: month.padStart(2, '0'),
      expiryYear: year.length === 2 ? `20${year}` : year,
    };
  }
  const text = fields.get('tokenexpiration') ?? fields.get('expiry') ?? fields.get('expiration');
  // Airi writes timestamps with the host's offset, so only the instant is the same on every host.
  if (text && /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) {
    const at = new Date(text);
    return {
      expiryMonth: String(at.getUTCMonth() + 1).padStart(2, '0'),
      expiryYear: String(at.getUTCFullYear()),
    };
  }
  const yearFirst = text?.match(/^(\d{4})-(\d{2})/);
  if (yearFirst) return { expiryMonth: yearFirst[2] as string, expiryYear: yearFirst[1] as string };
  const monthFirst = text?.match(/^(\d{2})\/?(\d{2}|\d{4})$/);
  if (monthFirst) {
    const y = monthFirst[2] as string;
    return { expiryMonth: monthFirst[1] as string, expiryYear: y.length === 2 ? `20${y}` : y };
  }
  throw new Error('The Airi credential has no expiry novate can read');
}

const NUMBER_FIELDS = [
  'tokenizedpan',
  'tokenpan',
  'tokennumber',
  'token',
  'pan',
  'cardnumber',
  'number',
];

/**
 * Airi documents a credential as a tokenized PAN, expiry and CVV without naming the fields. On a
 * mismatch this reports the field names found, and never their values.
 */
export function readCredential(raw: unknown, name: string) {
  const fields = flatten(raw);
  const number = NUMBER_FIELDS.map((f) => fields.get(f)).find((v) => v && /^\d{12,19}$/.test(v));
  const cvc = fields.get('cvv') ?? fields.get('cvc') ?? fields.get('cvv2');
  if (!number || !cvc) {
    throw new Error(
      `Cannot read the Airi credential. Its fields: ${[...fields.keys()].join(', ')}`,
    );
  }
  return { number, cvc, name, ...expiryOf(fields) };
}

function paymentMethods(listed: unknown): AiriPaymentMethod[] {
  const list = Array.isArray(listed)
    ? listed
    : Object.values(listed as Record<string, unknown>).find(Array.isArray);
  if (!list?.length) throw new Error('No card is enabled for agent use in Airi');
  return list as AiriPaymentMethod[];
}

/** `--item` separates its fields with commas and colons, so a name can contain neither. */
const itemName = (lines: DealForApproval['deal']['terms']['lines']) =>
  lines
    .map((l) => `${l.quantity} x ${l.description}`)
    .join('; ')
    .replace(/[,:]/g, ' ');

/** The order as the buyer should see it. novate takes no shipping address, only delivery terms. */
function approvalSummary(offer: CardOffer, total: string, terms: DealForApproval['deal']['terms']) {
  const lines = terms.lines.map(
    (l) =>
      `${l.quantity} x ${l.description} at ${offer.currency} ${toMajor(BigInt(l.unitPrice), offer.currency)}`,
  );
  const delivery = [
    terms.incoterm,
    terms.shipmentDate && `ships ${terms.shipmentDate}`,
    terms.deliveryDate && `arrives ${terms.deliveryDate}`,
  ].filter(Boolean);
  return [
    `${offer.currency} ${total} to ${offer.merchant.name}, the amount still owed plus a card fee buffer`,
    `Items: ${lines.join('; ')}`,
    ...(delivery.length ? [`Delivery: ${delivery.join(', ')}`] : []),
  ].join('\n');
}

/** Waiting for the passkey can outlast one call, and a timeout there is not a failure. */
async function fetchCredential(cli: AiriCli, mandateId: string, file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await cli(['mandate', 'get-credential', '--mandate-id', mandateId, '--file', file]);
      return;
    } catch (err) {
      if (attempt >= CREDENTIAL_ATTEMPTS || !/timed out/i.test((err as Error).message)) throw err;
    }
  }
}

/** Novate's answer, undefined if it gave none. Only a clear refusal is thrown. */
async function askNovate(
  send: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<PaymentAnswer | undefined> {
  let res: Response;
  let answer: PaymentAnswer & { message?: string };
  try {
    res = await send(url, init);
    answer = (await res.json()) as typeof answer;
  } catch {
    return undefined;
  }
  if (answer.status) return answer;
  if (res.status >= 500) return undefined;
  throw new Error(`novate refused: ${answer.message}`);
}

/** Repeating this is safe: novate treats one mandate as one payment. Waits for a final answer. */
async function submitPayment(
  send: typeof fetch,
  url: string,
  init: RequestInit,
  pollMs: number,
): Promise<PaymentAnswer> {
  let last: PaymentAnswer | undefined;
  for (let check = 0; check < PAYMENT_CHECKS; check++) {
    if (check > 0) await sleep(pollMs);
    last = (await askNovate(send, url, init)) ?? last;
    if (last && last.status !== 'pending') return last;
  }
  return { ...last, status: 'pending', reason: NO_FINAL_ANSWER };
}

/**
 * Airi requires an outcome for every checkout, and offers no value for "not known yet", so that is
 * `DECLINED` with the reason saying so. Never throws: failing to tell Airi must not make a payment
 * look failed. Returns what went wrong, for the buyer to see.
 */
async function reportResult(
  cli: AiriCli,
  mandateId: string,
  paid: PaymentAnswer,
): Promise<string | undefined> {
  try {
    await cli([
      'mandate',
      'result',
      '--mandate-id',
      mandateId,
      '--result',
      paid.status === 'succeeded' ? 'SUCCEEDED' : 'DECLINED',
      ...(paid.reason ? ['--reason', paid.reason] : []),
    ]);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Fund a novate deal as the buyer: get a Visa Intelligent Commerce credential from Airi for exactly
 * what is owed, hand it to novate, and tell Airi how it went. The credential only ever exists in a
 * private temporary file, read here and never shown to a model or written to a log.
 */
export async function payWithAiri(o: AiriPayment) {
  const send = o.fetch ?? fetch;
  const headers = { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' };
  const read = async <T>(path: string): Promise<T> => {
    const res = await send(`${o.apiUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`novate refused: ${await res.text()}`);
    return (await res.json()) as T;
  };

  const session = (await o.cli(['auth', 'whoami'])) as { authenticated?: boolean };
  if (!session.authenticated) throw new Error('Not signed in to Airi. Run: airi-cli auth login');

  const url = `${o.apiUrl}/deals/${o.dealId}/card`;
  const offer = await read<CardOffer>(`/deals/${o.dealId}/card`);
  const { terms } = (await read<DealForApproval>(`/deals/${o.dealId}`)).deal;
  const total = toMajor(BigInt(offer.amount), offer.currency);

  const paymentMethodId =
    o.paymentMethodId ??
    (await o.chooseCard(paymentMethods(await o.cli(['payment-methods', 'list']))));
  const mandate = (await o.cli([
    'mandate',
    'create',
    '--source',
    'novate-buyer-agent',
    '--payment-method-id',
    paymentMethodId,
    '--merchant-name',
    offer.merchant.name,
    '--merchant-url',
    offer.merchant.url,
    '--merchant-country',
    offer.merchant.country,
    '--total-amount',
    total,
    '--currency',
    offer.currency,
    // One item, because the total is what is still owed and need not equal the sum of the lines.
    '--item',
    `name:${itemName(terms.lines)},unit_price:${total},quantity:1`,
    '--description',
    `Funding for deal ${o.dealId}`,
  ])) as { mandate_id: string; passkey_url: string };
  o.askApproval(mandate.passkey_url, approvalSummary(offer, total, terms));

  let retrieved = false;
  let paid: PaymentAnswer;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'novate-airi-'));
    let body: string;
    try {
      const file = join(dir, 'credential.json');
      await fetchCredential(o.cli, mandate.mandate_id, file);
      retrieved = true;
      body = JSON.stringify({
        mandateId: mandate.mandate_id,
        amount: offer.amount,
        card: readCredential(JSON.parse(await readFile(file, 'utf8')), o.cardName),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    paid = await submitPayment(send, url, { method: 'POST', headers, body }, o.pollMs ?? POLL_MS);
  } catch (err) {
    if (retrieved) {
      await reportResult(o.cli, mandate.mandate_id, {
        status: 'failed',
        reason: (err as Error).message,
      });
    }
    throw err;
  }

  const resultNotReported = await reportResult(o.cli, mandate.mandate_id, paid);
  return {
    ...paid,
    mandateId: mandate.mandate_id,
    ...(resultNotReported ? { resultNotReported } : {}),
  };
}
