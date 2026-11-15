import { describe, expect, it } from 'vitest';
import {
  fxBuyAmount,
  fxSellAmount,
  mayAssertFact,
  mayDecideCase,
  mulDivUp,
  type Principal,
} from '../src/index.ts';

const RATE = 115_000_000n;
const deal = { buyerMemberId: 'b', sellerMemberId: 's' };
const p = (kind: Principal['kind'], memberId?: string): Principal => ({
  kind,
  id: 'x',
  tenantId: 't',
  memberId,
});

describe('fx arithmetic', () => {
  it('rounds the amount sold up, so the house is never short', () => {
    expect(fxSellAmount(388_000n, RATE, 'GBP', 'EUR')).toBe(337_392n);
  });
  it('rounds the amount bought down', () => {
    expect(fxBuyAmount(337_392n, RATE, 'GBP', 'EUR')).toBe(388_000n);
  });
  it('handles currencies with different minor units', () => {
    expect(fxBuyAmount(10_000n, 15_000_000_000n, 'EUR', 'JPY')).toBe(15_000n);
    expect(fxSellAmount(15_000n, 15_000_000_000n, 'EUR', 'JPY')).toBe(10_000n);
  });
  it('mulDivUp rounds up', () => {
    expect(mulDivUp(10n, 1n, 3n)).toBe(4n);
  });
});

describe('who may assert what', () => {
  it('a party cannot certify its own performance', () => {
    expect(mayAssertFact(p('member', 's'), deal, 'inspection')).toBe(false);
    expect(mayAssertFact(p('member', 's'), deal, 'delivery')).toBe(false);
    expect(mayAssertFact(p('member', 's'), deal, 'acceptance')).toBe(false);
  });
  it('only the buyer accepts', () => {
    expect(mayAssertFact(p('member', 'b'), deal, 'acceptance')).toBe(true);
    expect(mayAssertFact(p('platform'), deal, 'acceptance')).toBe(false);
  });
  it('nobody asserts a waiver', () => {
    for (const k of ['platform', 'house', 'arbiter'] as const) {
      expect(mayAssertFact(p(k), deal, 'waiver')).toBe(false);
    }
  });
  it('an outsider cannot raise a dispute', () => {
    expect(mayAssertFact(p('member', 'z'), deal, 'dispute')).toBe(false);
  });
});

describe('who may decide a case', () => {
  const buyer = p('member', 'b');
  const seller = p('member', 's');
  it('a seller cannot waive its own late shipment or confirm its deal', () => {
    expect(mayDecideCase(seller, deal, 'waive')).toBe(false);
    expect(mayDecideCase(seller, deal, 'release_full')).toBe(false);
    expect(mayDecideCase(seller, deal, 'confirm')).toBe(false);
  });
  it('a buyer cannot refund itself or draw margin', () => {
    expect(mayDecideCase(buyer, deal, 'refund')).toBe(false);
    expect(mayDecideCase(buyer, deal, 'draw_margin')).toBe(false);
    expect(mayDecideCase(buyer, deal, 'release_partial')).toBe(false);
  });
  it('a party may act against its own interest', () => {
    expect(mayDecideCase(buyer, deal, 'waive')).toBe(true);
    expect(mayDecideCase(seller, deal, 'refund')).toBe(true);
    expect(mayDecideCase(seller, deal, 'cancel')).toBe(true);
  });
  it('an outsider or an agent cannot decide', () => {
    expect(mayDecideCase(p('member', 'z'), deal, 'cancel')).toBe(false);
    expect(mayDecideCase(p('agent', 'b'), deal, 'cancel')).toBe(false);
  });
  it('independent reviewers can, and only operators decide non-deal cases', () => {
    expect(mayDecideCase(p('arbiter'), deal, 'refund')).toBe(true);
    expect(mayDecideCase(p('arbiter'), null, 'halt_settlement')).toBe(false);
    expect(mayDecideCase(p('platform'), null, 'halt_settlement')).toBe(true);
  });
});
