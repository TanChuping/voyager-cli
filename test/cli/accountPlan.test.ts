import { describe, expect, it } from 'vitest';

import { accountJson, describeAccount } from '../../src/cli/accountPlan';

const RENEWS = { billingPeriod: 'monthly', renewsAt: '2026-11-09T10:00:00Z' };

describe('the plan line', () => {
  it('names each Pro tier by its plan strings, as ChatGPT shows "Pro" for $100 and $200', () => {
    const lite = {
      planType: 'prolite',
      subscriptionPlan: 'chatgptprolite',
      planDisplayName: 'Pro',
    };
    const pro = { planType: 'pro', subscriptionPlan: 'chatgptpro', planDisplayName: 'Pro' };
    expect(describeAccount({ ...lite, ...RENEWS })).toBe(
      'plan: Pro Lite ($100) (monthly, renews 9 Nov 2026)',
    );
    expect(describeAccount({ ...pro, ...RENEWS })).toBe(
      'plan: Pro ($200) (monthly, renews 9 Nov 2026)',
    );
    expect(describeAccount({ planType: 'promax' })).toBe('plan: Pro Max ($500)');
    expect(accountJson(lite).account?.tier).toBe('pro-lite');
  });

  it('shows an unknown tier by its raw plan type, keeping the raw values in JSON', () => {
    const plus = { planType: 'plus', subscriptionPlan: 'chatgptplus', planDisplayName: 'Plus' };
    expect(describeAccount({ ...plus, cancelsAt: '2026-12-01T00:00:00Z' })).toBe(
      'plan: plus (cancels 1 Dec 2026)',
    );
    expect(accountJson(plus)).toEqual({ account: { ...plus, tier: 'unknown' } });
    expect(accountJson(null)).toEqual({ account: null, accountNote: 'not-observed-yet' });
  });
});
