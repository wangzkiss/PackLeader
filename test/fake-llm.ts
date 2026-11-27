/**
 * 测试用的假 OpenAI 服务：按脚本回放 SSE。
 *
 * 刻意把 tool_calls 的 name 和 arguments 拆成多个分片，
 * 用来验证「按 index 聚合」这条最容易写错的逻辑。
 */

import { createServer, type Server } from 'node:http'

export interface ScriptToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface ScriptStep {
  text?: string
  reasoning?: string
  toolCalls?: ScriptToolCall[]
  usage?: { prompt: number; completion: number; cacheRead?: number }
}

export interface FakeLlm {
  url: string
  requests: Array<Record<string, any>>
  /** 每个请求带的请求头（小写），用来验证「没 Key 时不该带 authorization」这类行为 */
  headers: Array<Record<string, string | string[] | undefined>>
  close: () => Promise<void>
}

const tick = () => new Promise((r) => setTimeout(r, 2))

export async function startFakeLlm(steps: ScriptStep[]): Promise<FakeLlm> {
  const queue = [...steps]
  const requests: Array<Record<string, any>> = []
  const headers: Array<Record<string, string | string[] | undefined>> = []

  const server: Server = createServer(async (req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body) as Record<string, any>)
    headers.push({ ...req.headers })

    const step = queue.shift() ?? { text: '（脚本已用尽）' }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (obj: unknown) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }
    const delta = (d: Record<string, unknown>, finish: string | null = null) =>
      send({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] })

    if (step.reasoning) {
      for (const part of step.reasoning.match(/.{1,12}/gs) ?? []) {
        delta({ reasoning_content: part })
        await tick()
      }
    }
    if (step.text) {
      for (const part of step.text.match(/.{1,10}/gs) ?? []) {
        delta({ content: part })
        await tick()
      }
    }
    if (step.toolCalls?.length) {
      for (let i = 0; i < step.toolCalls.length; i++) {
        const tc = step.toolCalls[i]!
        const json = JSON.stringify(tc.args)
        const half = Math.ceil(json.length / 2)
        const nameHalf = Math.ceil(tc.name.length / 2)
        // 第一片：id + 半个名字 + 半个参数
        delta({
          tool_calls: [
            {
              index: i,
              id: tc.id ?? `call_${i + 1}`,
              type: 'function',
              function: { name: tc.name.slice(0, nameHalf), arguments: json.slice(0, half) },
            },
          ],
        })
        await tick()
        // 第二片：剩下的名字 + 剩下的参数（无 id）
        delta({
          tool_calls: [
            { index: i, function: { name: tc.name.slice(nameHalf), arguments: json.slice(half) } },
          ],
        })
        await tick()
      }
      delta({}, 'tool_calls')
    } else {
      delta({}, 'stop')
    }

    send({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: step.usage?.prompt ?? 100,
        completion_tokens: step.usage?.completion ?? 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: step.usage?.cacheRead ?? 0 },
      },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('fake llm 启动失败')
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    headers,
    close: () => new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
  }
}
