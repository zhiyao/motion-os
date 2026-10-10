import test from 'node:test';
import assert from 'node:assert/strict';
import {loadState, saveState} from '../player/state.mjs';
const project = {id: 'demo', version: 2, notes: [{id: 1, text: 'original'}]};
test('state initializes independently when storage is unavailable or malformed', () => {
  for (const storage of [{getItem() { throw new Error('blocked'); }}, {getItem: () => '{'}]) {
    const state = loadState(project, storage);
    state.notes[0].text = 'edited';
    assert.equal(project.notes[0].text, 'original');
    assert.equal(state.ver, 2);
    assert.deepEqual(state.over, {});
  }
});
test('version migration retains unsent work and removes acknowledged work', () => {
  const stored = {ver: 1, over: {'a.text': 'new', 'a.@keys': []}, sentSnap: {'a.text': 'old', 'a.@keys': []}, notes: [{id: 1}, {id: 2}], sent: [1], links: [{url: 'old', sent: true}, {url: 'new'}], messages: [{id: 3, text: 'keep'}]};
  const state = loadState(project, {getItem: () => JSON.stringify(stored)});
  assert.deepEqual(state.over, {'a.text': 'new'});
  assert.deepEqual(state.notes, [{id: 2}]);
  assert.deepEqual(state.links, [{url: 'new'}]);
  assert.deepEqual(state.sentSnap, {});
  assert.deepEqual(state.messages, stored.messages);
});
test('saving reports storage failure and uses the canonical project key', () => {
  let key, value;
  assert.equal(saveState(project, {ver: 2}, {setItem(k, v) { key = k; value = v; }}), true);
  assert.equal(key, 'motion-os-axi:demo'); assert.deepEqual(JSON.parse(value), {ver: 2});
  assert.equal(saveState(project, {}, {setItem() { throw new Error('full'); }}), false);
});

test('legacy browser edits survive the rename and canonical edits take precedence', () => {
  const legacy = JSON.stringify({ver: 2, over: {'title.text': 'keep'}});
  const values = new Map([['motionos:demo', legacy]]);
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const state = loadState(project, storage);
  assert.deepEqual(state.over, {'title.text': 'keep'});
  state.over['title.text'] = 'updated';
  saveState(project, state, storage);
  assert.deepEqual(loadState(project, storage).over, {'title.text': 'updated'});
});
