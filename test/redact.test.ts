import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Redactor, redact } from '../src/core/redact.ts'

test('sk- 开头的 key 被遮掉', () => {
  assert.equal(redact('key=sk-abcdef1234567890'), 'key=sk-***')
})

test('Bearer 令牌被遮掉', () => {
  assert.equal(redact('Authorization: Bearer eyJhbGciOi.abc-123_456'), 'Authorization: Bearer ***')
})

test('password= / token= 形态被遮掉', () => {
  assert.equal(redact('mysql --password=Hunter2xx'), 'mysql --password=***')
  assert.equal(redact('{"api_key":"abcdefg12345"}'), '{"api_key":"***"}')
  assert.equal(redact('export PL_API_KEY=abc123456'), 'export PL_API_KEY=***')
})

test('已知密钥按字面替换（哪怕形态不常见）', () => {
  const r = new Redactor()
  r.add('my-custom-secret-value')
  assert.equal(r.redact('日志里出现了 my-custom-secret-value 这段'), '日志里出现了 *** 这段')
})

test('太短的密钥不登记，避免误伤普通文本', () => {
  const r = new Redactor()
  r.add('abc')
  assert.equal(r.redact('abc 是普通文本'), 'abc 是普通文本')
})

test('普通文本原样返回', () => {
  const s = 'git status --short 显示 M ui/PackLeader.ps1'
  assert.equal(redact(s), s)
})
