import { METAL_NETWORKS, type MetalNetworkName, registerMetalScheme } from '@metalntwx/metal-pay';
import { mandateBindingAbi, verifyMandatePayment } from '@metalntwx/metal-pay/mandates';
import { DomainError, sha256, toJson, toMajor } from '@novate/core';
import type * as engine from '@novate/engine';
import { hasEvent } from '@novate/rails';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { SettleError } from '@x402/core/types';

type Offer = engine.X402Offer;

/** What the route needs from x402. Small, so a test can stand in for the facilitator. */
export interface X402Gateway {
  require(resource: string, cents: bigint): Promise<PaymentRequired>;
  match(required: PaymentRequired, payment: PaymentPayload): PaymentRequirements | undefined;
  verify(payment: PaymentPayload, accepted: PaymentRequirements): Promise<VerifyResponse>;
  settle(payment: PaymentPayload, accepted: PaymentRequirements): Promise<SettleResponse>;
  /** What the chain proves about the mandate behind a finalized payment, if one was used. */
  prove?(
    transaction: string,
    accepted: PaymentRequirements,
    payer: string,
  ): Promise<Record<string, unknown> | undefined>;
}

/** Keep what the chain shows about who authorised this. A payment never fails because of it. */
function proveMandate(
  service: typeof engine,
  gateway: X402Gateway,
  offer: Offer,
  transaction: string,
  accepted: PaymentRequirements,
  payer: string,
) {
  if (!gateway.prove) return;
  void gateway
    .prove(transaction, accepted, payer)
    .then((proof) => (proof ? service.recordMandateProof(offer, proof) : undefined))
    .catch((err: unknown) => {
      const { shortMessage, message } = err as { shortMessage?: string; message: string };
      console.error(`No mandate proof for ${transaction}:`, shortMessage ?? message);
    });
}

const OFFER_TIMEOUT_SECONDS = 300;
const FINALITY_TRIES = 30;
const FINALITY_TRY_MS = 1_000;

/** These settle answers leave the outcome open: the transfer may be sent, or already was. */
const UNRESOLVED = new Set(['settlement_in_doubt', 'payment_in_flight', 'settlement_pending']);

/** Payment to the house account in Metal's dollar token, through Metal's facilitator. */
export function metalGateway(
  payTo: string,
  reader?: Parameters<typeof verifyMandatePayment>[0],
  name: MetalNetworkName = 'testnet',
): X402Gateway {
  const metal = METAL_NETWORKS[name];
  const facilitator = new HTTPFacilitatorClient({ url: metal.facilitatorUrl });
  const server = registerMetalScheme(new x402ResourceServer(facilitator), { networks: [name] });
  let ready: Promise<void> | undefined;
  const initialised = () => {
    ready ??= server.initialize().catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
    return ready;
  };
  return {
    async require(url, cents) {
      await initialised();
      const accepts = await server.buildPaymentRequirements({
        scheme: 'exact',
        payTo,
        price: toMajor(cents, 'USD'),
        network: metal.network,
        maxTimeoutSeconds: OFFER_TIMEOUT_SECONDS,
      });
      return server.createPaymentRequiredResponse(accepts, { url, mimeType: 'application/json' });
    },
    match: (required, payment) => server.findMatchingRequirements(required.accepts, payment),
    verify: (payment, accepted) => server.verifyPayment(payment, accepted),
    settle: (payment, accepted) => server.settlePayment(payment, accepted),
    prove: reader
      ? async (transaction, accepted, payer) => {
          const tx = transaction as `0x${string}`;
          const receipt = await reader.getTransactionReceipt({ hash: tx });
          if (!(await reader.getCode({ address: payer as `0x${string}` }))) return undefined;
          const outcomes = ['MandatePayment', 'MandateRefused'];
          if (!hasEvent(receipt.logs, mandateBindingAbi, outcomes)) return undefined;
          await untilFinal(reader, receipt.blockNumber);
          const proof = await verifyMandatePayment(reader, {
            tx,
            requirements: accepted as never,
          });
          if (!proof.ok || !proof.mandate) return undefined;
          return {
            transaction,
            mandate: proof.mandate,
            payments: proof.payments,
            steps: proof.steps,
          };
        }
      : undefined,
  };
}

