import { createHash, randomUUID } from 'node:crypto';

export class LexiangMock {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS lexiang_mock_entries (
      user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, space_id TEXT NOT NULL,
      parent_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, edited_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,id));`);
  }
  data(user) {
    const suffix = createHash('sha256').update(user.id).digest('hex').slice(0, 12);
    const staff = { id: `staff-${suffix}`, display_name: user.nickname, avatar: '' };
    const team = { id: `team-${suffix}`, code: `team-${suffix}`, name: '私有乐享 Mock 团队', logo: '', signature: '仅供本地验证' };
    const space = { id: `space-${suffix}`, name: `${user.nickname}的私有知识库`, root_entry_id: `root-${suffix}`, team_id: team.id, logo: '', description: '本地 Mock 数据，按账号隔离' };
    const personal = { ...space, id: `personal-${suffix}`, root_entry_id: `personal-root-${suffix}`, team_id: undefined, name: `${user.nickname}的个人知识库` };
    const put = this.store.db.prepare('INSERT OR IGNORE INTO lexiang_mock_entries VALUES(?,?,?,?,?,?,?,?)');
    for (const item of [space, personal]) {
      put.run(user.id, `${item.id}-intro`, item.id, item.root_entry_id, '私有乐享接入验证', 'page', '这是客户私有乐享的本地 Mock 内容。登录复用 auth-gateway 的有效会话，模型仍通过自定义配置直连。', this.store.now());
      put.run(user.id, `${item.id}-restart`, item.id, item.root_entry_id, '重启恢复检查', 'page', '完整退出后重新启动，应恢复相同账号、私有乐享地址和知识库目录；管理员释放会话后，旧访问凭证应被拒绝。', this.store.now());
    }
    const entries = this.store.db.prepare('SELECT * FROM lexiang_mock_entries WHERE user_id=? ORDER BY name,id').all(user.id).map(row => ({
      id: row.id, name: row.name, entry_type: row.kind, type: row.kind, title: row.name, extension: row.kind === 'folder' ? '' : 'md',
      space_id: row.space_id, parent_id: row.parent_id, owned_by: staff.id, edited_at: Math.floor(row.edited_at / 1000), has_children: false,
    }));
    return { staff, team, space, personal, entries };
  }
  api(user, url, input) {
    const { staff, team, space, personal, entries } = this.data(user);
    const path = url.pathname, timestamp = Math.floor(this.store.now() / 1000);
    if (path === '/spapi/account/v1/staff') return { staff };
    if (path === '/spapi/account/v1/company') return { company: { id: 'mock-company', code: 'mock-private', name: '本地 Mock 乐享', server_type: 'mock' } };
    if (path === '/spapi/team/v1/frequent-teams' || path === '/spapi/team/v1/teams') return { teams: team.name.toLocaleLowerCase().includes((url.searchParams.get('keyword') || '').toLocaleLowerCase()) ? [team] : [], next_page_token: '' };
    if (path === '/spapi/kb/space/v1/recent-spaces') return { spaces: [space, personal], visits: { [space.id]: timestamp, [personal.id]: timestamp }, teams: { [team.id]: team } };
    if (path === '/spapi/kb/space/v1/spaces/personal') return { space: personal };
    if (path === '/spapi/kb/space/v1/spaces') return { spaces: !url.searchParams.has('team_id') || url.searchParams.get('team_id') === team.id ? [space] : [], next_page_token: '' };
    const children = /^\/spapi\/kb\/entry\/v1\/entries\/([^/]+)\/children$/.exec(path);
    if (children) return { entries: entries.filter(entry => entry.parent_id === decodeURIComponent(children[1])), staffs: { [staff.id]: staff }, next_page_token: '' };
    if (path === '/spapi/staff/kb/v1/recent-entries') return { entries, staffs: { [staff.id]: staff }, spaces: { [space.id]: space, [personal.id]: personal }, next_page_token: '' };
    if (path === '/spapi/search/v1/kb/search') {
      if (typeof input.keyword !== 'string' || input.keyword.length > 512) throw Object.assign(new Error('无效的搜索条件'), { status: 400 });
      const keyword = input.keyword.toLocaleLowerCase();
      const allowedSpaces = [space, personal].filter(item => (!input.space_id || input.space_id === item.id) && (!input.team_id || input.team_id === item.team_id));
      const selected = entries.filter(entry => entry.name.toLocaleLowerCase().includes(keyword) && allowedSpaces.some(item => item.id === entry.space_id));
      const docs = input.type === 'space'
        ? allowedSpaces.filter(item => item.name.toLocaleLowerCase().includes(keyword)).map(item => ({ id: item.id, target_id: item.id, target_type: 'kb_space', title: item.name, space_id: item.id, team_id: item.team_id, extra_info: JSON.stringify({ root_entry_id: item.root_entry_id }) }))
        : selected.map(entry => ({ id: entry.id, target_id: entry.id, target_type: entry.entry_type, entry_type: entry.entry_type, extension: entry.extension, updated_at: entry.edited_at, title: entry.name, space_id: entry.space_id, team_id: entry.space_id === space.id ? team.id : undefined, extra_info: '{}' }));
      return { docs, team: { [team.id]: team.name }, space: { [space.id]: space.name, [personal.id]: personal.name }, total: docs.length, page_token: '' };
    }
    if (path === '/spapi/privilege/rbac/v1/my-permissions' || path === '/spapi/kb/perm/v1/staff/permissions') return { permissions: [] };
    if (path === '/spapi/privilege/rbac/v1/root-staffs') return { staffs: [] };
    if (path === '/spapi/team/v1/privilege-config') return { privilege_config: {} };
    if (path === '/spapi/kb/perm/v1/privileges/count') return { count: {} };
    if (path === '/spapi/kb/perm/v1/privileges') return { privileges: [], staffs: {}, departments: {} };
    if (path === '/spapi/feature-flag/v1/company/version') return {};
    if (path === '/spapi/license/v1/quotas') return { quotas: [] };
    throw Object.assign(new Error('本地乐享 Mock 尚未实现此接口'), { status: 501 });
  }
  tool(user, name, args) {
    const data = this.data(user);
    if (name === 'entry_list_example_space_entries') return { spaces: [data.space] };
    if (name === 'entry_list_latest_entries') return { entries: data.entries.filter(entry => entry.space_id === args.space_id), next_page_token: '' };
    if (name === 'entry_create_entry') {
      const parent = [data.space, data.personal].find(item => item.root_entry_id === args.parent_entry_id);
      if (!parent || !['page', 'folder'].includes(args.entry_type) || typeof args.name !== 'string' || !args.name.trim() || args.name.length > 128) throw Object.assign(new Error('无效的 Mock 新建知识参数'), { status: 400 });
      const id = randomUUID();
      this.store.db.prepare('INSERT INTO lexiang_mock_entries VALUES(?,?,?,?,?,?,?,?)').run(user.id, id, parent.id, parent.root_entry_id, args.name, args.entry_type, '本地 Mock 新建内容', this.store.now());
      return { entry: this.data(user).entries.find(entry => entry.id === id) };
    }
    throw Object.assign(new Error('本地乐享 Mock 不支持此工具'), { status: 501 });
  }
  document(user, id) { return this.store.db.prepare('SELECT name,body FROM lexiang_mock_entries WHERE user_id=? AND id=?').get(user.id, id); }
}
