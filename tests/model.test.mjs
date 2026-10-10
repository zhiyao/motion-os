import test from 'node:test';
import assert from 'node:assert/strict';
import {
  keyBox,
  indexProject,
  pathExists,
  pendingOverrides,
  createTimeline,
  keepAfterNewVersion,
} from '../player/model.mjs';
const project = () => ({
  scenes: [
    {
      id: 'S1',
      t: [0, 4],
      els: [
        {
          id: 'a',
          box: [0, 0, 10, 10],
          props: {
            text: {
              v: 'Hi',
            },
          },
        },
      ],
    },
    {
      id: 'S2',
      t: [4, 8],
      els: [],
    },
    {
      id: 'S3',
      t: [8, 12],
      els: [],
    },
  ],
  brand: {
    colors: [
      {
        id: 'accent',
      },
    ],
    fonts: [],
  },
});
test('keyframes hold at endpoints and interpolate the midpoint', () => {
  const a = {
    t: 2,
    box: [0, 0, 10, 10],
  };
  const b = {
    t: 4,
    box: [20, 40, 30, 30],
  };
  assert.deepEqual(keyBox([a], 9), a.box);
  assert.deepEqual(keyBox([a, b], 1), a.box);
  assert.deepEqual(keyBox([a, b], 3), [10, 20, 20, 20]);
  assert.deepEqual(keyBox([a, b], 5), b.box);
});
test('indexed lookup reflects reel keyframe updates and keeps scene context', () => {
  const p = project();
  const i = indexProject(p);
  assert.equal(i.elById('a').s, 'S1');
  p.scenes[0].els[0].keys = [
    {
      t: 1,
      box: [1, 1, 1, 1],
    },
  ];
  assert.deepEqual(i.elById('a').keys, p.scenes[0].els[0].keys);
  assert.equal(i.elById('gone'), undefined);
  assert.equal(i.sceneOf('S1'), p.scenes[0]);
});
test('one pending selector excludes sent, removed and ineffective trims', () => {
  const p = project();
  const i = indexProject(p);
  const over = {
    'a.text': 'New',
    'gone.text': 'x',
    'S1.@len': 4,
    'S2.@len': 2,
    'brand.color.accent': '#fff',
  };
  const selected = pendingOverrides(
    over,
    {
      'brand.color.accent': '#fff',
    },
    (k) => pathExists(p, i, k),
    (k) => over[k] < 4,
  );
  assert.deepEqual(selected, [
    ['a.text', 'New'],
    ['S2.@len', 2],
  ]);
  p.scenes[0].els[0].box = null;
  assert.equal(pathExists(p, i, 'a.@keys'), false);
});
test('timeline maps stacked trims, boundaries and cut tails', () => {
  const p = project();
  let over = {};
  const t = createTimeline(p, (k, base) => (k in over ? over[k] : base));
  for (const time of [0, 1.25, 4, 8, 12]) {
    assert.equal(t.toSrc(t.toEd(time)), time);
  }
  over = {
    'S1.@len': 2,
    'S2.@len': 3,
  };
  assert.equal(t.edDur(), 9);
  assert.equal(t.toEd(3), 2);
  assert.equal(t.toSrc(2), 4);
  assert.equal(t.toEd(8), 5);
  assert.equal(t.toSrc(9), 12);
  assert.equal(t.nextAfterCut(3), 4);
  assert.equal(t.isCut(2), false);
  assert.equal(t.isCut(2.1), true);
  over['S3.@len'] = 1;
  assert.equal(t.nextAfterCut(11), -1);
  over['S1.@len'] = 10;
  assert.equal(t.sceneLen(p.scenes[0]), 4);
});
test('new versions clear sent edits and retain revised or unsent edits', () => {
  assert.deepEqual(
    keepAfterNewVersion(
      {
        'a.@keys': [],
        'a.text': 'Later',
        'S1.@len': 2,
      },
      {
        'a.@keys': [],
        'a.text': 'Before',
      },
    ),
    {
      'a.text': 'Later',
      'S1.@len': 2,
    },
  );
});
