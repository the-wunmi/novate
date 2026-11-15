import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { AirwallexRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Engine,
  provisionMember,
  recordRailOpening,
  runCycle,
  runReconciliation,
  submitFact,
} from '../src/index.ts';
import { boot, eur, makeWorld, shutdown, type World, waitFor } from './harness.ts';

const envFile = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY } = process.env;
const live = Boolean(AIRWALLEX_CLIENT_ID && AIRWALLEX_API_KEY);

const address = {
  country_code: 'US',
  address_line1: '1 Main St',
  suburb: 'Austin',
  state: 'TX',
  postcode: '78701',
};

/** Everything Airwallex asks for before it will submit a US business, none of it in its docs as one list. */
const connectedAccount = (tag: string) => ({
  primary_contact: { email: `novate-${tag}@example.com` },
  account_details: {
    legal_entity_type: 'BUSINESS',
    business_details: {
      business_name: 'Sandbox Business',
      business_structure: 'CORPORATION',
      industry_category_code: 'ICCV3_0812XX',
      registration_address: address,
      business_address: address,
      business_identifiers: [{ country_code: 'US', number: '123456789', type: 'EIN' }],
      contact_number: '+15125550100',
      url: 'https://example.com',
      state_of_incorporation: 'TX',
      business_start_date: '2020-01-15',
      description_of_goods_or_services: 'Homeware wholesale',
      operating_country: ['US'],
      account_usage: {
        product_reference: ['RECEIVE_TRANSFERS'],
        estimated_monthly_revenue: { amount: '10000', currency: 'USD' },
      },
    },
    business_person_details: [
      {
        first_name: 'Sam',
        last_name: 'Tester',
        roles: ['BENEFICIAL_OWNER', 'AUTHORISED_PERSON'],
        nationality: 'US',
        date_of_birth: '1985-03-02',
        residential_address: address,
        tax_id: { number: '123456789', type: 'SSN' },
        email: `novate-person-${tag}@example.com`,
        phone_number: '+15125550101',
        identifications: {
          primary: {
            identification_type: 'PASSPORT',
            issuing_country_code: 'US',
            passport: { number: 'X1234567', effective_at: '2020-01-01', expire_at: '2030-01-01' },
          },
        },
      },
    ],
  },
  customer_agreements: {
    agreed_to_data_usage: true,
    agreed_to_terms_and_conditions: true,
    terms_and_conditions: {
      agreed_at: new Date().toISOString(),
      device_data: { ip_address: '203.0.113.5', user_agent: 'novate' },
      service_agreement_type: 'FULL',
    },
  },
});

/** Each member's money in its own Airwallex account: charged into the house, paid back out. */
describe.skipIf(!live)('net settlement with connected accounts (live)', () => {
  const rail = new AirwallexRail({
    clientId: AIRWALLEX_CLIENT_ID as string,
    apiKey: AIRWALLEX_API_KEY as string,
    webhookSecret: 'unused',
    custody: 'connected',
  });
  let engine: Engine;
  beforeAll(async () => {
    engine = await boot(rail);
  }, 120_000);
  afterAll(() => shutdown());

  const net: ProgramSpecInput = {
    ...presetInputs.netSettlement,
    overrides: [],
    settlement: {
      netting: 'multilateral',
      rail: 'airwallex',
      fundingWindow: '2m',
      confirmWithin: '1h',
    },
  };

  const open = async (w: World, memberId: string) => {
    const tag = randomUUID().slice(0, 8);
    await provisionMember(w.tenantId, memberId, {
      idempotencyKey: randomUUID(),
      rail: 'airwallex',
      countryCode: 'US',
      currency: 'EUR',
      transferMethods: ['LOCAL'],
      connectedAccount: connectedAccount(tag),
    });
    const row = await engine.db.query.members.findFirst({
      where: (m, { eq }) => eq(m.id, memberId),
    });
    return row?.railRefs as Record<string, string>;
  };

  it('collects from the buyer’s account and pays the seller’s, and the books match', async () => {
    const w = await makeWorld(rail as never, { net });
    const buyerRefs = await open(w, w.retailer);
    await open(w, w.supplier);
    // The buyer's own money, sent before novate opens its books on the rail.
    const seed = await rail.payout({
      idempotencyKey: randomUUID(),
      member: { id: w.retailer, railRefs: buyerRefs },
      currency: 'EUR',
      amount: eur('300'),
      reference: 'novate test: buyer money',
    } as never);
    await expect
      .poll(async () => (await rail.status(seed.externalRef, 'payout')).status, { timeout: 30_000 })
      .toBe('confirmed');
    await recordRailOpening(w.tenantId, 'airwallex');

    const deal = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 40,
      price: '5',
    });
    await waitFor(deal.id, ['awaiting_conditions'], 60_000);
    await submitFact(deal.id, w.asMember(w.retailer), {
      kind: 'acceptance',
      type: 'buyer',
      data: {},
    });
    await waitFor(deal.id, ['eligible'], 60_000);

    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(deal.id, ['settled'], 120_000);
    expect(await runReconciliation(w.tenantId, 'airwallex')).toMatchObject({ status: 'clean' });
  }, 300_000);
});
