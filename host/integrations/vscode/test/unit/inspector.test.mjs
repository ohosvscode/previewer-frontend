// InspectorPanel 纯函数单测（ESM）：$rect 解析 + 组件树归一（实时树 / 默认目录）。
import assert from 'assert';
import { parseRect, toNode, rootsOf } from '../../../../../ui/src/components/InspectorPanel.js';

describe('parseRect（$rect → {x,y,w,h}）', () => {
  it('标准 "[l,t],[r,b]"', () => {
    assert.deepStrictEqual(parseRect('[0.00,0.00],[1080.00,2340.00]'), { x: 0, y: 0, w: 1080, h: 2340 });
  });
  it('带偏移与空格', () => {
    assert.deepStrictEqual(parseRect('[ 12.5 , 30 ] , [ 112.5 , 80 ]'), { x: 12.5, y: 30, w: 100, h: 50 });
  });
  it('非法 → null', () => {
    assert.strictEqual(parseRect('abc'), null);
    assert.strictEqual(parseRect(undefined), null);
  });
});

describe('toNode / rootsOf（兼容实时树与默认目录）', () => {
  it('实时组件节点：$type/$ID/$rect/$children', () => {
    const tree = {
      $type: 'Column', $ID: 1, $rect: '[0,0],[1080,2340]',
      $children: [
        { $type: 'Text', $ID: 2, $rect: '[40,100],[300,160]', $attrs: { content: 'Hi' } },
        { $type: 'Button', $ID: 3 },
      ],
    };
    const roots = rootsOf(tree);
    assert.strictEqual(roots.length, 1);
    const root = roots[0];
    assert.strictEqual(root.label, 'Column(1)');
    assert.deepStrictEqual(root.rect, { x: 0, y: 0, w: 1080, h: 2340 });
    assert.strictEqual(root.children.length, 2);
    assert.strictEqual(root.children[0].label, 'Text(2)');
    assert.deepStrictEqual(root.children[0].rect, { x: 40, y: 100, w: 260, h: 60 });
    assert.strictEqual(root.children[1].rect, null, '无 $rect → 不可定位');
  });

  it('默认目录：defaultValue{...} → 顶层组件类型节点（无 rect）', () => {
    const cat = { version: '1.0', deviceType: 'Phone', defaultValue: { badge: { $attrs: {} }, button: { $attrs: {} } } };
    const roots = rootsOf(cat);
    const labels = roots.map((r) => r.label);
    assert.ok(labels.includes('badge') && labels.includes('button'));
    assert.ok(roots.every((r) => r.rect === null), '目录项无位置');
  });
});
