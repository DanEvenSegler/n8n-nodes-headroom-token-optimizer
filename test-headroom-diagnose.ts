/**
 * Diagnostic script: directly call the Headroom /v1/compress API
 * to test config options and see raw server response.
 */

const HEADROOM_BASE_URL = 'http://192.168.178.38:8787';

const testText = `Headroom is an open-source AI context compression tool that dramatically reduces your token usage by shrinking bloated prompt inputs and conversational history. It works locally or via a proxy to save up to 95% on tokens without degrading model reasoning or accuracy.Because Headroom is a background utility that compresses your files, RAG results, and tool outputs on the fly, it does not require you to write custom prompt templates. Instead, you can use these agent-wrapping commands or configuration examples to set it up:1. Agent Wrapping (Zero Code Changes)Instead of typing custom prompts, you can wrap your existing coding agents via the command line to invoke Headroom automatically:bashheadroom wrap claude\nheadroom wrap cursor\nheadroom wrap aider\nVerwende Code mit Vorsicht.2. Local Proxy SetupIf you prefer to configure your existing LLM clients directly, you can run Headroom as a local proxy on your machine. You just point your OpenAI client (or similar) to the Headroom proxy port instead of the default API:pythonfrom openai import OpenAI\n\n# Point the base_url to the Headroom proxy\nclient = OpenAI(\n    base_url="http://localhost:8787/v1",\n    api_key="your-real-api-key-here" \n)\n\nresponse = client.chat.completions.create(\n    model="gpt-4o",\n    messages=[{"role": "user", "content": "Analyze this project file..."}]\n)\nVerwende Code mit Vorsicht.`;

async function testDirect() {
  // Test 1: With gpt-4o model and config
  console.log('=== TEST 1: gpt-4o + compress_user_messages=true + token_budget=300 ===');
  const body1 = {
    messages: [{ role: 'user', content: testText }],
    model: 'gpt-4o',
    token_budget: 300,
    config: {
      compress_user_messages: true,
      compress_system_messages: true,
    },
  };

  try {
    const resp1 = await fetch(`${HEADROOM_BASE_URL}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body1),
    });
    const data1: any = await resp1.json();
    console.log('Status:', resp1.status);
    console.log('tokens_before:', data1.tokens_before);
    console.log('tokens_after:', data1.tokens_after);
    console.log('tokens_saved:', data1.tokens_saved);
    console.log('compression_ratio:', data1.compression_ratio);
    console.log('transforms_applied:', data1.transforms_applied);
    console.log('compressed message (first 200 chars):', data1.messages?.[0]?.content?.substring(0, 200));
    console.log();
  } catch (e) {
    console.error('Error:', e);
  }

  // Test 2: WITHOUT config (default behavior)
  console.log('=== TEST 2: gpt-4o + NO config + token_budget=300 ===');
  const body2 = {
    messages: [{ role: 'user', content: testText }],
    model: 'gpt-4o',
    token_budget: 300,
  };

  try {
    const resp2 = await fetch(`${HEADROOM_BASE_URL}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body2),
    });
    const data2: any = await resp2.json();
    console.log('Status:', resp2.status);
    console.log('tokens_before:', data2.tokens_before);
    console.log('tokens_after:', data2.tokens_after);
    console.log('tokens_saved:', data2.tokens_saved);
    console.log('compression_ratio:', data2.compression_ratio);
    console.log('transforms_applied:', data2.transforms_applied);
    console.log();
  } catch (e) {
    console.error('Error:', e);
  }

  // Test 3: With system message role instead of user role
  console.log('=== TEST 3: gpt-4o + role=system + config + token_budget=300 ===');
  const body3 = {
    messages: [{ role: 'system', content: testText }],
    model: 'gpt-4o',
    token_budget: 300,
    config: {
      compress_user_messages: true,
      compress_system_messages: true,
    },
  };

  try {
    const resp3 = await fetch(`${HEADROOM_BASE_URL}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body3),
    });
    const data3: any = await resp3.json();
    console.log('Status:', resp3.status);
    console.log('tokens_before:', data3.tokens_before);
    console.log('tokens_after:', data3.tokens_after);
    console.log('tokens_saved:', data3.tokens_saved);
    console.log('compression_ratio:', data3.compression_ratio);
    console.log('transforms_applied:', data3.transforms_applied);
    console.log();
  } catch (e) {
    console.error('Error:', e);
  }

  // Test 4: With role=tool (tool outputs are always compressed)
  console.log('=== TEST 4: gpt-4o + role=tool + token_budget=300 ===');
  const body4 = {
    messages: [
      { role: 'user', content: 'Summarize this.' },
      { role: 'assistant', content: 'OK', tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', content: testText, tool_call_id: 't1' },
    ],
    model: 'gpt-4o',
    token_budget: 300,
  };

  try {
    const resp4 = await fetch(`${HEADROOM_BASE_URL}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body4),
    });
    const data4: any = await resp4.json();
    console.log('Status:', resp4.status);
    console.log('tokens_before:', data4.tokens_before);
    console.log('tokens_after:', data4.tokens_after);
    console.log('tokens_saved:', data4.tokens_saved);
    console.log('compression_ratio:', data4.compression_ratio);
    console.log('transforms_applied:', data4.transforms_applied);
    console.log('Messages:');
    for (const m of data4.messages ?? []) {
      console.log(`  [${m.role}] ${m.content?.substring(0, 150)}...`);
    }
    console.log();
  } catch (e) {
    console.error('Error:', e);
  }

  // Test 5: Without token_budget (always compress)
  console.log('=== TEST 5: gpt-4o + compress_user_messages=true + NO token_budget ===');
  const body5 = {
    messages: [{ role: 'user', content: testText }],
    model: 'gpt-4o',
    config: {
      compress_user_messages: true,
      compress_system_messages: true,
    },
  };

  try {
    const resp5 = await fetch(`${HEADROOM_BASE_URL}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body5),
    });
    const data5: any = await resp5.json();
    console.log('Status:', resp5.status);
    console.log('tokens_before:', data5.tokens_before);
    console.log('tokens_after:', data5.tokens_after);
    console.log('tokens_saved:', data5.tokens_saved);
    console.log('compression_ratio:', data5.compression_ratio);
    console.log('transforms_applied:', data5.transforms_applied);
    console.log();
  } catch (e) {
    console.error('Error:', e);
  }
}

testDirect();
