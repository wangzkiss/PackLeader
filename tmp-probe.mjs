import { createDefaultTools } from './src/tools/index.ts'

const reg = createDefaultTools({ root: 'E:/Desktop/ai/PackLeader' })
const schemas = reg.schemas()
const per = {}
for (const t of reg.all()) per[t.name] = t.permission
const json = JSON.stringify(schemas)
const describe = reg.describe()
const sysPromptEstimate = describe.length
console.log('tools:', schemas.length)
console.log('schema json chars:', json.length, '~tokens(cjk-aware ~/2):', Math.round(json.length / 2))
console.log('describe chars:', describe.length)
const big = schemas
  .map((s) => ({ name: s.name, chars: JSON.stringify(s).length }))
  .sort((a, b) => b.chars - a.chars)
console.log('top schema sizes:', JSON.stringify(big.slice(0, 8)))
console.log('permissions:', JSON.stringify(per))
