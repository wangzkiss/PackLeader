/**
 * 脱敏：写审计库、写日志文件之前，把密钥和口令遮掉。
 *
 * 两重保险：
 *   1. 已知密钥（配置里的 api key 之类）按字面替换——不管它以什么形式出现；
 *   2. 常见形态（sk-xxx / Bearer xxx / password=xxx / --token xxx）按正则遮。
 *
 * 原则：脱敏只发生在「落盘」这一步，模型看到的内容、session.jsonl 的原样回放不受影响。
 */

const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / DeepSeek 风格的 key
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  // Authorization: Bearer xxx
  [/\b(Bearer)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 ***'],
  // key=value 形态
  [
    /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*[=:]\s*["']?)[^\s"',;&}\]]{4,}/gi,
    '$1***',
  ],
  // 命令行开关形态：--password xxx / --token=xxx
  [/(--?(?:password|passwd|token|api-key|apikey)[ =])\S{4,}/gi, '$1***'],
  // 环境变量形态
  [/\b((?:PL_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)=)\S+/g, '$1***'],
]

export class Redactor {
  private secrets: string[] = []

  /** 登记一个已知密钥（值本身，至少 6 位，太短的会误伤普通文本） */
  add(secret: string | undefined | null): void {
    const s = (secret ?? '').trim()
    if (s.length >= 6 && !this.secrets.includes(s)) this.secrets.push(s)
  }

  redact(text: string): string {
    if (!text) return text
    let out = text
    // 已知密钥按字面替换，先做：正则挡不住的形态也能遮住
    for (const s of this.secrets) out = out.split(s).join('***')
    for (const [re, to] of PATTERNS) out = out.replace(re, to)
    return out
  }
}

/** 进程内共用一份：host 启动时把配置里的 key 登记进来 */
export const globalRedactor = new Redactor()

export function redact(text: string): string {
  return globalRedactor.redact(text)
}

export function registerSecret(secret: string | undefined | null): void {
  globalRedactor.add(secret)
}
