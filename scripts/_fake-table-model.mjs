// GUI 验证用的假模型：用 SSE 慢慢推出一段带表格的 Markdown，
// 之后渲染器会把它画成表格卡片。
import http from 'node:http'

const ANSWER = [
  '下面是结论对比：',
  '',
  '| 工具 | 作用 | 结果 |',
  '| --- | --- | --- |',
  '| `read` | 读文件 | 带行号 |',
  '| `write` | 写文件 | 会覆盖 |',
  '| grep | 搜索内容 | 按正则 |',
  '',
  '表格结束，后面是普通段落。',
  '',
  '再给一个行内代码里有竖线的例子：',
  '',
  '| 表达式 | 说明 |',
  '| --- | --- |',
  '| `a|b` | 逻辑或 |',
  '| `x | y` | 按位或 |',
  '',
  '收尾一句话。',
].join('\n')

const CHUNK = 40

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'access-control-allow-origin': '*' })
    res.end()
    return
  }
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404)
    res.end('nope')
    return
  }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (delta, finish) => {
      const payload = {
        id: 'fake-1',
        object: 'chat.completion.chunk',
        model: 'fake',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      }
      res.write('data: ' + JSON.stringify(payload) + '\n\n')
    }
    // 先把推理推一点，确认思考流不干扰表格渲染
    send({ reasoning_content: '先整理成表格。' })
    let i = 0
    const timer = setInterval(() => {
      if (i >= ANSWER.length) {
        clearInterval(timer)
        send({}, 'stop')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const piece = ANSWER.slice(i, i + CHUNK)
      i += CHUNK
      send({ content: piece })
    }, 120)
    req.on('close', () => clearInterval(timer))
  })
})

server.listen(19870, '127.0.0.1', () => console.log('fake model on 19870'))
