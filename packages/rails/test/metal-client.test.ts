import { custom, encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createMetalClient, METAL_USDZ_TESTNET, MetalRefusal } from '../src/index.ts';

const KEY = `0x${'11'.repeat(32)}` as const;
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const PAYEE = '0x00000000000000000000000000000000000000aa';
const FROM = '0x00000000000000000000000000000000000000bb';

const transferLog = (to: `0x${string}` = PAYEE) => ({
  address: METAL_USDZ_TESTNET,
  topics: encodeEventTopics({
    abi: [TRANSFER],
    eventName: 'Transfer',
    args: { from: FROM, to },
  }),
  data: encodeAbiParameters([{ type: 'uint256' }], [500n]),
  blockNumber: '0x5',
  blockHash: BLOCK_HASH,
  transactionHash: HASH,
  transactionIndex: '0x0',
  logIndex: '0x0',
  removed: false,
});

const receipt = (status: string) => ({
  transactionHash: HASH,
  transactionIndex: '0x0',
  blockHash: BLOCK_HASH,
  blockNumber: '0x5',
  from: FROM,
  to: METAL_USDZ_TESTNET,
  cumulativeGasUsed: '0x64',
  gasUsed: '0x64',
  effectiveGasPrice: '0x2',
  contractAddress: null,
  logs: [transferLog()],
  logsBloom: `0x${'00'.repeat(256)}`,
  status,
  type: '0x7f',
});

function client(state: {
  receipt?: unknown;
  finalized?: number;
  blockHash?: string;
  chainId?: string;
  balance?: bigint;
  sendError?: Error;
  maxLogRange?: bigint;
}) {
  const sent: string[] = [];
  const logRanges: [bigint, bigint][] = [];
  const handler = async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = (params as { fromBlock: string; toBlock: string }[])[0] as {
        fromBlock: string;
        toBlock: string;
      };
      const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
      if (to - from + 1n > (state.maxLogRange ?? 1_000_000n)) throw new Error('range too large');
      logRanges.push([from, to]);
      return from === 0n ? [transferLog(privateKeyToAccount(KEY).address)] : [];
    }
    if (method === 'eth_getBlockByNumber' && state.blockHash === undefined) {
      const number = BigInt((params as string[])[0] as string);
      return {
        hash: BLOCK_HASH,
        number: (params as string[])[0],
        parentHash: BLOCK_HASH,
        timestamp: `0x${(number * 10n).toString(16)}`,
        transactions: [],
        logsBloom: `0x${'00'.repeat(256)}`,
      };
    }
    switch (method) {
      case 'consensus_status':
        return { finalized: { number: state.finalized ?? 10, hash: 'x' } };
      case 'eth_getTransactionReceipt':
        return state.receipt ?? null;
      case 'eth_getBlockByNumber':
        return {
          hash: state.blockHash ?? BLOCK_HASH,
          number: '0x5',
          parentHash: BLOCK_HASH,
          timestamp: '0x1',
          transactions: [],
          logsBloom: `0x${'00'.repeat(256)}`,
        };
      case 'eth_sendRawTransaction':
        if (state.sendError) throw state.sendError;
        sent.push((params as string[])[0] as string);
        return HASH;
      case 'eth_call':
        return encodeAbiParameters([{ type: 'uint256' }], [state.balance ?? 10n ** 24n]);
      case 'eth_chainId':
        return state.chainId ?? '0xf951';
      case 'eth_gasPrice':
        return '0x2';
      case 'eth_estimateGas':
        return '0x186a0';
      case 'eth_getTransactionCount':
        return '0x7';
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const metal = createMetalClient({
    rpcUrl: 'http://unused',
    privateKey: KEY,
    transport: custom({ request: handler as never }),
  });
  return { metal, sent, logRanges };
}

