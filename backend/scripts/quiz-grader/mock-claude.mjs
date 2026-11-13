// A stand-in for the Claude API: answers reads for the glycolysis quiz from a fixed table,
// logs which slot ids each request carried, and counts requests (GET /count).
import http from 'http'
import fs from 'fs'
const LOG = process.argv[2]
let count = 0
const enz = { s1: 'Hexokinase', s2: 'phosphoglucose isomerse', s3: 'PFK-1', s4: 'aldolase', s5: 'TPI', s6: 'GAPDH', s7: 'phosphoglycerate kinase', s8: 'PGM', s9: 'enolase', s10: 'pyruvate kinase' }
const names = { g6p: 'G6P', f6p: 'F6P', f16bp: 'fructose 1,6-bisphosphate', dhap: 'DHAP', gap: 'G3P', bpg13: '1,3-BPG', pg3: '3PG', pg2: '2PG', pep: 'PEP', pyruvate: 'pyruvate' }
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
    // Suggested checks for a key (suggest.ts): two checks per molecule asked for, one of them
    // failing on any drawing (a check the key's own drawing fails is dropped). A revision,
    // asked after testing, comes back the same.
    if (JSON.stringify(j.output_config).includes('"checks"')) {
      const asked = (/(?:returning one entry per id|for each of these ids): ([^\n]+?)\.?$/m.exec(text)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      fs.appendFileSync(LOG, (text.includes('were tested') ? 'revise ' : 'suggest ') + asked.join(' ') + '\n')
      const intermediates = asked.map((id) => ({ id, checks: [`shows the groups of ${id}`, 'MOCKFAIL a feature no drawing has'] }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ intermediates }) }], usage: { input_tokens: 9000, output_tokens: 900 } }))
      return
    }
    const ids = [...text.matchAll(/^- (\w+):/gm)].map((m) => m[1]).filter((id) => id !== 'description')
    fs.appendFileSync(LOG, ids.join(' ') + '\n')
    const isStruct = JSON.stringify(j.output_config).includes('features')
    // A second look (its prompt reads "letter by letter") reads step 2 properly, as a
    // stronger reader might; everything else it reads the same as the first pass.
    const secondLook = text.includes('letter by letter')
    if (secondLook) fs.appendFileSync(LOG, 'second-look\n')
    const slots = ids.map((id) => {
      const step = id.split('_')[0]
      // MOCK_UNSURE_STRUCTURES=1: the first reading of every drawing is unsure about check 1;
      // a second look ("careful second look") is sure of it.
      if (isStruct) {
        const unsure = process.env.MOCK_UNSURE_STRUCTURES === '1' && !text.includes('careful second look')
        if (text.includes('careful second look')) fs.appendFileSync(LOG, 'structure-second-look\n')
        // A check that says MOCKFAIL is never seen.
        const block = text.split(new RegExp(`^- ${id}: features to check:`, 'm'))[1]?.split(/^- /m)[0] ?? ''
        const fails = new Set([...block.matchAll(/^\s+(\d+)\. MOCKFAIL/gm)].map((m) => Number(m[1])))
        return { slot_id: id, status: 'read', description: 'a drawing', confidence: 0.9, features: [0, 1, 2, 3, 4].map((index) => ({ index, present: !fails.has(index), confidence: unsure && index === 1 ? 0.5 : 0.9 })) }
      }
      if (id.endsWith('_cofactors')) return { slot_id: id, status: 'read', transcription: '', confidence: 0.95, cofactors: (cof[step] ?? []).map(([text, side]) => ({ text, side })) }
      if (id.endsWith('_name')) return { slot_id: id, status: 'read', transcription: names[id.replace(/_name$/, '')] ?? '?', cofactors: [], confidence: 0.95 }
      if (secondLook && step === 's2') return { slot_id: id, status: 'read', transcription: 'phosphoglucose isomerase', cofactors: [], confidence: 0.9 }
      return { slot_id: id, status: 'read', transcription: enz[step] ?? '?', cofactors: [], confidence: 0.95 }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ slots }) }], usage: { input_tokens: 3000, output_tokens: 300 } }))
  })
}).listen(8788, () => console.log('mock up'))
