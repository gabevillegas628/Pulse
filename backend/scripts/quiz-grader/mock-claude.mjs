// A stand-in for the Claude API: answers reads for the glycolysis quiz from a fixed table,
// logs which slot ids each request carried, and counts requests (GET /count).
import http from 'http'
import fs from 'fs'
const LOG = process.argv[2]
let count = 0
const enz = { s1: 'Hexokinase', s2: 'phosphoglucose isomerse', s3: 'PFK-1', s4: 'aldolase', s5: 'TPI', s6: 'GAPDH', s7: 'phosphoglycerate kinase', s8: 'PGM', s9: 'enolase', s10: 'pyruvate kinase' }
const cof = {
  s1: [['ATP', 'in'], ['ADP', 'out']], s3: [['ATP', 'in'], ['ADP', 'out']], s6: [['NAD+', 'in'], ['Pi', 'in'], ['NADH', 'out']],
  s7: [['ADP', 'in'], ['ATP', 'out']], s9: [['H2O', 'out']], s10: [['ADP', 'in'], ['ATP', 'out']],
}
http.createServer((req, res) => {
  if (req.method === 'GET') { res.end(JSON.stringify({ count })); return }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    count++
    const j = JSON.parse(body)
    const text = j.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const ids = [...text.matchAll(/^- (\w+):/gm)].map((m) => m[1]).filter((id) => id !== 'description')
    fs.appendFileSync(LOG, ids.join(' ') + '\n')
    const isStruct = JSON.stringify(j.output_config).includes('features')
    const slots = ids.map((id) => {
      const step = id.split('_')[0]
      if (isStruct) return { slot_id: id, status: 'read', description: 'a drawing', confidence: 0.9, features: [0, 1, 2, 3, 4].map((index) => ({ index, present: true, confidence: 0.9 })) }
      if (id.endsWith('_cofactors')) return { slot_id: id, status: 'read', transcription: '', confidence: 0.95, cofactors: (cof[step] ?? []).map(([text, side]) => ({ text, side })) }
      return { slot_id: id, status: 'read', transcription: enz[step] ?? '?', cofactors: [], confidence: 0.95 }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ slots }) }], usage: { input_tokens: 3000, output_tokens: 300 } }))
  })
}).listen(8788, () => console.log('mock up'))
