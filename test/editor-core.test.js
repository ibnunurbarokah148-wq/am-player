import assert from 'node:assert/strict';
import {
  AM_TIME, createSceneModel, evaluateKeyframes, resolveParentTransform,
  CommandHistory, MutationCommand, serializeScene
} from '../src/editor-core.js';

const root = { tag: 'scene', attrs: { width: '100', height: '100', fps: '30', totalTime: '1000' }, children: [
  { tag: 'shape', attrs: { id: 'parent', startTime: '0', endTime: '1000' }, children: [
    { tag: 'transform', attrs: {}, children: [{ tag: 'location', attrs: { value: '10,20' }, children: [] }], text: '' }
  ], text: '' },
  { tag: 'shape', attrs: { id: 'child', parent: 'parent', startTime: '0', endTime: '1000' }, children: [
    { tag: 'transform', attrs: {}, children: [{ tag: 'location', attrs: { value: '5,6' }, children: [] }], text: '' },
    { tag: 'property', attrs: { name: 'opacity', value: '0' }, children: [
      { tag: 'kf', attrs: { t: '0', v: '0' }, children: [] },
      { tag: 'kf', attrs: { t: '1', v: '1' }, children: [] }
    ], text: '' }
  ], text: '' }
], text: '' };

assert.equal(AM_TIME.layerMsToNormalized(500, 0, 1000), 0.5);
assert.equal(AM_TIME.normalizedToLayerMs(0.25, 0, 1000), 250);
const model = createSceneModel(root);
assert.equal(model.layers.length, 2);
assert.equal(evaluateKeyframes(model.layers[1].properties.opacity, 500, 0, 1000), 0.5);
assert.deepEqual(resolveParentTransform(model.layers[1], model.layers, 500).slice(4), [15, 26]);

const target = { value: 1 }, history = new CommandHistory();
history.execute(new MutationCommand(target, 'value', 2));
assert.equal(target.value, 2); history.undo(); assert.equal(target.value, 1); history.redo(); assert.equal(target.value, 2);
assert.throws(() => serializeScene(model), /XMLSerializer dan DOM document diperlukan/);
console.log('editor-core self-check: ok');
