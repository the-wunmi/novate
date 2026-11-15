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
    funding: { mode: 'prefunded', timeout: '72h', currency: 'home', fxBufferBps: 300 },
    margin: {
      mode: 'scored',
      baseBps: 500,
      minBps: 200,
      maxBps: 2_000,
      adjustments: [
        {
          when: 'signals.history.seller.completedDeals >= 3.0 && signals.history.seller.onTimeRate < 0.9',
          addBps: 500,
          reason: 'the seller has missed deliveries',
        },
        {
          when: 'signals.history.seller.completedDeals >= 20.0 && signals.history.seller.onTimeRate >= 0.98',
          addBps: -300,
          reason: 'the seller has a long clean record',
        },
        {
          when: 'seller.homeCurrency != deal.currency && signals.fx.vol30d > 0.10',
          addBps: 200,
          reason: 'the seller is paid in another currency and 30-day FX volatility is above 10%',
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
        when: '(signals.history.seller.pricedDeals >= 3.0 && double(deal.unitPrice) < 0.5 * signals.history.seller.medianUnitPrice) || (has(deal.attributes.sellerListUnitPrice) && double(deal.unitPrice) < 0.5 * double(deal.attributes.sellerListUnitPrice))',
        action: 'freeze',
        reason: 'Price is less than half what this seller usually charges',
      },
    ],
    release: {
      condition: {
        all: [
          {
            type: 'documents',
            require: ['commercial_invoice', 'packing_list', 'bill_of_lading'],
            match: {
              shipmentDateLateDays: 3,
              requireFields: {
                commercial_invoice: ['amount', 'currency', 'quantity'],
                packing_list: ['quantity'],
                bill_of_lading: ['shipmentDate'],
              },
            },
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
    settlement: {
      netting: 'multilateral',
      rail: 'airwallex',
      timing: { mode: 'cycle', every: '1d' },
    },
    // The house is counterparty to both sides, so it pays even if a net debtor does not.
    risk: { bearer: 'principal' },
    decisions: {
      ceiling: { EUR: 5_000_000, GBP: 5_000_000, USD: 5_000_000 },
    },
    overrides: [
      {
        id: 'trusted_buyer_partial',
        when: 'signals.history.buyer.completedDeals >= 10.0 && signals.history.buyer.counterparties >= 3.0 && signals.history.buyer.defaults == 0.0',
        set: { funding: { mode: 'partial', bps: 2_000, currency: 'home', fxBufferBps: 300 } },
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
    settlement: { netting: 'multilateral', rail: 'airwallex' },
    decisions: { ceiling: { EUR: 5_000_000, GBP: 5_000_000, USD: 5_000_000 } },
    overrides: [
      {
        id: 'new_buyer_prefund',
        when: 'signals.history.buyer.completedDeals < 3.0',
        set: { funding: { mode: 'prefunded' } },
        reason: 'New buyers prefund until they build a record',
      },
    ],
  },

  /** Marketplace payouts with a reserve that follows each seller's record, in both directions. */
  marketplaceSettlement: {
    name: 'Marketplace settlement',
    description:
      'Sellers hold a risk-based reserve, proceeds net each cycle, agents earn their limits.',
    signals: ['history', 'fx'],
    funding: { mode: 'prefunded', timeout: '72h' },
    margin: {
      mode: 'scored',
      baseBps: 500,
      minBps: 100,
      maxBps: 2_000,
      adjustments: [
        {
          when: 'signals.history.seller.completedDeals >= 3.0 && signals.history.seller.defectRate > 0.05',
          addBps: 500,
          reason: 'the seller has a defect rate above 5%',
        },
        {
          when: 'signals.history.seller.completedDeals >= 20.0 && signals.history.seller.defectRate < 0.01',
          addBps: -300,
          reason: 'the seller has a long clean record',
        },
      ],
    },
    release: {
      condition: {
        all: [
          { any: [{ type: 'acceptance' }, { type: 'elapsed', after: '14d' }] },
          { type: 'no_dispute' },
        ],
      },
      onBlocked: 'escalate',
    },
    settlement: {
      netting: 'multilateral',
      rail: 'airwallex',
      timing: { mode: 'cycle', every: '1d' },
    },
    treasury: { mode: 'agent' },
    decisions: {
      ceiling: { EUR: 5_000_000, GBP: 5_000_000, USD: 5_000_000 },
      autonomy: { mode: 'earned' },
    },
  },

  /** Parties use novate to check a deal and its evidence, then settle somewhere else. */
  verificationOnly: {
    name: 'Verification only',
    description: 'Checks authority and evidence and records the result. Moves no money.',
    signals: ['history'],
    funding: { mode: 'net_then_fund' },
    release: {
      condition: {
        all: [
          {
            type: 'documents',
            require: ['commercial_invoice', 'bill_of_lading'],
            match: { shipmentDateLateDays: 3 },
          },
          { type: 'no_dispute' },
        ],
      },
      onBlocked: 'escalate',
    },
    settlement: { mode: 'verify_only', rail: 'airwallex' },
    decisions: { ceiling: { EUR: 5_000_000, GBP: 5_000_000, USD: 5_000_000 } },
  },

  /** Agents buying from each other: locked on agreement, paid the moment the buyer accepts. */
  realtimeAgentClearing: {
    name: 'Real-time agent clearing',
    description: 'Buyer agent locks funds up front and each deal settles alone on release.',
    signals: ['history'],
    funding: { mode: 'prefunded', timeout: '15m' },
    checks: [
      {
        id: 'amount_spike',
        when: 'signals.history.buyerAgent.dealCount >= 5.0 && double(deal.amount) > 10.0 * signals.history.buyerAgent.medianAmount',
        action: 'freeze',
        reason: 'Purchase is far larger than this agent usually makes',
      },
    ],
    release: {
      condition: { any: [{ type: 'acceptance' }, { type: 'elapsed', after: '1h' }] },
      recheckEvery: '1m',
      timeout: '2h',
      onTimeout: 'release',
      onBlocked: 'escalate',
    },
    settlement: {
      netting: 'gross',
      rail: 'airwallex',
      timing: { mode: 'immediate' },
      confirmWithin: '1h',
    },
    decisions: { ceiling: { EUR: 100_000, GBP: 100_000, USD: 100_000 } },
  },

  /** The house stands behind every released trade, secured by collateral and a mutual fund. */
  centralCounterparty: {
    name: 'Central counterparty',
    description: 'Members post portfolio margin. If one fails, its collateral and the fund pay.',
    signals: ['history', 'fx'],
    funding: { mode: 'net_then_fund' },
    portfolioMargin: { mode: 'required', baseBps: 500 },
    risk: { bearer: 'principal', defaultFund: true },
    release: {
      condition: { any: [{ type: 'acceptance' }, { type: 'elapsed', after: '14d' }] },
      onBlocked: 'escalate',
    },
    settlement: {
      netting: 'multilateral',
      rail: 'airwallex',
      timing: { mode: 'cycle', every: '1d' },
      fundingWindow: '4h',
    },
    decisions: { ceiling: { EUR: 5_000_000, GBP: 5_000_000, USD: 5_000_000 } },
  },
} satisfies Record<string, ProgramSpecInput>;

export const presets = Object.fromEntries(
  Object.entries(presetInputs).map(([k, v]) => [k, ProgramSpec.parse(v)]),
) as Record<keyof typeof presetInputs, ProgramSpec>;
