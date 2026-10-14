import fs from 'node:fs';
import path from 'node:path';

const [file] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(file, 'utf8'));
const cases = [
  { id: 'arithmetic-json', query: '不要调用任何工具，只输出一个 JSON 对象。计算 137 × 29，格式为 {"result":整数}，不添加解释。', expected: { result: 3973 } },
  { id: 'chinese-extraction', query: '不要调用任何工具，只输出 JSON。记录：甲组12人、乙组19人、丙组7人。求总人数，并写出人数最多的组。格式为 {"total":整数,"largest":"组名"}。', expected: { total: 38, largest: '乙组' } },
];
for (const test of cases) {
  const copy = structuredClone(body);
  const message = copy.messages.at(-1);
  const replace = text => {
    if (!/<user_query>[\s\S]*?<\/user_query>/.test(text)) throw new Error('Missing original user-query boundary');
    return text.replace(/<user_query>[\s\S]*?<\/user_query>/, `<user_query>\n${test.query}\n</user_query>`);
  };
  if (typeof message.content === 'string') message.content = replace(message.content);
  else for (const part of message.content) if (part.text) part.text = replace(part.text);
  const output = path.join('evidence/ollama-local/private', `${test.id}.request.json`);
  fs.writeFileSync(output, JSON.stringify(copy), { mode: 0o600, flag: 'wx' });
}
fs.writeFileSync('evidence/ollama-local/quality-expected.json', JSON.stringify(cases.map(({ id, expected }) => ({ id, expected })), null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ cases: cases.map(x => x.id), inheritedLongContext: true }));
