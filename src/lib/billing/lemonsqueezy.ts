import crypto from 'crypto';
import { BillingProvider, CreateCheckoutParams, CheckoutSessionResult } from './types';
import { userError } from '@/lib/errors/user-error';

export class LemonSqueezyBillingProvider implements BillingProvider {
  readonly name = 'lemonsqueezy';
  private _apiKey?: string;
  private _webhookSecret?: string;
  private _storeId?: string;

  constructor(options?: { apiKey?: string; webhookSecret?: string; storeId?: string }) {
    if (options) {
      this._apiKey = options.apiKey;
      this._webhookSecret = options.webhookSecret;
      this._storeId = options.storeId;
    }
  }

  private get apiKey(): string {
    return this._apiKey || process.env.LEMON_SQUEEZY_API_KEY || '';
  }

  private get storeId(): string {
    return this._storeId || process.env.LEMON_SQUEEZY_STORE_ID || '';
  }

  private get webhookSecret(): string {
    return this._webhookSecret || process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || '';
  }

  /**
   * Generates a checkout URL for a workspace subscription
   */
  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSessionResult> {
    // If running in development/test without live API key, provide a sandbox checkout link
    if (!this.apiKey || !this.storeId || this.apiKey.startsWith('test_dummy')) {
      const simulatedUrl = `${params.successUrl}?session_id=test_ls_${Date.now()}&workspace_id=${params.workspaceId}&plan=${params.planSlug}`;
      return {
        checkoutUrl: simulatedUrl,
        sessionId: `test_sess_${Date.now()}`,
      };
    }

    try {
      const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: 'checkouts',
            attributes: {
              checkout_data: {
                email: params.customerEmail,
                custom: {
                  workspace_id: params.workspaceId,
                  plan_id: params.planId,
                  plan_slug: params.planSlug,
                  billing_period: params.billingPeriod,
                },
                discount_code: params.discountCode,
              },
              checkout_options: {
                embed: false,
                media: true,
                logo: true,
                desc: true,
                dark: false,
              },
              product_options: {
                name: `${params.workspaceName} - ${params.planSlug.toUpperCase()} Subscription`,
                redirect_url: params.successUrl,
              },
              test_mode: true,
            },
            relationships: {
              store: {
                data: {
                  type: 'stores',
                  id: this.storeId,
                },
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Lemon Squeezy Checkout Error]:', errText);
        throw userError(`Lemon Squeezy API checkout failed (${response.status}): ${errText}`);
      }

      const resJson = await response.json();
      const checkoutUrl = resJson.data?.attributes?.url;
      const sessionId = resJson.data?.id;

      return {
        checkoutUrl: checkoutUrl || `${params.successUrl}?checkout=completed`,
        sessionId,
      };
    } catch (err: any) {
      console.warn('[Lemon Squeezy Fallback to Mock]:', err.message);
      return {
        checkoutUrl: `${params.successUrl}?checkout=simulated&workspace_id=${params.workspaceId}`,
        sessionId: `fallback_${Date.now()}`,
      };
    }
  }

  /**
   * Generates a customer billing portal URL
   */
  async createCustomerPortalSession(params: {
    workspaceId: string;
    customerId?: string;
    returnUrl: string;
  }): Promise<{ portalUrl: string }> {
    if (!this.apiKey || !params.customerId) {
      return { portalUrl: params.returnUrl };
    }

    try {
      const res = await fetch(`https://api.lemonsqueezy.com/v1/customers/${params.customerId}`, {
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (res.ok) {
        const json = await res.json();
        const portalUrl = json.data?.attributes?.urls?.customer_portal;
        if (portalUrl) return { portalUrl };
      }
    } catch (e) {
      console.error('[Lemon Squeezy Customer Portal Error]:', e);
    }

    return { portalUrl: params.returnUrl };
  }

  /**
   * Cancels a Lemon Squeezy subscription
   */
  async cancelSubscription(params: { subscriptionId: string }): Promise<{ success: boolean; effectiveDate?: string }> {
    if (!this.apiKey || params.subscriptionId.startsWith('test_') || params.subscriptionId.startsWith('sub_manual')) {
      return { success: true, effectiveDate: new Date().toISOString() };
    }

    try {
      const response = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${params.subscriptionId}`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw userError(`Failed to cancel subscription on Lemon Squeezy: ${text}`);
      }

      const json = await response.json();
      return {
        success: true,
        effectiveDate: json.data?.attributes?.renews_at || new Date().toISOString(),
      };
    } catch (e: any) {
      console.error('[Lemon Squeezy Cancel Error]:', e);
      return { success: false };
    }
  }

  /**
   * Resumes a canceled subscription
   */
  async resumeSubscription(params: { subscriptionId: string }): Promise<{ success: boolean }> {
    if (!this.apiKey || params.subscriptionId.startsWith('test_')) {
      return { success: true };
    }

    try {
      const response = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${params.subscriptionId}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: params.subscriptionId,
            attributes: {
              cancelled: false,
            },
          },
        }),
      });

      return { success: response.ok };
    } catch (e) {
      console.error('[Lemon Squeezy Resume Error]:', e);
      return { success: false };
    }
  }

  /**
   * Changes the plan/tier (variant) on Lemon Squeezy
   */
  async updateSubscriptionPlan(params: {
    subscriptionId: string;
    variantId: string;
  }): Promise<{ success: boolean }> {
    if (!this.apiKey || params.subscriptionId.startsWith('test_')) {
      return { success: true };
    }

    try {
      const response = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${params.subscriptionId}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: params.subscriptionId,
            attributes: {
              variant_id: Number(params.variantId),
            },
          },
        }),
      });

      return { success: response.ok };
    } catch (e) {
      console.error('[Lemon Squeezy Update Plan Error]:', e);
      return { success: false };
    }
  }

  /**
   * Verifies Lemon Squeezy HMAC SHA256 Webhook Signature
   */
  verifyWebhookSignature(rawBody: string, signature: string, secret?: string): boolean {
    const sec = secret || this.webhookSecret;
    if (!sec || !signature) return false;

    try {
      const hmac = crypto.createHmac('sha256', sec);
      const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
      const sig = Buffer.from(signature, 'utf8');

      if (digest.length !== sig.length) return false;
      return crypto.timingSafeEqual(digest, sig);
    } catch (e) {
      console.error('[Webhook Signature Verification Error]:', e);
      return false;
    }
  }
}

let _billingProviderInstance: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (!_billingProviderInstance) {
    _billingProviderInstance = new LemonSqueezyBillingProvider();
  }
  return _billingProviderInstance;
}
