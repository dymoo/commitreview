import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, LLM } from '../src/llm.js';

const base = {
  model: 'test-model',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'k',
  requestTimeoutMs: 1000,
};

test('parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
});

test('parses JSON out of a fenced block', () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"findings":[]}\n```\nHope that helps.'), { findings: [] });
  assert.deepEqual(extractJson('```\n{"a":2}\n```'), { a: 2 });
});

test('parses JSON surrounded by prose', () => {
  assert.deepEqual(extractJson('Here is the result: {"a":1} — let me know.'), { a: 1 });
});

test('ignores reasoning-model think blocks', () => {
  assert.deepEqual(extractJson('<think>hmm {"trap": true} maybe</think>\n{"a":3}'), { a: 3 });
});

test('a fence ending inside a JSON string does not truncate the answer', () => {
  // The fence regex is lazy, so a ``` inside a finding body ends the capture
  // early. Recovering from that capture would produce a plausible, wrong object.
  const reply = '```json\n{"summary":"ok","findings":[{"title":"A","body":"use ```js x ```"},{"title":"B"}]}\n```';
  const parsed = extractJson(reply);
  assert.equal(parsed.findings.length, 2, 'the second finding must not be silently dropped');
  assert.equal(parsed.findings[0].body, 'use ```js x ```');
});

test('a bracket in the preamble is not mistaken for the answer', () => {
  // Anchoring on the first bracket returned `{}` or `[0]` as the whole review.
  assert.deepEqual(extractJson('The empty object {} case is odd. Review:\n{"findings":[{"title":"real"}]}'), {
    findings: [{ title: 'real' }],
  });
  assert.deepEqual(extractJson('See config[0] handling.\n{"findings":[{"title":"real"}]}'), {
    findings: [{ title: 'real' }],
  });
});

test('a truncated answer is recovered even behind a decoy bracket', () => {
  const parsed = extractJson('The {} case.\n{"findings":[{"title":"leak"},{"title":"race"');
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[1].title, 'race');
});

test('recovers output truncated by a token limit', () => {
  const truncated = '{"findings":[{"title":"leak","severity":"high"},{"title":"race"';
  const parsed = extractJson(truncated);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].title, 'leak');
});

test('tolerates trailing commas', () => {
  assert.deepEqual(extractJson('{"a":[1,2,],}'), { a: [1, 2] });
});

test('returns null when there is no JSON at all', () => {
  assert.equal(extractJson('I could not review this.'), null);
  assert.equal(extractJson(''), null);
});

test('request body leaves completion length to the provider and model', () => {
  const llm = new LLM(base);
  const body = llm.buildBody([{ role: 'user', content: 'hi' }]);
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.provider, undefined);
});

test('sends configured reasoning effort and never adapts it away', () => {
  const llm = new LLM({ ...base, reasoningEffort: 'xhigh' });
  assert.equal(llm.buildBody([]).reasoning_effort, 'xhigh');
  assert.equal(llm.adapt('reasoning_effort is unsupported'), false);
  assert.equal(llm.buildBody([]).reasoning_effort, 'xhigh');
});

test('an explicitly configured reasoning effort rejects endpoint parameter errors', async () => {
  for (const status of [400, 404]) {
    const requests = [];
    const llm = new LLM(
      { ...base, reasoningEffort: 'high' },
      {
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init.body)));
          return new Response('reasoning_effort is unsupported', { status });
        },
      },
    );

    await assert.rejects(
      () => llm.send([{ role: 'user', content: 'review this' }]),
      /explicitly configured reasoning_effort.*will not retry without it/i,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, 'high');
  }
});

test('generic explicit-effort parameter rejections stay fatal after compatibility retries', async () => {
  for (const status of [400, 404, 422]) {
    const requests = [];
    const llm = new LLM(
      { ...base, reasoningEffort: 'high' },
      {
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init.body)));
          return new Response('Invalid request: unsupported parameter', { status });
        },
      },
    );
    await assert.rejects(() => llm.send([{ role: 'user', content: 'review this' }]), {
      explicitEffortRequestRejected: true,
    });
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.reasoning_effort === 'high'));
  }
});

