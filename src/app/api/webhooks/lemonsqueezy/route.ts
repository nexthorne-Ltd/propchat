import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { getBillingProvider } from '@/lib/billing/lemonsqueezy';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-signature') || '';
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || '';

    const billingProvider = getBillingProvider();

    // Verify webhook signature if secret configured
    if (secret) {
      const isValid = billingProvider.verifyWebhookSignature(rawBody, signature, secret);
      if (!isValid) {
        console.warn('[Lemon Squeezy Webhook] Invalid signature rejected');
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload.meta?.event_name || '';
    const customData = payload.meta?.custom_data || {};
    const attributes = payload.data?.attributes || {};
    const subscriptionId = String(payload.data?.id || '');

    const adminClient = serviceClient();

    // Locate workspace by custom data or existing lemonsqueezy subscription id
    let workspaceId = customData.workspace_id;

    if (!workspaceId && subscriptionId) {
      const { data: sub } = await adminClient
        .from('workspace_subscriptions')
        .select('workspace_id')
        .eq('lemonsqueezy_subscription_id', subscriptionId)
        .maybeSingle();

      if (sub) {
        workspaceId = sub.workspace_id;
      }
    }

    if (!workspaceId) {
      console.warn(`[Lemon Squeezy Webhook] Workspace not found for event: ${eventName}, subId: ${subscriptionId}`);
      return NextResponse.json({ received: true, note: 'No workspace matched' });
    }

    const now = new Date();

    switch (eventName) {
      case 'subscription_created':
      case 'subscription_updated': {
        const statusMap: Record<string, string> = {
          on_trial: 'trialing',
          active: 'active',
          paused: 'suspended',
          past_due: 'past_due',
          unpaid: 'past_due',
          cancelled: 'canceled',
          expired: 'past_due',
        };

        const lsStatus = String(attributes.status || 'active').toLowerCase();
        const mappedStatus = statusMap[lsStatus] || 'active';

        const renewsAt = attributes.renews_at || attributes.ends_at;

        await adminClient
          .from('workspace_subscriptions')
          .update({
            status: mappedStatus,
            lemonsqueezy_subscription_id: subscriptionId,
            lemonsqueezy_customer_id: String(attributes.customer_id || ''),
            lemonsqueezy_variant_id: String(attributes.variant_id || ''),
            payment_method: 'lemonsqueezy',
            current_period_end: renewsAt ? new Date(renewsAt).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            failed_payment_count: 0,
            grace_period_ends_at: null,
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        break;
      }

      case 'subscription_payment_success': {
        const amountCents = attributes.total || attributes.subtotal || 0;
        const amountUsd = Number(amountCents) / 100;
        const invoiceId = `INV-LS-${payload.data?.id || Date.now()}`;

        // Insert invoice record
        await adminClient.from('workspace_invoices').insert({
          workspace_id: workspaceId,
          invoice_number: invoiceId,
          amount: amountUsd,
          currency: attributes.currency || 'USD',
          status: 'paid',
          billing_reason: 'subscription_cycle',
          payment_method: 'lemonsqueezy',
          payment_reference: subscriptionId,
          hosted_invoice_url: attributes.urls?.invoice_url || null,
          pdf_url: attributes.urls?.receipt_url || null,
          paid_at: now.toISOString(),
        });

        // Reset failed payments
        await adminClient
          .from('workspace_subscriptions')
          .update({
            status: 'active',
            failed_payment_count: 0,
            grace_period_ends_at: null,
            last_payment_failed_at: null,
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        break;
      }

      case 'subscription_payment_failed': {
        // Implement 7-day grace period
        const graceDays = 7;
        const graceEnd = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();

        const { data: currentSub } = await adminClient
          .from('workspace_subscriptions')
          .select('failed_payment_count')
          .eq('workspace_id', workspaceId)
          .maybeSingle();

        const newCount = (currentSub?.failed_payment_count || 0) + 1;

        await adminClient
          .from('workspace_subscriptions')
          .update({
            status: 'past_due',
            failed_payment_count: newCount,
            last_payment_failed_at: now.toISOString(),
            grace_period_ends_at: graceEnd,
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        // Record unpaid invoice
        await adminClient.from('workspace_invoices').insert({
          workspace_id: workspaceId,
          invoice_number: `INV-FAIL-${Date.now()}`,
          amount: Number(attributes.total || 0) / 100,
          currency: attributes.currency || 'USD',
          status: 'open',
          billing_reason: 'subscription_cycle',
          payment_method: 'lemonsqueezy',
          payment_reference: subscriptionId,
        });

        break;
      }

      case 'subscription_cancelled': {
        await adminClient
          .from('workspace_subscriptions')
          .update({
            status: 'canceled',
            canceled_at: now.toISOString(),
            cancellation_reason: attributes.cancelled_reason || 'Cancelled by customer',
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        break;
      }

      case 'subscription_resumed': {
        await adminClient
          .from('workspace_subscriptions')
          .update({
            status: 'active',
            canceled_at: null,
            cancellation_reason: null,
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        break;
      }

      default:
        console.log(`[Lemon Squeezy Webhook] Unhandled event: ${eventName}`);
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error('[Lemon Squeezy Webhook Handler Exception]:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
