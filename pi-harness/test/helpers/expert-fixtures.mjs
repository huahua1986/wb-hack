import fs from 'node:fs';
import path from 'node:path';

/** Owned synthetic files only; never consult the user's expert directories. */
export function writeExpertFixture(configDir, { body = 'EXPERT_PACKAGE_PERSONA_MARKER', bundle = 'expert-qa',
  skillBody = 'SKILL_BODY_MUST_NOT_BE_EAGERLY_INLINED' } = {}) {
  const root = path.join(configDir, 'plugins/marketplaces/experts/plugins', bundle);
  const manifestPath = path.join(root, '.codebuddy-plugin/plugin.json');
  const agentPath = path.join(root, 'agents/qa-agent.md');
  const skillPath = path.join(root, 'skills/qa-skill/SKILL.md');
  const mapPath = path.join(configDir, 'app/cache/experts/expert-bundle-map.json');
  for (const file of [manifestPath, agentPath, skillPath, mapPath]) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const manifest = { name: bundle, version: '1.0.0', expertType: 'agent', agentName: 'qa-agent', displayName: '合成包专家',
    agents: ['./agents/qa-agent.md'], skills: ['./skills/qa-skill'] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(agentPath, '---\nname: qa-agent\ndescription: Synthetic persona only\n---\n' + body + '\n');
  fs.writeFileSync(skillPath, '---\nname: qa-skill\ndescription: Read this synthetic resource only if the task requires it.\nallowed-tools: Read\n---\n' + skillBody + '\n');
  fs.writeFileSync(mapPath, JSON.stringify({ SyntheticExpert: bundle, ex_SYNTHETICEXPERT: bundle }));
  return { configDir, root, manifestPath, agentPath, skillPath, manifest, body, skillBody,
    selection: { id: 'SyntheticExpert', marketExpertId: 'ex_SYNTHETICEXPERT', name: '合成包专家', source: 'builtin',
      marketplace: 'experts', expertType: 'agent', locale: 'zh', pluginName: bundle, agentName: 'qa-agent',
      runtimeIdentity: 'expert-v2:{"v":2,"kind":"expert","expertId":"SyntheticExpert","marketExpertId":"ex_SYNTHETICEXPERT","agentName":"qa-agent","source":"builtin"}' } };
}
