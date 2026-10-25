import { describe, expect, it } from 'vitest';
import { Element, ElementBuilder, encode, PromptuariumError } from '../src/index.js';
import { empty, hex, node, text } from './helpers.js';

const asText = (element: Element) => new TextDecoder().decode(element.data);

describe('tree operations', () => {
  it('add sets the parent and keeps the order', () => {
    const a = node('A');
    const b = node('B');
    const tree = node('R').add(a, b);

    expect(tree.children).toEqual([a, b]);
    expect(a.parent).toBe(tree);
    expect(tree.at(1)).toBe(b);
    expect([...tree].map(asText)).toEqual(['A', 'B']);
  });

  it('add moves a node from its previous parent', () => {
    const child = node('C');
    const first = node('1', child);
    const second = node('2', child);

    expect(first.children).toHaveLength(0);
    expect(child.parent).toBe(second);
  });

  it('add refuses duplicates and cycles', () => {
    const grandChild = node('G');
    const child = node('C', grandChild);
    const tree = node('R', child);

    expect(() => tree.add(child)).toThrow(PromptuariumError);
    expect(() => tree.add(tree)).toThrow(expect.objectContaining({ code: 'INVALID_OPERATION' }));
    expect(() => grandChild.add(tree)).toThrow(PromptuariumError);
    expect(grandChild.parent).toBe(child);
  });

  it('insert at a position', () => {
    const tree = node('R', node('A'), node('C'));

    tree.insert(1, node('B')).insert(3, node('D')).insert(0, node('0'));

    expect(tree.children.map(asText)).toEqual(['0', 'A', 'B', 'C', 'D']);
    expect(() => tree.insert(6, node('X'))).toThrow(RangeError);
    expect(() => tree.insert(-1, node('X'))).toThrow(RangeError);
  });

  it('at checks the index', () => {
    expect(() => node('R').at(0)).toThrow(RangeError);
    expect(() => node('R', node('A')).at(0.5)).toThrow(RangeError);
  });

  it('detach and remove', () => {
    const a = node('A', node('A1'));
    const b = node('B');
    const tree = node('R', a, b);

    expect(tree.detach(a)).toBe(a);
    expect(a.parent).toBeNull();
    expect(a.children).toHaveLength(1);
    expect(tree.remove(b)).toBe(tree);
    expect(tree.children).toHaveLength(0);
    expect(() => tree.detach(a)).toThrow(PromptuariumError);
    expect(() => tree.remove(a)).toThrow(PromptuariumError);
  });

  it('detach without an argument detaches the node itself', () => {
    const child = node('A');
    const tree = node('R', child);

    expect(child.detach()).toBe(child);
    expect(tree.children).toHaveLength(0);
    expect(tree.detach()).toBe(tree);
  });

  it('root', () => {
    const leaf = node('L');
    const tree = node('R', node('A', leaf));

    expect(leaf.root).toBe(tree);
    expect(tree.root).toBe(tree);
  });

  it('walk visits the nodes in pre-order with their ancestors', () => {
    const visited: string[] = [];

    node('R', node('A', node('A1'), node('A2')), node('B')).walk((element, ancestors) =>
      visited.push(`${asText(element)}:${ancestors.map(asText).join('/')}`),
    );

    expect(visited).toEqual(['R:', 'A:R', 'A1:R/A', 'A2:R/A', 'B:R']);
  });

  it('structurallyEquals', () => {
    const tree = () => node('R', node('A', node('A1')), new Element({ metadata: hex('07') }), empty());

    expect(tree().structurallyEquals(tree())).toBe(true);
    expect(tree().structurallyEquals(null)).toBe(false);
    expect(
      tree().structurallyEquals(node('R', node('A', node('A1')), new Element({ metadata: hex('08') }), empty())),
    ).toBe(false);
    expect(tree().structurallyEquals(node('R', node('A', node('A1')), new Element({ metadata: hex('07') })))).toBe(
      false,
    );
    expect(
      tree().structurallyEquals(node('R', node('A', node('A2')), new Element({ metadata: hex('07') }), empty())),
    ).toBe(false);
    expect(
      tree()
        .at(0)
        .structurallyEquals(node('A', node('A1'))),
    ).toBe(true);
  });

  it('clone creates a deep copy', () => {
    const child = node('C', node('G'));
    const original = node('R', child);
    const copy = original.clone();

    expect(copy.structurallyEquals(original)).toBe(true);
    expect(copy.at(0)).not.toBe(child);
    expect(copy.parent).toBeNull();
    expect(child.parent).toBe(original);

    copy.data[0] = 0x58;
    expect(asText(original)).toBe('R');
  });

  it('toString and treeToString', () => {
    const tree = node('R', new Element({ data: text('Y'), metadata: text('m') }));

    expect(tree.toString()).toBe('(52 = "R")');
    expect(tree.treeToString()).toBe('(52 = "R")\n>([6D = "m"] 59 = "Y")\n');
  });
});

describe('ElementBuilder', () => {
  it('signed root', () => {
    const root = new ElementBuilder().withSignature(text('PRMT')).withChildren(node('a')).build();

    expect(encode(root)).toEqual(hex('64 50 52 4D 54 41 61 00'));
  });

  it('signature is copied and checked', () => {
    const signature = hex('01 02 03');
    const root = new ElementBuilder().withSignature(signature).build();
    signature[0] = 9;

    expect(root.metadata).toEqual(hex('01 02 03'));
    expect(() => new ElementBuilder().withSignature(new Uint8Array(0))).toThrow(RangeError);
    expect(() => new ElementBuilder().withSignature(new Uint8Array(16))).toThrow(RangeError);
  });

  it('signature can not be combined with content', () => {
    expect(() => new ElementBuilder().withSignature(text('PRMT')).withData(text('x')).build()).toThrow(
      PromptuariumError,
    );
    expect(() => new ElementBuilder().withMetadata(text('x')).withSignature(text('PRMT')).build()).toThrow(
      PromptuariumError,
    );
  });

  it('ordinary node', () => {
    const child = node('C');
    const built = new ElementBuilder().withData(text('D')).withMetadata(text('M')).withChildren(child).build();

    expect(built.structurallyEquals(new Element({ data: text('D'), metadata: text('M'), children: [node('C')] }))).toBe(
      true,
    );
    expect(child.parent).toBe(built);
  });
});