test('OpenRouter requests deny provider data collection and require ZDR', () => {
  const llm = new LLM({ ...base, baseUrl: 'https://openrouter.ai/api/v1' });
  const expectedPolicy = {
    data_collection: 'deny',
    zdr: true,
    require_parameters: true,
  };
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];

  assert.deepEqual(llm.buildBody([{ role: 'user', content: 'review this' }]).provider, expectedPolicy);
  assert.deepEqual(llm.buildBody([], { schema: { type: 'object' } }).provider, expectedPolicy);
  assert.deepEqual(llm.buildBody([], { tools }).provider, expectedPolicy);
  const explicit = new LLM({ ...base, baseUrl: 'https://openrouter.ai/api/v1', reasoningEffort: 'high' });
  assert.equal(explicit.buildBody([]).reasoning_effort, 'high');
  assert.deepEqual(explicit.buildBody([]).provider, expectedPolicy);
});

test('OpenRouter requests identify Shipyard without attributing other compatible endpoints', async () => {
  const headers = [];
  const runtime = {
    fetch: async (_url, init) => {
      headers.push(init.headers);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  };

  await new LLM(base, runtime).send([{ role: 'user', content: 'review this' }]);
  await new LLM({ ...base, baseUrl: 'https://openrouter.ai/api/v1' }, runtime).send([
    { role: 'user', content: 'review this' },
  ]);

  assert.equal(headers[0]['HTTP-Referer'], undefined);
  assert.equal(headers[0]['X-OpenRouter-Title'], undefined);
  assert.equal(headers[1]['HTTP-Referer'], 'https://github.com/dymoo/shipyard');
  assert.equal(headers[1]['X-OpenRouter-Title'], 'Shipyard');
});

test('OpenRouter uses the Actions run as a stable prompt-cache session', () => {
  const llm = new LLM({ ...base, baseUrl: 'https://openrouter.ai/api/v1' }, { env: { GITHUB_RUN_ID: 'review-123' } });
  assert.equal(llm.buildBody([]).session_id, 'shipyard-review-123');
  assert.equal(new LLM(base, { env: { GITHUB_RUN_ID: 'review-123' } }).buildBody([]).session_id, undefined);
});

test('records provider prompt-cache usage separately from total usage', async () => {
  const llm = new LLM(base, {
    fetch: async () =>
      Response.json({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
        },
      }),
  });

  await llm.send([{ role: 'user', content: 'review this' }]);

  assert.deepEqual(llm.usage, { prompt: 1000, completion: 50, cached: 900, cacheWrite: 100, requests: 1 });
});