/** A proof is only worth keeping about a settled block. Metal finalizes within moments. */
async function untilFinal(
  reader: Parameters<typeof verifyMandatePayment>[0],
  block: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < FINALITY_TRIES; attempt++) {
    const request = reader.request as unknown as (args: { method: string }) => Promise<unknown>;
    const status = (await request({ method: 'consensus_status' })) as {
      finalized: { number: number | string };
    };
    if (BigInt(status.finalized.number) >= block) return;
    await new Promise((resolve) => setTimeout(resolve, FINALITY_TRY_MS));
  }
  throw new Error(`block ${block} was not finalized in time`);
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(toJson(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function decoded(header: string): PaymentPayload {
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    throw new DomainError('invalid', 'PAYMENT-SIGNATURE could not be read');
  }
}

/** What identifies a payment however its header is encoded: who signed it and its nonce. */
function authorizationKey(payment: PaymentPayload): string | undefined {
  const authorization = (payment.payload as { authorization?: { from?: string; nonce?: string } })
    .authorization;
  if (!authorization?.from || !authorization.nonce) return undefined;
  const { from, nonce } = authorization;
  return sha256(`${payment.accepted.network}:${from.toLowerCase()}:${nonce.toLowerCase()}`);
}

/** A facilitator failure that reached no answer is in doubt, because the transfer may be out. */
async function settle(
  gateway: X402Gateway,
  payment: PaymentPayload,
  accepted: PaymentRequirements,
): Promise<SettleResponse> {
  try {
    return await gateway.settle(payment, accepted);
  } catch (err) {
    if (err instanceof SettleError) {
      return {
        success: false,
        errorReason: err.errorReason ?? 'settlement failed',
        transaction: err.transaction ?? '',
        network: accepted.network,
      };
    }
    console.error('x402 settle got no answer:', (err as Error).message);
    return {
      success: false,
      errorReason: 'settlement_in_doubt',
      transaction: '',
      network: accepted.network,
    };
  }
}

/** Tell the buyer the money may already be on its way, and how to find out. */
const stillOpen = (paymentId: string, transaction: string | null) =>
  respond(409, {
    error: 'An x402 payment for this deal is still in progress. Do not sign another.',
    paymentId,
    transaction: transaction || undefined,
  });

/**
 * Fund a deal over x402. Answers 402 with the price, and takes the signed payment on the retry.
 * Nothing is credited here: the deposit is credited once the chain has finalized it. A settle
 * that did not resolve keeps the payment open, so the buyer retries the same payment, never a new
 * one.
 */
export async function fundDealOverX402(
  service: typeof engine,
  gateway: X402Gateway,
  request: Request,
  offer: Offer,
): Promise<Response> {
  const { open } = offer;
  const required = await gateway.require(request.url, open?.amount ?? offer.amount);
  const refuse = async (reason: string, paymentId?: string, settled?: SettleResponse) => {
    await service.recordX402Refusal(offer, reason, paymentId, settled?.transaction || undefined);
    return respond(
      402,
      { error: reason },
      {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ ...required, error: reason }),
        ...(settled ? { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) } : {}),
      },
    );
  };
  const header = request.headers.get('payment-signature');
  if (!header) {
    if (open) return stillOpen(open.id, open.txHash);
    return respond(402, required, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) });
  }

  const payment = decoded(header);
  const key = authorizationKey(payment);
  if (!key) return refuse('payment is not a signed authorization');
  if (open && open.signatureHash !== key) return stillOpen(open.id, open.txHash);

  const accepted = gateway.match(required, payment);
  if (!accepted) return refuse('payment does not match what is owed');
  // Already sent and waiting for finality, so there is nothing to do again.
  if (open?.status === 'settled') {
    return respond(200, {
      paymentId: open.id,
      transaction: open.txHash,
      status: 'waiting_for_finality',
    });
  }

  let paymentId = open?.id;
  let payer = open?.payer;
  // A retry of a payment left open goes back to settle, which never sends twice.
  if (!paymentId || !payer) {
    const verified = await gateway.verify(payment, accepted);
    if (!verified.isValid || !verified.payer) {
      return refuse(verified.invalidReason ?? 'invalid payment');
    }
    paymentId = await service.openX402Payment(offer, verified.payer, key);
    payer = verified.payer;
  }

  const settled = await settle(gateway, payment, accepted);
  const paid =
    settled.success || (settled.errorReason === 'already_settled' && settled.transaction);
  if (!paid && UNRESOLVED.has(settled.errorReason ?? '')) {
    if (settled.transaction) {
      await service.markX402Settled(paymentId, settled.transaction, 'pending');
    }
    return respond(
      202,
      {
        paymentId,
        transaction: settled.transaction || undefined,
        status: 'in_doubt',
        retry: 'Send this same PAYMENT-SIGNATURE again. Do not sign a new payment.',
      },
      { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) },
    );
  }
  if (!paid) return refuse(settled.errorReason ?? 'settlement failed', paymentId, settled);

  await service.markX402Settled(paymentId, settled.transaction);
  proveMandate(service, gateway, offer, settled.transaction, accepted, payer);
  return respond(
    200,
    { paymentId, transaction: settled.transaction, status: 'waiting_for_finality' },
    { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) },
  );
}
