import fs from 'node:fs';
const prefix = process.argv[2];
if (!['q4', 'q8'].includes(prefix)) throw new Error('Use q4 or q8');
const expected = [{ label: `${prefix}-quality-math`, value: { result: 3973 } },
  { label: `${prefix}-quality-extract`, value: { total: 38, largest: '乙组' } }];
const cases = expected.map(({ label, value }) => {
  const response = JSON.parse(fs.readFileSync(`evidence/ollama-local/private/${label}-1.response.json`, 'utf8'));
  const metrics = JSON.parse(fs.readFileSync(`evidence/ollama-local/${label}.json`, 'utf8')).results[0];
  let actual, strictJSON = true;
  try { actual = JSON.parse(response.content.trim()); }
  catch {
    strictJSON = false;
    try { actual = JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
    catch { actual = null; }
  }
  const valueCorrect = actual && Object.keys(actual).length === Object.keys(value).length &&
    Object.entries(value).every(([key, item]) => actual[key] === item);
  return { label, actual, expected: value, strictJSON, valueCorrect: Boolean(valueCorrect),
    pass: Boolean(valueCorrect && strictJSON && metrics.finishReason === 'stop' && metrics.status === 200),
    totalMs: metrics.totalMs, firstChunkMs: metrics.firstChunkMs };
});
const result = { cases, boundary: 'Two basic correctness/format checks; not broad model-quality acceptance' };
fs.writeFileSync(`evidence/ollama-local/${prefix}-quality-checks.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