test('OpenRouter parameter adaptation never strips the provider privacy policy', async () => {
  const requests = [];
  const llm = new LLM(
    { ...base, baseUrl: 'https://openrouter.ai/api/v1' },
    {
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1) {
          return new Response('Unsupported parameter: response_format', { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      },
    },
  );

  await llm.send([{ role: 'user', content: 'review this' }]);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.provider, {
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
  }
});

test('a timed-out logical request is not duplicated', async () => {
  let now = 0;
  let requests = 0;
  const timeout = new Error('request timed out');
  timeout.name = 'TimeoutError';
  const llm = new LLM(
    { ...base, requestTimeoutMs: 100 },
    {
      fetch: async () => {
        requests++;
        now = 100;
        throw timeout;
      },
      now: () => now,
      sleep: async () => assert.fail('a timed-out request must not sleep or retry'),
      timeoutSignal: () => new AbortController().signal,
    },
  );

  await assert.rejects(() => llm.send([{ role: 'user', content: 'hi' }]), /100ms logical deadline/);
  assert.equal(requests, 1);
});

test('a transient network failure retries within the shared deadline', async () => {
  let now = 0;
  let requests = 0;
  const timeoutBudgets = [];
  const llm = new LLM(
    { ...base, requestTimeoutMs: 10_000 },
    {
      fetch: async () => {
        requests++;
        if (requests === 1) throw new Error('connection reset');
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      timeoutSignal: (remainingMs) => {
        timeoutBudgets.push(remainingMs);
        return new AbortController().signal;
      },
    },
  );

  assert.deepEqual(await llm.send([{ role: 'user', content: 'hi' }]), {
    message: { content: 'ok' },
  });
  assert.equal(requests, 2);
  assert.ok(now > 0 && now < 10_000);
  assert.equal(timeoutBudgets.length, 2);
  assert.equal(timeoutBudgets[0], 10_000);
  assert.ok(timeoutBudgets[1] < timeoutBudgets[0]);
});

test('response decoding must finish inside the shared deadline', async () => {
  let now = 0;
  const llm = new LLM(
    { ...base, requestTimeoutMs: 100 },
    {
      fetch: async () => ({
        ok: true,
        json: async () => {
          now = 100;
          return { choices: [{ message: { content: 'too late' } }] };
        },
      }),
      now: () => now,
      timeoutSignal: () => new AbortController().signal,
    },
  );

  await assert.rejects(() => llm.send([{ role: 'user', content: 'hi' }]), /100ms logical deadline/);
});

test('a retry delay that exceeds the shared deadline fails closed', async () => {
  let now = 0;
  let requests = 0;
  const llm = new LLM(
    { ...base, requestTimeoutMs: 100 },
    {
      fetch: async () => {
        requests++;
        now = 99;
        return new Response('busy', { status: 503 });
      },
      now: () => now,
      sleep: async () => assert.fail('the retry cannot fit inside the deadline'),
      timeoutSignal: () => new AbortController().signal,
    },
  );

  await assert.rejects(() => llm.send([{ role: 'user', content: 'hi' }]), /100ms logical deadline/);
  assert.equal(requests, 1);
});

test('sends a json schema as response_format when a schema is passed', () => {
  const llm = new LLM(base);
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const body = llm.buildBody([], { schema, schemaName: 'thing' });
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'thing', strict: true, schema } });
});

test('a call without a schema still uses plain json_object mode', () => {
  const llm = new LLM(base);
  assert.deepEqual(llm.buildBody([]).response_format, { type: 'json_object' });
});

test('json_schema degrades to plain json_object before prompt-only', () => {
  const llm = new LLM(base);
  const schema = { type: 'object', properties: {}, required: [] };
  assert.equal(llm.adapt('This model does not support json_schema response_format'), true);
  // Still asks for JSON, just not the schema-constrained kind.
  assert.deepEqual(llm.buildBody([], { schema }).response_format, { type: 'json_object' });
  // A subsequent json_object rejection is what finally drops to prompt-only.
  assert.equal(llm.adapt('Unsupported parameter: response_format'), true);
  assert.equal(llm.buildBody([], { schema }).response_format, undefined);
});

test('drops response_format when the endpoint rejects it', () => {
  const llm = new LLM(base);
  assert.equal(llm.adapt('Unsupported parameter: response_format'), true);
  assert.equal(llm.buildBody([]).response_format, undefined);
});

test('an endpoint that rejects tool calling is a hard error, not a degrade', async () => {
  const llm = new LLM(base);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'this model does not support tools' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  try {
    await assert.rejects(
      () =>
        llm.send([{ role: 'user', content: 'hi' }], {
          tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
        }),
      (/** @type {any} */ err) => err.toolsUnsupported === true && /tool calling/i.test(err.message),
    );
  } finally {
    // Single-threaded test: the save/restore is not a real race.
    // eslint-disable-next-line require-atomic-updates
    globalThis.fetch = original;
  }
});

test('a concurrent adaptation is retried rather than adapted twice', () => {
  // Several requests are in flight on one client. If two hit the same
  // rejection, the second must not strip an unrelated parameter as collateral.
  const llm = new LLM(base);
  const before = llm.quirksVersion;
  llm.adapt('Unsupported parameter: response_format');
  assert.notEqual(llm.quirksVersion, before, 'a real adaptation bumps the version');
  assert.equal(llm.quirks.jsonMode, false);
});

test('adaptation eventually gives up instead of looping', () => {
  const llm = new LLM(base);
  llm.quirks.jsonMode = false;
  assert.equal(llm.adapt('some unrelated failure'), false);
});
