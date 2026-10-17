export interface CreateCheckoutParams {
  workspaceId: string;
  workspaceName: string;
  planId: string;
  planSlug: string;
  billingPeriod: 'monthly' | 'yearly';
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  customPriceUsd?: number;
  discountCode?: string;
}

export interface CheckoutSessionResult {
  checkoutUrl: string;
  sessionId?: string;
}

export interface BillingProvider {
  readonly name: string;
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSessionResult>;
  createCustomerPortalSession(params: {
    workspaceId: string;
    customerId?: string;
    returnUrl: string;
  }): Promise<{ portalUrl: string }>;
  cancelSubscription(params: { subscriptionId: string }): Promise<{ success: boolean; effectiveDate?: string }>;
  resumeSubscription(params: { subscriptionId: string }): Promise<{ success: boolean }>;
  updateSubscriptionPlan(params: {
    subscriptionId: string;
    variantId: string;
  }): Promise<{ success: boolean }>;
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;
}
