import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeTools, validateConnectorSelection, nativeToolName } from '../src/native-tools.mjs';

test('native MCP catalog binds config ids to real server ids, disambiguates names and discards unselected tools', () => {
  const records = ['one', 'two', 'unselected'].map(id => ({ serverId: `connector:${id}`, connectorId: id, rawName: 'lookup', description: 'fixture', inputSchema: { type: 'object' } }));
  const result = normalizeNativeTools(records, ['one', 'two']);
  assert.equal(result.length, 2); assert.notEqual(result[0].name, result[1].name);
  assert.equal(result[0].serverId, 'connector:one'); assert.equal(result[0].connectorId, 'one');
  assert.equal(result[0].name, nativeToolName('connector:one', 'lookup'));
  assert.deepEqual(result[0].parameters.properties, {});
  assert.throws(() => normalizeNativeTools(records, ['missing']), /尚未连接/);
  assert.deepEqual(validateConnectorSelection(['fixture']), ['fixture']);
});
test('native catalog rejects duplicate tools, unbounded or external schemas and invalid selections', () => {
  const record = { serverId: 'connector:one', connectorId: 'one', rawName: 'lookup', inputSchema: { type: 'object' } };
  for (const value of [null, ['one', 'one'], [''], [null], ['bad\nname']]) assert.throws(() => validateConnectorSelection(value));
  assert.throws(() => normalizeNativeTools([record, record], ['one']));
  assert.throws(() => normalizeNativeTools([{ ...record, inputSchema: { type: 'object', $ref: 'https://evil.invalid/schema.json' } }], ['one']));
  assert.throws(() => normalizeNativeTools([{ ...record, inputSchema: { type: 'object', description: 'x'.repeat(20_000) } }], ['one']));
});

test('globally enabled native user MCP keeps full origin id and cannot collide with a managed connector', () => {
  const user = { sourceType: 'user', selectedGlobally: true, serverId: 'custom-mcp:same', connectorId: 'custom-mcp:same', rawName: 'lookup', inputSchema: { type: 'object' } };
  const managed = { serverId: 'connector:same', connectorId: 'same', rawName: 'lookup', inputSchema: { type: 'object' } };
  assert.equal(normalizeNativeTools([user, managed], []).length, 1);
  const both = normalizeNativeTools([user, managed], ['same']);
  assert.equal(both.length, 2); assert.notEqual(both[0].name, both[1].name);
  for (const override of [{ selectedGlobally: false }, { serverId: 'connector:same' }, { connectorId: 'same' }]) {
    assert.throws(() => normalizeNativeTools([{ ...user, ...override }], []));
  }
});
