import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { type AiriPayment, payWithAiri, readCredential } from '../src/airi-buyer.ts';

const CARD = '4111111111111111';
const offer = {
  amount: '5200',
  currency: 'USD',
  merchant: { name: 'novate', url: 'https://novate.example', country: 'US' },
};
const deal = {
  deal: {
    terms: {
      lines: [{ description: 'Mugs, blue: large', quantity: 2, unitPrice: '2500' }],
      incoterm: 'FOB',
    },
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A buyer against stand-ins for novate and airi-cli. `posts` answers each attempt to pay. */
function buyer(
  posts: (attempt: number) => Response | Promise<Response>,
  over: Partial<AiriPayment> = {},
) {
  const commands: string[][] = [];
  const approvals: string[] = [];
  let attempt = 0;
  const payment: AiriPayment = {
    apiUrl: 'http://novate.test',
    apiKey: 'k',
    dealId: 'd1',
    cardName: 'A Buyer',
    pollMs: 0,
    chooseCard: async (methods) => methods[1]?.paymentMethodId as string,
    askApproval: (_url, summary) => approvals.push(summary),
    fetch: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return posts(++attempt);
      return json(url.endsWith('/card') ? offer : deal);
    }) as typeof fetch,
    async cli(args) {
      commands.push(args);
      if (args[0] === 'auth') return { authenticated: true };
      if (args[0] === 'payment-methods') {
        return { items: [{ paymentMethodId: 'pm_1' }, { paymentMethodId: 'pm_2' }] };
      }
      if (args[1] === 'create') return { mandate_id: 'mdt_1', passkey_url: 'https://airi/p' };
      if (args[1] === 'get-credential') {
        const file = args[args.indexOf('--file') + 1] as string;
        await writeFile(
          file,
          JSON.stringify({ tokenPan: CARD, cvv: '123', tokenExpiration: '03/31' }),
        );
      }
      return {};
    },
    ...over,
  };
  const flag = (cmd: string, name: string) => {
    const found = commands.find((c) => c[1] === cmd) as string[];
    return found[found.indexOf(name) + 1];
  };
  return { payment, commands, approvals, flag, attempts: () => attempt };
}

describe('payWithAiri', () => {
  it('stops before any mandate if the buyer is not signed in to Airi', async () => {
    const b = buyer(() => json({ status: 'succeeded' }), {
      cli: async () => ({ authenticated: false }),
    });
    await expect(payWithAiri(b.payment)).rejects.toThrow('auth login');
  });

  it('lets the buyer choose the card and shows the real order', async () => {
    const b = buyer(() => json({ status: 'succeeded', paymentId: 'p1' }));
    await payWithAiri(b.payment);
    expect(b.flag('create', '--payment-method-id')).toBe('pm_2');
    expect(b.flag('create', '--item')).toBe(
      'name:2 x Mugs  blue  large,unit_price:52.00,quantity:1',
    );
    expect(b.approvals[0]).toContain('2 x Mugs, blue: large at USD 25.00');
    expect(b.approvals[0]).toContain('Delivery: FOB');
  });

  it('uses a card given explicitly without listing them', async () => {
    const b = buyer(() => json({ status: 'succeeded' }), { paymentMethodId: 'pm_9' });
    await payWithAiri(b.payment);
    expect(b.flag('create', '--payment-method-id')).toBe('pm_9');
    expect(b.commands.some((c) => c[0] === 'payment-methods')).toBe(false);
  });

  it('waits out a pending answer and reports the final one', async () => {
    const b = buyer((n) =>
      n < 3
        ? json({ status: 'pending', paymentId: 'p1' }, 202)
        : json({ status: 'succeeded', paymentId: 'p1' }),
    );
    expect((await payWithAiri(b.payment)).status).toBe('succeeded');
    expect(b.attempts()).toBe(3);
    expect(b.flag('result', '--result')).toBe('SUCCEEDED');
  });

  it('still reports when there is never a final answer, without claiming a failure', async () => {
    const b = buyer(() => json({ status: 'pending', paymentId: 'p1' }, 202));
    const paid = await payWithAiri(b.payment);
    expect(paid).toMatchObject({ status: 'pending', paymentId: 'p1' });
    expect(b.flag('result', '--result')).toBe('DECLINED');
    expect(b.flag('result', '--reason')).toContain('may still complete');
  });

  it('treats a lost connection as no answer, not as a failure', async () => {
    const b = buyer(() => {
      throw new Error('socket hang up');
    });
    expect((await payWithAiri(b.payment)).status).toBe('pending');
    expect(b.flag('result', '--reason')).toContain('may still complete');
  });

  it('reports a refusal after approval and does not ask again', async () => {
    const b = buyer(() => json({ message: 'The amount owed has changed' }, 409));
    await expect(payWithAiri(b.payment)).rejects.toThrow('amount owed has changed');
    expect(b.attempts()).toBe(1);
    expect(b.flag('result', '--result')).toBe('DECLINED');
    expect(b.flag('result', '--reason')).toContain('amount owed has changed');
  });

  it('reports a credential it could not read, naming fields and never values', async () => {
    const b = buyer(() => json({ status: 'succeeded' }));
    const cli = b.payment.cli;
    b.payment.cli = async (args) => {
      if (args[1] !== 'get-credential') return cli(args);
      b.commands.push(args);
      await writeFile(args[args.indexOf('--file') + 1] as string, JSON.stringify({ secret: CARD }));
      return {};
    };
    await expect(payWithAiri(b.payment)).rejects.toThrow('secret');
    expect(b.attempts()).toBe(0);
    expect(b.flag('result', '--reason')).not.toContain(CARD);
  });

  it('keeps a captured payment captured when telling Airi fails', async () => {
    const b = buyer(() => json({ status: 'succeeded', paymentId: 'p1' }));
    const cli = b.payment.cli;
    b.payment.cli = async (args) => {
      if (args[1] === 'result') throw new Error('airi is down');
      return cli(args);
    };
    expect(await payWithAiri(b.payment)).toMatchObject({
      status: 'succeeded',
      paymentId: 'p1',
      resultNotReported: 'airi is down',
    });
  });
});

describe('credential expiry', () => {
  it('reads the same month whatever offset the host wrote it in', () => {
    const at = (tokenExpiration: string) =>
      readCredential({ tokenPan: CARD, cvv: '123', tokenExpiration }, 'A');
    const utc = at('2031-03-31T23:30:00Z');
    expect(utc).toMatchObject({ expiryMonth: '03', expiryYear: '2031' });
    expect(at('2031-04-01T07:30:00+08:00')).toMatchObject(utc);
    expect(at('2031-03-31T18:30:00-05:00')).toMatchObject(utc);
  });
});
