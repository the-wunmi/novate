import { signMip20Contract } from '@metalntwx/metal-ts';
import {
  type Abi,
  createPublicClient,
  createWalletClient,
  type EIP1193RequestFn,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hash,
  type Hex,
  http,
  type Log,
  parseAbiItem,
  parseEventLogs,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type MetalClient,
  MetalRefusal,
  type MetalSettlement,
  type MetalSignedTransfer,
  type MetalTransfer,
} from './metal.ts';

/** The dollar token on Metal testnet, which also pays gas. */
export const METAL_USDZ_TESTNET = '0x000000000000000000000000000000000000B5d5';
const METAL_TESTNET_CHAIN_ID = 63825;

const MAX_GAS_PRICE = 1_000_000_000_000n;
/** Metal states no block range limit, so this stays modest and halves if a node refuses it. */
const MAX_LOG_RANGE = 2_000n;
/** Metal's documented admission errors. Any other failure leaves the transaction unknown. */
const ADMISSION_REFUSALS =
  /insufficient gas-token balance|gas_token .*not in|max_fee_per_gas .*exceeds cap|effective gas price .*below minimum|value must be zero|has no chain id|unsupported ethereum envelope/i;
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface MetalClientConfig {
  rpcUrl: string;
  privateKey: Hex;
  tokenAddress?: string;
  /** The chain the RPC must be on. Testnet unless given. */
  chainId?: number;
  /** Overrides the HTTP transport, for tests. */
  transport?: Transport;
}

/** Whether a receipt's logs hold any of these events. For callers with an ABI but no viem. */
export function hasEvent(logs: Log[], abi: Abi, eventName: string[]): boolean {
  return parseEventLogs({ abi, logs, eventName: eventName as never }).length > 0;
}

