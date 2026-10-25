import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Decoder, decode, decodeStream, decodeTrees, Element, encode, encodeChunks } from '../src/index.js';
import { bytes, empty, hex, node, repeat, sameBytes } from './helpers.js';

/** Splits bytes into chunks of the given size (1 = the worst case of a network stream). */
function* chunked(input: Uint8Array, size: number): Generator<Uint8Array> {
  for (let offset = 0; offset < input.length; offset += size) {
    yield input.slice(offset, offset + size);
  }
}

function sampleTree(): Element {
  const random = new Uint8Array(1_300_000);

  for (let index = 0; index < random.length; index++) {
    random[index] = (index * 7919) % 251;
  }

  return node(
    'Root',
    new Element({ data: random, children: [noContentWith(node('deep'))] }),
    new Element({ metadata: hex('FF 00 FF') }),
    empty(),
    node('last'),
  );
}

function noContentWith(...children: Element[]): Element {
  return new Element({ children });
}

describe('streams', () => {
  it('decodeStream with one-byte chunks', async () => {
    const tree = node('R', node('A', node('A1')), empty(), node('B'));
    const { tree: decoded, rest } = await decodeStream(chunked(encode(tree), 1));

    expect(decoded.structurallyEquals(tree)).toBe(true);
    expect(rest).toHaveLength(0);
  });

  it('decodeStream returns the rest of the last chunk', async () => {
    const { tree, rest } = await decodeStream([bytes(hex('41 52 00'), hex('42 43'))]);

    expect(tree.structurallyEquals(node('R'))).toBe(true);
    expect(rest).toEqual(hex('42 43'));
  });

  it('decodeStream from a Node Readable', async () => {
    const tree = sampleTree();
    const { tree: decoded } = await decodeStream(Readable.from(chunked(encode(tree), 1000)));

    expect(decoded.structurallyEquals(tree)).toBe(true);
  });

  it('decodeStream from a Web ReadableStream', async () => {
    const tree = sampleTree();
    const { tree: decoded } = await decodeStream(ReadableStream.from(encodeChunks(tree)));

    expect(decoded.structurallyEquals(tree)).toBe(true);
  });

  it('decodeStream from a ReadableStream reader (without async iteration)', async () => {
    const tree = node('R', node('A'));
    const stream = ReadableStream.from(chunked(encode(tree), 2));
    const readerOnly = { getReader: () => stream.getReader() };

    expect((await decodeStream(readerOnly)).tree.structurallyEquals(tree)).toBe(true);
  });

  it('decodeTrees reads concatenated trees', async () => {
    const trees = [node('A', node('A1')), empty(), node('C'), sampleTree()];
    const input = bytes(...trees.map((tree) => encode(tree)));
    const decoded: Element[] = [];

    for await (const tree of decodeTrees(chunked(input, 7))) {
      decoded.push(tree);
    }

    expect(decoded).toHaveLength(trees.length);
    for (const [index, tree] of decoded.entries()) {
      expect(tree.structurallyEquals(trees[index])).toBe(true);
    }
  });

  it('decodeTrees accepts a last tree without terminator', async () => {
    const decoded: Element[] = [];

    for await (const tree of decodeTrees([hex('41 41 00 41 42')])) {
      decoded.push(tree);
    }

    expect(decoded.map((tree) => tree.toString())).toEqual(['(41 = "A")', '(42 = "B")']);
  });

  it('decode reports the consumed bytes of concatenated trees', () => {
    const input = bytes(encode(node('A')), encode(node('B')));
    const first = decode(input);
    const second = decode(input.subarray(first.consumed));

    expect(first.consumed).toBe(3);
    expect(first.tree.structurallyEquals(node('A'))).toBe(true);
    expect(second.tree.structurallyEquals(node('B'))).toBe(true);
  });

  it('a decoder never consumes bytes after the terminator', () => {
    const decoder = new Decoder();

    expect(decoder.push(hex('41 52'))).toBe(2);
    expect(decoder.push(hex('00 FF FF'))).toBe(1);
    expect(decoder.done).toBe(true);
    expect(decoder.push(hex('FF'))).toBe(0);
  });

  it('a truncated stream is an error', async () => {
    await expect(decodeStream([hex('42 61')])).rejects.toMatchObject({ code: 'UNEXPECTED_END' });
  });

  it('encodeChunks yields blocks of at most 64 KiB', () => {
    const tree = sampleTree();
    const blocks = [...encodeChunks(tree)];

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.length <= 64 * 1024)).toBe(true);
    expect(sameBytes(bytes(...blocks), encode(tree))).toBe(true);
  });
});

describe('limits', () => {
  const input = encode(node('R', node('A'), node('B')));

  it('maxBytes', () => {
    expect(() => decode(input, { maxBytes: input.length })).not.toThrow();
    expect(() => decode(input, { maxBytes: input.length - 1 })).toThrow(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    );
  });

  it('maxNodes', () => {
    expect(() => decode(input, { maxNodes: 3 })).not.toThrow();
    expect(() => decode(input, { maxNodes: 2 })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
});

describe('big and malformed trees', () => {
  const depth = 50_000;

  it('a deep tree (no recursion)', () => {
    const root = node('0');
    let current = root;

    for (let level = 1; level < depth; level++) {
      const child = new Element({ data: Uint8Array.of(level & 0xff) });
      current.add(child);
      current = child;
    }

    const decoded = decode(encode(root)).tree;
    let levels = 0;
    decoded.walk(() => levels++);

    expect(levels).toBe(depth);
    expect(decoded.structurallyEquals(root)).toBe(true);
    expect(decoded.clone().structurallyEquals(root)).toBe(true);
  });

  it('a deep stream of placeholders', () => {
    expect(decode(bytes(repeat(0x40, depth), [0])).tree.structurallyEquals(empty())).toBe(true);
  });

  it('many empty siblings are kept', () => {
    const input = bytes(hex('41 52 60'), repeat(0xe0, depth - 1), [0]);
    const tree = decode(input).tree;

    expect(tree.children).toHaveLength(depth);
    expect(sameBytes(encode(tree), input)).toBe(true);
  });

  it('many auxiliary siblings are removed in linear time', () => {
    const tree = decode(bytes(hex('41 52 41 41'), repeat(0xc0, 200_000), hex('C1 42 00'))).tree;

    expect(tree.children).toHaveLength(2);
  });
});
