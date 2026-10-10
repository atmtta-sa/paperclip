export type BillingRoutePolicy = {
  policyId: string;
  policyVersion: number;
  policyDigest: string;
  provider: string;
  route: string;
  credentialPrincipalId: string;
  modelScope: string[];
  billingMode: "subscription_included";
  status: "active";
  validFrom: string;
  validUntil: string;
  maxRootChainProviderRequests: number;
};

export type ReservationBillingPolicy = Pick<
  BillingRoutePolicy,
  | "policyId"
  | "policyVersion"
  | "policyDigest"
  | "billingMode"
  | "credentialPrincipalId"
  | "maxRootChainProviderRequests"
>;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validHttpsRoute(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveReservationBillingPolicy(
  config: Record<string, unknown>,
  provider: string,
  model: string | null,
  now = new Date(),
): ReservationBillingPolicy | null {
  const raw = config.billingRoutePolicy;
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("billing_route_policy_invalid");
  }
  const policy = raw as Record<string, unknown>;
  const modelScope = policy.modelScope;
  const validFrom = Date.parse(nonEmpty(policy.validFrom) ? policy.validFrom : "");
  const validUntil = Date.parse(nonEmpty(policy.validUntil) ? policy.validUntil : "");
  const valid = nonEmpty(policy.policyId) && Number.isSafeInteger(policy.policyVersion) &&
    Number(policy.policyVersion) > 0 && nonEmpty(policy.policyDigest) &&
    /^[a-f0-9]{64}$/.test(policy.policyDigest) && policy.provider === provider &&
    validHttpsRoute(policy.route) && nonEmpty(policy.credentialPrincipalId) &&
    Array.isArray(modelScope) && modelScope.every(nonEmpty) && model !== null &&
    modelScope.includes(model) && policy.billingMode === "subscription_included" &&
    policy.status === "active" && Number.isFinite(validFrom) && Number.isFinite(validUntil) &&
    validFrom <= now.getTime() && now.getTime() < validUntil &&
    Number.isSafeInteger(policy.maxRootChainProviderRequests) &&
    Number(policy.maxRootChainProviderRequests) > 0;
  if (!valid) throw new Error("billing_route_policy_invalid");
  return {
    policyId: policy.policyId as string,
    policyVersion: policy.policyVersion as number,
    policyDigest: policy.policyDigest as string,
    billingMode: "subscription_included",
    credentialPrincipalId: policy.credentialPrincipalId as string,
    maxRootChainProviderRequests: policy.maxRootChainProviderRequests as number,
  };
}
