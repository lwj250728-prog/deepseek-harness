// 嵌入空间分布实测：业务 vs 闲聊 top1 相似度（用 bge-m3 嵌入）
import * as fs from 'node:fs'
const keyLine = fs.readFileSync('D:/DeepSeek-Harness/data/.credentials.yaml', 'utf8').split('\n').find(l => l.includes('SILICONFLOW_API_KEY'))
const key = keyLine.split(': ')[1].trim()

async function embedBatch(texts) {
  const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'BAAI/bge-m3', input: texts }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return j.data.map(d => d.embedding)
}
function cosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) }

// 加载经验库（含嵌入）
const exps = fs.readFileSync('D:/DeepSeek-Harness/data/cognitive-pipeline/experiences.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter(e => e.embedding && !(e.simulated && e.verification === 'unverified'))

const business = [
  '服务重启后需要验证恢复情况', '插件配置推送失败帮我看看', '日志滚动太快需要检查',
  '依赖安装失败报错超时', '重启服务试试看能不能恢复', '部署上线前检查流程',
  '这个方案需要验证可行性', '迁移到新环境有风险吗', '之前的排查经验参考一下',
  '测试脚本挂起需要排查原因', '深海推进器振动异常调整参数', '民航航班雷暴天气放行',
  '发酵罐诱导期温度异常', '古籍校勘版本比对出错', '数据库连接超时排查',
]
const chitchat = [
  '今天天气不错适合散步', '帮我订一份外卖', '推荐一部好看的电影',
  '晚饭想吃什么好呢', '周末去哪里玩', '这首歌叫什么名字',
  '帮我翻译一段英文', '数学题怎么做', '推荐一本好书',
  '你吃饭了吗', '讲个笑话听听', '今天股票涨了吗',
]

// 一次嵌入所有查询
const all = [...business, ...chitchat]
const vecs = await embedBatch(all)
const byMsg = new Map(all.map((m, i) => [m, vecs[i]]))

function top1(msg) {
  const qv = byMsg.get(msg)
  let best = -1
  for (const e of exps) {
    const sim = cosine(qv, e.embedding)
    if (sim > best) best = sim
  }
  return best
}

console.log('经验库(含嵌入):', exps.length)
console.log('=== 业务 top1 ===')
const biz = business.map(m => ({ m, s: top1(m) })).sort((a, b) => a.s - b.s)
biz.forEach(r => console.log('  ', r.s.toFixed(3), r.m.slice(0, 16)))
console.log('\n=== 闲聊 top1 ===')
const chat = chitchat.map(m => ({ m, s: top1(m) })).sort((a, b) => b.s - a.s)
chat.forEach(r => console.log('  ', r.s.toFixed(3), r.m.slice(0, 16)))

const stats = a => { const s = [...a].sort((x, y) => x - y); return { min: s[0].toFixed(3), p25: s[Math.floor(s.length * 0.25)].toFixed(3), med: s[Math.floor(s.length * 0.5)].toFixed(3), p75: s[Math.floor(s.length * 0.75)].toFixed(3), max: s[s.length - 1].toFixed(3) } }
console.log('\n=== 分布 ===')
console.log('业务:', JSON.stringify(stats(biz.map(r => r.s))))
console.log('闲聊:', JSON.stringify(stats(chat.map(r => r.s))))
for (const th of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
  const b = biz.filter(r => r.s >= th).length, c = chat.filter(r => r.s >= th).length
  console.log(`阈值 ${th}: 业务 ${b}/15 (${(b/15*100).toFixed(0)}%), 闲聊误触 ${c}/12 (${(c/12*100).toFixed(0)}%)`)
}
