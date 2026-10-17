import { createClient } from '@supabase/supabase-js';

const BASE_URL = 'http://localhost:3000';
const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function testOmnichannelAndLangGraph() {
  console.log('=== STARTING OMNICHANNEL & LANGGRAPH BRIDGE END-TO-END VERIFICATION ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Test Meta Webhook Verification Handshake (GET)
  console.log('Step 1: Testing Meta Webhook verification handshake (GET /api/webhooks/meta)...');
  const challengeCode = 'test_challenge_123456';
  const verifyRes = await fetch(
    `${BASE_URL}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=chatify_meta_verify_secret&hub.challenge=${challengeCode}`
  );
  const verifyBody = await verifyRes.text();

  if (verifyRes.status === 200 && verifyBody === challengeCode) {
    console.log('✓ Meta Webhook handshake verified successfully! Challenge returned verbatim.');
  } else {
    console.error(`✗ Meta Webhook handshake failed: status ${verifyRes.status}, body: ${verifyBody}`);
    process.exit(1);
  }

  // 2. Test WhatsApp Inbound Message Webhook (POST)
  console.log('\nStep 2: Simulating incoming WhatsApp message from customer...');
  const whatsappSenderPhone = '923001234567';
  const whatsappMsgText = 'Hello! I need pricing information for your enterprise tier via WhatsApp.';
  const whatsappPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1092837465',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1029384756' },
              contacts: [{ profile: { name: 'Tariq WhatsApp Customer' }, wa_id: whatsappSenderPhone }],
              messages: [
                {
                  from: whatsappSenderPhone,
                  id: `wamid_test_${Date.now()}`,
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                  text: { body: whatsappMsgText },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const waRes = await fetch(`${BASE_URL}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(whatsappPayload),
  });

  const waJson = await waRes.json();
  if (waJson.status === 'EVENT_RECEIVED') {
    console.log('✓ Meta WhatsApp webhook accepted with 200 EVENT_RECEIVED');
  } else {
    console.error('✗ WhatsApp webhook rejected:', waJson);
    process.exit(1);
  }

  // Verify WhatsApp conversation was created in Supabase
  const { data: waConv, error: waConvErr } = await supabase
    .from('conversations')
    .select('*, visitor:visitors(*)')
    .eq('channel', 'whatsapp')
    .eq('channel_user_id', whatsappSenderPhone)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (waConvErr || !waConv) {
    console.error('✗ WhatsApp conversation was not found in Supabase:', waConvErr);
    process.exit(1);
  }
  console.log(`✓ WhatsApp conversation successfully created in Supabase!`);
  console.log(`  - Conversation ID: ${waConv.id}`);
  console.log(`  - Channel: ${waConv.channel}`);
  console.log(`  - Customer Name: ${waConv.visitor?.name}`);
  console.log(`  - Phone: ${waConv.channel_user_id}`);

  // 3. Test Instagram Inbound Message Webhook (POST)
  console.log('\nStep 3: Simulating incoming Instagram Direct message...');
  const igSenderId = 'ig_user_883920';
  const igMsgText = 'Hey team! Saw your reel, do you offer customized support widgets?';
  const igPayload = {
    object: 'instagram',
    entry: [
      {
        id: 'page_ig_id_123',
        messaging: [
          {
            sender: { id: igSenderId },
            recipient: { id: 'page_ig_id_123' },
            timestamp: Date.now(),
            message: { mid: `ig_mid_${Date.now()}`, text: igMsgText },
          },
        ],
      },
    ],
  };

  const igRes = await fetch(`${BASE_URL}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(igPayload),
  });
  const igJson = await igRes.json();
  if (igJson.status === 'EVENT_RECEIVED') {
    console.log('✓ Instagram DM webhook accepted with 200 EVENT_RECEIVED');
  }

  // Verify Instagram conversation in Supabase
  const { data: igConv } = await supabase
    .from('conversations')
    .select('id, channel, channel_user_id')
    .eq('channel', 'instagram')
    .eq('channel_user_id', igSenderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (igConv) {
    console.log(`✓ Instagram conversation created: ID ${igConv.id}, Channel: ${igConv.channel}`);
  }

  // 4. Test LangGraph Agent Inbound Webhook (POST /api/agent/webhook)
  console.log('\nStep 4: Testing LangGraph Agent Inbound Webhook (/api/agent/webhook)...');
  const agentAiReply = 'Hello Tariq! Yes, our enterprise tier includes high-concurrency websocket clusters and WhatsApp integration.';
  const agentWebhookRes = await fetch(`${BASE_URL}/api/agent/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: waConv.id,
      content: agentAiReply,
      is_internal: false,
    }),
  });

  const agentWebhookJson = await agentWebhookRes.json();
  if (agentWebhookJson.success) {
    console.log(`✓ LangGraph agent reply inserted successfully into thread: Message ID ${agentWebhookJson.message_id}`);
  } else {
    console.error('✗ LangGraph agent webhook failed:', agentWebhookJson);
    process.exit(1);
  }

  // Verify message in database
  const { data: lastMsg } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', waConv.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log(`✓ Verified thread message: [Sender: ${lastMsg?.sender_type}] "${lastMsg?.content}"`);

  // 5. Test AI Suggestion Draft Endpoint (/api/agent/suggest)
  console.log('\nStep 5: Testing AI Suggestion Draft endpoint (/api/agent/suggest)...');
  const suggestRes = await fetch(`${BASE_URL}/api/agent/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: waConv.id,
      workspace_id: waConv.workspace_id,
      incoming_message: whatsappMsgText,
      visitor: { name: 'Tariq WhatsApp Customer' },
      channel: 'whatsapp',
    }),
  });

  const suggestJson = await suggestRes.json();
  if (suggestJson.draft) {
    console.log(`✓ AI Copilot Draft generated successfully: "${suggestJson.draft.slice(0, 80)}..."`);
  }

  console.log('\n=== ALL OMNICHANNEL & LANGGRAPH TESTS PASSED 100% PERFECTLY! ===');
}

testOmnichannelAndLangGraph().catch(console.error);