describe('metal client', () => {
  it('treats a missing receipt as unknown', async () => {
    expect((await client({}).metal.settlement(HASH)).state).toBe('unknown');
  });

  it('is pending until the block is finalized', async () => {
    const { metal } = client({ receipt: receipt('0x1'), finalized: 4 });
    expect((await metal.settlement(HASH)).state).toBe('pending');
  });

  it('is pending if the block is no longer the canonical one', async () => {
    const { metal } = client({ receipt: receipt('0x1'), blockHash: `0x${'ee'.repeat(32)}` });
    expect((await metal.settlement(HASH)).state).toBe('pending');
  });

  it('reads transfers and the fee from a finalized receipt', async () => {
    const out = await client({ receipt: receipt('0x1') }).metal.settlement(HASH);
    expect(out).toMatchObject({ state: 'final', success: true, feeBase: 200n });
    if (out.state === 'final') expect(out.transfers[0]).toMatchObject({ value: 500n });
  });

  it('reports a revert', async () => {
    const out = await client({ receipt: receipt('0x0') }).metal.settlement(HASH);
    expect(out).toMatchObject({ state: 'final', success: false });
  });

  it('reads the finalized height from consensus status', async () => {
    expect(await client({ finalized: 77 }).metal.finalizedBlock()).toBe(77n);
  });

  it('sends exactly the bytes it is given', async () => {
    const { metal, sent } = client({});
    await metal.broadcast('0x7f01');
    expect(sent).toEqual(['0x7f01']);
  });

  it('signs a transfer locally and does not send it', async () => {
    const { metal, sent } = client({});
    const signed = await metal.signTransfer(PAYEE, 500n);
    expect(signed.nonce).toBe(7);
    expect(signed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.raw.startsWith('0x7f')).toBe(true);
    expect(sent).toEqual([]);
  });

  it('keeps the RPC address, which holds the API key, out of errors', async () => {
    const rpcUrl = 'https://rpc.example/secret-key';
    const metal = createMetalClient({
      rpcUrl,
      privateKey: KEY,
      transport: custom({
        request: async () => {
          throw new Error(`request to ${rpcUrl} failed`);
        },
      }),
    });
    const err = (await metal.balance().catch((e) => e)) as Error;
    expect(err.message).not.toContain('secret-key');
  });

  it('will not sign what the house cannot cover with gas, and signs nothing', async () => {
    const { metal, sent } = client({ balance: 500n });
    await expect(metal.signTransfer(PAYEE, 500n)).rejects.toBeInstanceOf(MetalRefusal);
    expect(sent).toEqual([]);
  });

  it('refuses to sign on the wrong chain', async () => {
    await expect(client({ chainId: '0x1' }).metal.signTransfer(PAYEE, 500n)).rejects.toThrow(
      'chain 1',
    );
    await expect(client({ chainId: '0x1' }).metal.finalizedBlock()).rejects.toThrow('chain 1');
  });

  it('reports a transaction the node refused as a refusal', async () => {
    const sendError = Object.assign(new Error('insufficient gas-token balance'), { code: -32000 });
    await expect(client({ sendError }).metal.broadcast('0x7f01')).rejects.toBeInstanceOf(
      MetalRefusal,
    );
  });

  it.each(['nonce too low', 'already known'])('does not treat "%s" as refused', async (message) => {
    const sendError = Object.assign(new Error(message), { code: -32000 });
    const err = await client({ sendError })
      .metal.broadcast('0x7f01')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MetalRefusal);
  });

  it('does not treat a lost reply as refused', async () => {
    const err = await client({ sendError: new Error('socket hang up') })
      .metal.broadcast('0x7f01')
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MetalRefusal);
  });

  it('reads logs in bounded ranges and halves one the node refuses', async () => {
    const { metal, logRanges } = client({ maxLogRange: 500n });
    const found = await metal.transfers(0n, 1_499n);
    expect(found).toHaveLength(1);
    expect(logRanges.every(([from, to]) => to - from + 1n <= 500n)).toBe(true);
    expect(logRanges.at(-1)?.[1]).toBe(1_499n);
  });

  it('finds the first block at a time', async () => {
    const { metal } = client({ finalized: 100 });
    expect(await metal.firstBlockAt(new Date(55_000))).toBe(6n);
  });

  it('never exposes the key', () => {
    expect(JSON.stringify(client({}).metal)).not.toContain('1111');
  });
});
