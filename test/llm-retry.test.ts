/**
 * 请求层健壮性：429 / 5xx 要重试，401 之类不重试；
 * 首字节迟迟不来、以及流发到一半卡住，都要快速失败，不能干等到整体超时。
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { LLM_DEFAULT_TIMEOUTS, OpenAiClient } from '../src/llm/openai.ts'

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void | Promise<void>

async function serve(handler: Handler) {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    req.resume()
    void handler(req, res, hits)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get hits() {
      return hits
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}

const sse = (...chunks: unknown[]): string =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`

function okStream(text: string): string {
  return sse(
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  )
}

const messages = [{ role: 'user' as const, content: 'hi' }]

test('429 重试一次就成功，不影响调用方', async () => {
  const srv = await serve((_req, res, n) => {
    if (n === 1) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limited' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(okStream('好的'))
  })
  const client = new OpenAiClient({
    baseURL: srv.url,
    apiKey: 'sk-t',
    model: 'm',
    retries: 2,
    retryBaseMs: 10,
  })
  try {
    const r = await client.chat({ messages, tools: [] })
    assert.equal(r.text, '好的')
    assert.equal(srv.hits, 2, '应该正好请求两次：第一次 429，第二次成功')
  } finally {
    await srv.close()
  }
})

test('5xx 也重试', async () => {
  const srv = await serve((_req, res, n) => {
    if (n <= 2) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('upstream busy')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(okStream('来了'))
  })
  const client = new OpenAiClient({ baseURL: srv.url, apiKey: 'sk-t', model: 'm', retries: 2, retryBaseMs: 10 })
  try {
    const r = await client.chat({ messages, tools: [] })
    assert.equal(r.text, '来了')
    assert.equal(srv.hits, 3)
  } finally {
    await srv.close()
  }
})

test('401 不重试：配置错了重试多少次都没用', async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid api key' }))
  })
  const client = new OpenAiClient({ baseURL: srv.url, apiKey: 'sk-t', model: 'm', retries: 3, retryBaseMs: 10 })
  try {
    await assert.rejects(() => client.chat({ messages, tools: [] }), /401/)
    assert.equal(srv.hits, 1, '4xx 不该重试')
  } finally {
    await srv.close()
  }
})

test('重试用尽后把最后一次的错误抛出来', async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })
  const client = new OpenAiClient({ baseURL: srv.url, apiKey: 'sk-t', model: 'm', retries: 1, retryBaseMs: 10 })
  try {
    await assert.rejects(() => client.chat({ messages, tools: [] }), /500/)
    assert.equal(srv.hits, 2, '1 次重试 = 总共 2 次请求')
  } finally {
    await srv.close()
  }
})

test('首字节迟迟不来：按首字节超时失败，不干等', async () => {
  const srv = await serve(() => {
    /* 既不写响应头也不回包，模拟连接被黑洞 */
  })
  const client = new OpenAiClient({
    baseURL: srv.url,
    apiKey: 'sk-t',
    model: 'm',
    firstByteMs: 200,
    retries: 0,
  })
  const t0 = Date.now()
  try {
    await assert.rejects(() => client.chat({ messages, tools: [] }), /首字节|超时/)
    const ms = Date.now() - t0
    assert.ok(ms < 3000, `应该 200ms 左右就失败，实际 ${ms}ms`)
  } finally {
    await srv.close()
  }
})

test('流发到一半卡住：按空闲超时失败', async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半' } }] })}\n\n`)
    // 之后不再写、也不 end
  })
  const client = new OpenAiClient({
    baseURL: srv.url,
    apiKey: 'sk-t',
    model: 'm',
    firstByteMs: 5000,
    idleMs: 200,
    retries: 0,
  })
  const t0 = Date.now()
  try {
    await assert.rejects(() => client.chat({ messages, tools: [] }), /流.*中断|空闲|超时/)
    assert.ok(Date.now() - t0 < 3000)
  } finally {
    await srv.close()
  }
})

test('默认超时跟得上长上下文：首字节 120 秒、空闲 180 秒、整体 900 秒', () => {
  const client = new OpenAiClient({ baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-t', model: 'm' })
  // 原来的 30 秒会把「一轮跑了 35 次工具之后服务端 prefill 变慢」的正常请求判死
  assert.equal(client.cfg.firstByteMs, LLM_DEFAULT_TIMEOUTS.firstByteMs)
  assert.ok(client.cfg.firstByteMs! >= 120_000, `首字节默认 ${client.cfg.firstByteMs}ms 太短`)
  assert.ok(client.cfg.idleMs! >= 180_000)
  assert.ok(client.cfg.timeoutMs! >= 900_000)
})

test('配置能单独覆盖其中一个超时，其余的用默认（没传的字段不能把默认打穿）', () => {
  const client = new OpenAiClient({
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-t',
    model: 'm',
    firstByteMs: 240_000,
    idleMs: undefined,
  })
  assert.equal(client.cfg.firstByteMs, 240_000)
  assert.equal(client.cfg.idleMs, LLM_DEFAULT_TIMEOUTS.idleMs, '显式 undefined 要回到默认值')
  assert.equal(client.cfg.timeoutMs, LLM_DEFAULT_TIMEOUTS.timeoutMs)
})