/** Talks to Metal through viem and Metal's SDK. Signing is local; the RPC never sees the key. */
export function createMetalClient(config: MetalClientConfig): MetalClient {
  const transport = config.transport ?? http(config.rpcUrl);
  const account = privateKeyToAccount(config.privateKey);
  const token = getAddress(config.tokenAddress ?? METAL_USDZ_TESTNET);
  const house = account.address;
  const reader = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });

  const expectedChain = config.chainId ?? METAL_TESTNET_CHAIN_ID;
  let onExpectedChain = false;
  /** A wrong endpoint must not be able to sign a payment or credit a deposit. */
  const checkChain = async () => {
    if (onExpectedChain) return;
    const chainId = await reader.getChainId();
    if (chainId !== expectedChain) {
      throw new Error(`Metal RPC is on chain ${chainId}, expected ${expectedChain}`);
    }
    onExpectedChain = true;
  };

  const finalizedBlock = async (): Promise<bigint> => {
    await checkChain();
    const request = reader.request as unknown as EIP1193RequestFn;
    const status = (await request({ method: 'consensus_status', params: [] } as never)) as {
      finalized: { number: number | string };
    };
    return BigInt(status.finalized.number);
  };

  const houseBalance = () =>
    reader.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [house],
    });

  /** Reads a range in bounded pieces, halving a piece the node refuses, down to a single block. */
  const transfersAddressed = async (
    args: { from: Hex } | { to: Hex },
    from: bigint,
    to: bigint,
  ) => {
    const logs = [];
    let span = MAX_LOG_RANGE;
    for (let start = from; start <= to; ) {
      const end = start + span - 1n < to ? start + span - 1n : to;
      try {
        logs.push(
          ...(await reader.getLogs({
            address: token,
            event: TRANSFER,
            args,
            fromBlock: start,
            toBlock: end,
          })),
        );
        start = end + 1n;
      } catch (err) {
        if (span === 1n) throw err;
        span /= 2n;
      }
    }
    return logs;
  };

  return withoutRpcUrl(config.rpcUrl, {
    houseAddress: house,
    tokenAddress: token,
    reader,

    // Metal's own fee recipe: the estimate plus 20% and 10,000 gas, at the quoted price.
    async signTransfer(to: string, value: bigint): Promise<MetalSignedTransfer> {
      await checkChain();
      const recipient = getAddress(to);
      const price = await reader.getGasPrice();
      if (price < 1n || price > MAX_GAS_PRICE) throw new Error(`Invalid gas price ${price}`);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, value],
      });
      // The estimate itself reverts when the money is not there.
      if ((await houseBalance()) < value)
        throw new MetalRefusal('House balance cannot cover the amount');
      const estimate = await reader.estimateGas({ account: house, to: token, data, value: 0n });
      const gasLimit = estimate + estimate / 5n + 10_000n;
      if ((await houseBalance()) < value + gasLimit * price) {
        throw new MetalRefusal('House balance cannot cover the amount plus maximum gas');
      }
      const nonce = await reader.getTransactionCount({ address: house, blockTag: 'pending' });
      const signed = await signMip20Contract({
        walletClient: wallet,
        publicClient: reader,
        abi: erc20Abi,
        address: token,
        functionName: 'transfer',
        args: [recipient, value],
        gasToken: token,
        gasLimit,
        gasFallback: gasLimit,
        maxFeePerGas: price,
      } as never);
      return { txHash: signed.txHash, raw: signed.raw, nonce };
    },

    async broadcast(raw: string): Promise<void> {
      try {
        await reader.sendRawTransaction({ serializedTransaction: raw as Hex });
      } catch (err) {
        const message = (err as Error).message;
        const refusal = ADMISSION_REFUSALS.exec(message);
        throw refusal ? new MetalRefusal(refusal[0]) : err;
      }
    },

    // A receipt alone is not settlement: its block has to be finalized and still canonical.
    async settlement(txHash: string): Promise<MetalSettlement> {
      const receipt = await reader
        .getTransactionReceipt({ hash: txHash as Hash })
        .catch(() => null);
      if (!receipt) return { state: 'unknown' };
      if (receipt.blockNumber > (await finalizedBlock())) return { state: 'pending' };
      const block = await reader.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) return { state: 'pending' };
      const transfers = parseEventLogs({
        abi: [TRANSFER],
        eventName: 'Transfer',
        logs: receipt.logs,
      })
        .filter((l) => l.address.toLowerCase() === token.toLowerCase())
        .map(
          (l): MetalTransfer => ({
            txHash,
            logIndex: l.logIndex,
            from: l.args.from,
            to: l.args.to,
            value: l.args.value,
          }),
        );
      return {
        state: 'final',
        success: receipt.status === 'success',
        transfers,
        feeBase: receipt.gasUsed * receipt.effectiveGasPrice,
      };
    },

    balance: houseBalance,

    finalizedBlock,

    async firstBlockAt(time: Date): Promise<bigint> {
      const target = BigInt(Math.floor(time.getTime() / 1000));
      let low = 0n;
      let high = await finalizedBlock();
      while (low < high) {
        const middle = (low + high) / 2n;
        const block = await reader.getBlock({ blockNumber: middle });
        if (block.timestamp < target) low = middle + 1n;
        else high = middle;
      }
      return low;
    },

    async transfers(from: bigint, to: bigint): Promise<MetalTransfer[]> {
      const [incoming, outgoing] = await Promise.all([
        transfersAddressed({ to: house }, from, to),
        transfersAddressed({ from: house }, from, to),
      ]);
      return [...incoming, ...outgoing].map((l) => ({
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        from: l.args.from as string,
        to: l.args.to as string,
        value: l.args.value as bigint,
      }));
    },
  });
}

/** The RPC address holds the API key, and viem repeats it in errors that reach logs and workflow records. */
function withoutRpcUrl<T extends object>(rpcUrl: string, client: T): T {
  return Object.fromEntries(
    Object.entries(client).map(([name, value]) => [
      name,
      typeof value !== 'function'
        ? value
        : async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (err) {
              if (err instanceof MetalRefusal) throw err;
              const { shortMessage, message } = err as { shortMessage?: string; message: string };
              throw new Error(
                `Metal RPC: ${(shortMessage ?? message).replaceAll(rpcUrl, '<rpc>')}`,
              );
            }
          },
    ]),
  ) as T;
}
