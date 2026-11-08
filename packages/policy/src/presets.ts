import { ProgramSpec, type ProgramSpecInput } from './schema.ts';

/**
 * Starting templates. Tenants copy one, change what they need and publish it as a program version.
 * Nothing in the engine depends on these — they are data.
 */
export const presetInputs = {
  /** Letter-of-credit style: buyer prefunds, seller posts margin, docs + inspection release funds. */
  tradeAssurance: {
    name: 'Trade assurance',
    description: 'Buyer prefunds; funds release when documents match and goods pass inspection.',
    signals: ['history', 'fx'],
    funding: { mode: 'prefunded', timeout: '72h' },
    margin: {
      mode: 'scored',
      baseBps: 500,
      minBps: 200,
      maxBps: 2_000,
      adjustments: [
        {
          when: 'signals.history.seller.completedDeals >= 3.0 && signals.history.seller.onTimeRate < 0.9',
          addBps: 500,
          reason: 'seller has missed deliveries',
        },
        {
          when: 'signals.history.seller.completedDeals >= 20.0 && signals.history.seller.onTimeRate >= 0.98',
          addBps: -300,
          reason: 'seller has a long clean record',
        },
        {
          when: 'seller.homeCurrency != deal.currency && signals.fx.vol30d > 0.10',
          addBps: 200,
          reason: 'volatile settlement currency for the seller',
        },
      ],
    },
    checks: [
      {
        id: 'quantity_spike',
        when: 'signals.history.buyerAgent.dealCount >= 1.0 && double(deal.quantity) > 5.0 * signals.history.buyerAgent.medianQuantity',
        action: 'freeze',
        reason: 'Order is far larger than this agent usually places',
      },
      {
        id: 'price_below_list',
        when: 'has(deal.attributes.sellerListUnitPrice) && double(deal.unitPrice) < 0.5 * double(deal.attributes.sellerListUnitPrice)',
        action: 'freeze',
        reason: "Price is less than half the seller's own list price",
      },
    ],
    release: {
      condition: {
        all: [
          {
            type: 'documents',
            require: ['commercial_invoice', 'packing_list', 'bill_of_lading'],
            match: { shipmentDateLateDays: 3 },
          },
          { type: 'inspection', minPassRate: 0.8 },
          { type: 'no_dispute' },
        ],
      },
      amount: { type: 'pro_rata_inspection' },
      timeout: '60d',
      onTimeout: 'escalate',
      onBlocked: 'escalate',
    },
    settlement: { netting: 'multilateral', rail: 'mock' },
    overrides: [
      {
        id: 'trusted_buyer_partial',
        when: 'signals.history.buyer.completedDeals >= 10.0 && signals.history.buyer.defaults == 0.0',
        set: { funding: { mode: 'partial', bps: 2_000 } },
        reason: 'Buyer has a clean record: lock 20% up front',
      },
    ],
  },

  /** Marketplace payouts between known members: no prefunding, release on buyer acceptance or 14 days. */
  netSettlement: {
    name: 'Net settlement',
    description: 'Nothing locked up front; obligations net and settle each cycle.',
    signals: ['history'],
    funding: { mode: 'net_then_fund' },
    margin: { mode: 'none' },
    checks: [],
    release: {
      condition: { any: [{ type: 'acceptance' }, { type: 'elapsed', after: '14d' }] },
      amount: { type: 'full' },
      onBlocked: 'escalate',
    },
    settlement: { netting: 'multilateral', rail: 'mock' },
    overrides: [
      {
        id: 'new_buyer_prefund',
        when: 'signals.history.buyer.completedDeals < 3.0',
        set: { funding: { mode: 'prefunded' } },
        reason: 'New buyers prefund until they build a record',
      },
    ],
  },
} satisfies Record<string, ProgramSpecInput>;

export const presets = Object.fromEntries(
  Object.entries(presetInputs).map(([k, v]) => [k, ProgramSpec.parse(v)]),
) as Record<keyof typeof presetInputs, ProgramSpec>;
