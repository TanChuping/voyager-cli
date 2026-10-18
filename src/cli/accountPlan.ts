/**
 * The ChatGPT plan in CLI output. It is what the bridge's pages were told when
 * they last loaded, so it can lag behind a change, and it says nothing about
 * limits. JSON keeps ChatGPT's raw values and adds `tier`, read from them by
 * `accountTier` (never from the display name, which says "Pro" for $100 and $200).
 */
import { type AccountPlan, type AccountTier, accountTier } from '@voyager-crew/bridge-protocol';

export const ACCOUNT_NOT_OBSERVED = 'not-observed-yet';

/** The plan as JSON shows it: ChatGPT's raw values, plus the tier read from them. */
export type ShownAccount = AccountPlan & { readonly tier: AccountTier };

/** The `account` keys of every JSON result: the plan, or null and why. */
export function accountJson(account: AccountPlan | null | undefined): {
  readonly account: ShownAccount | null;
  readonly accountNote?: string;
} {
  return account
    ? { account: { ...account, tier: accountTier(account) } }
    : { account: null, accountNote: ACCOUNT_NOT_OBSERVED };
}

const TIER_NAMES: Readonly<Record<Exclude<AccountTier, 'unknown'>, string>> = {
  'pro-lite': 'Pro Lite ($100)',
  pro: 'Pro ($200)',
  'pro-max': 'Pro Max ($500)',
};

function day(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One short line, such as `plan: Pro ($200) (monthly, renews 9 Nov 2026)`. */
export function describeAccount(account: AccountPlan | null | undefined): string {
  if (!account) {
    return 'plan: not observed yet (it shows once a ChatGPT page loads with the bridge on)';
  }
  const tier = accountTier(account);
  // An unknown tier is named by its raw plan type, never by the shared display name.
  const name =
    tier === 'unknown'
      ? (account.planType ?? account.subscriptionPlan ?? account.planDisplayName ?? 'unknown')
      : TIER_NAMES[tier];
  const parts: string[] = [];
  if (account.structure && account.structure !== 'personal') parts.push(account.structure);
  if (account.billingPeriod) parts.push(account.billingPeriod);
  if (account.hasActiveSubscription === false) parts.push('no active subscription');
  const cancels = day(account.cancelsAt);
  const renews = day(account.renewsAt);
  if (cancels) parts.push(`cancels ${cancels}`);
  else if (renews) parts.push(`renews ${renews}`);
  if (account.scheduledPlanChange) parts.push(`changing to ${account.scheduledPlanChange}`);
  return `plan: ${name}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
}
