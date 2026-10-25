// The test vectors of BINARY_FORMAT.md (Promptuarium repository)

import { describe, expect, it } from 'vitest';
import { decode, Element, encode, PromptuariumError } from '../src/index.js';
import { bytes, empty, hex, noContent, node, repeat, text } from './helpers.js';

function expectEncoding(tree: Element, expected: Uint8Array): void {
  const encoded = encode(tree);
  expect(encoded).toEqual(expected);

  const { tree: decoded, consumed } = decode(encoded);
  expect(decoded.structurallyEquals(tree)).toBe(true);
  expect(consumed).toBe(encoded.length);
}

function expectDecoding(input: Uint8Array, expected: Element): void {
  expect(decode(input).tree.structurallyEquals(expected)).toBe(true);
}

describe('9.1 Encoding (tree → bytes)', () => {
  it('(empty)', () => expectEncoding(empty(), hex('60 00')));

  it('R("R")', () => expectEncoding(node('R'), hex('41 52 00')));

  it('data "ab", metadata "c"', () =>
    expectEncoding(new Element({ data: text('ab'), metadata: text('c') }), hex('42 61 62 21 63 00')));

  it('metadata "m" only, child a("a")', () =>
    expectEncoding(new Element({ metadata: text('m'), children: [node('a')] }), hex('61 6D 41 61 00')));

  it('R [A, B, C]', () =>
    expectEncoding(node('R', node('A'), node('B'), node('C')), hex('41 52 41 41 C1 42 C1 43 00')));

  it('the worked example', () =>
    expectEncoding(
      node('R', node('X', noContent(node('d'))), new Element({ data: text('Y'), metadata: text('m') })),
      hex('41 52 41 58 40 41 64 80 81 59 21 6D 00'),
    ));

  it('R [A [B [C [D]]], E]', () =>
    expectEncoding(
      node('R', node('A', node('B', node('C', node('D')))), node('E')),
      hex('41 52 41 41 41 42 41 43 41 44 80 80 81 45 00'),
    ));

  it('R [X [c [(empty)]], Y]', () =>
    expectEncoding(node('R', node('X', noContent(empty())), node('Y')), hex('41 52 41 58 40 60 80 81 59 00')));

  it('P [(empty), M]', () => expectEncoding(node('P', empty(), node('M')), hex('41 50 60 C1 4D 00')));

  it('P [(empty), M, c [(empty), (empty)]]', () =>
    expectEncoding(node('P', empty(), node('M'), noContent(empty(), empty())), hex('41 50 60 C1 4D C0 60 E0 00')));

  it('R [A [B], (empty)]', () =>
    expectEncoding(node('R', node('A', node('B')), empty()), hex('41 52 41 41 41 42 A0 00')));

  it('data of 37 zero bytes', () =>
    expectEncoding(
      new Element({ data: new Uint8Array(37) }),
      bytes([0x51], repeat(0, 32), [0x05], repeat(0, 5), [0x00]),
    ));

  it('6.3: an empty node after climbing up', () =>
    expectEncoding(
      node('R', node('A', node('B', node('C', node('D')))), empty()),
      hex('41 52 41 41 41 42 41 43 41 44 80 80 A0 00'),
    ));
});

describe('6.2 Splitting a content into chunks', () => {
  const cases: [number, string][] = [
    [5, '45'],
    [15, '4F'],
    [16, '50'],
    [37, '51 05'],
    [600000, '5F 1C 19 16 15 14 13 12'],
    [1048576, '5F 1F'],
    [1048577, '5F 1F 01'],
  ];

  it.each(cases)('%i bytes', (length, controlBytes) => {
    const encoded = encode(new Element({ data: new Uint8Array(length) }));
    const controls: number[] = [];

    for (let offset = 0; offset < encoded.length - 1; ) {
      const control = encoded[offset] as number;
      controls.push(control);
      const nibble = control & 0x0f;
      offset += 1 + ((control & 0x10) !== 0 ? 1 << (nibble + 4) : nibble);
    }

    expect(Uint8Array.from(controls)).toEqual(hex(controlBytes));
  });
});

describe('9.2 Decoding only (bytes → tree)', () => {
  it('empty stream', () => expectDecoding(new Uint8Array(0), empty()));

  it('00 (an empty root of older encoders)', () => expectDecoding(hex('00'), empty()));

  it('no terminator', () => expectDecoding(hex('41 61'), node('a')));

  it('truncated payload', () => {
    expect(() => decode(hex('42 61'))).toThrow(expect.objectContaining({ code: 'UNEXPECTED_END' }));
  });

  it('navigating above the root', () => {
    expect(() => decode(hex('81 52 00'))).toThrow(PromptuariumError);
    expect(() => decode(hex('81 52 00'))).toThrow(expect.objectContaining({ code: 'ABOVE_ROOT' }));
  });

  it('C1 at the beginning', () => expectDecoding(hex('C1 52 00'), node('R')));

  it('content before the first node', () => expectDecoding(hex('01 58 41 52 00'), node('R')));

  it('sibling of the root', () => expectDecoding(hex('41 52 C1 53 00'), node('R')));

  it('interleaved chunks', () =>
    expectDecoding(hex('41 61 21 6D 01 62 00'), new Element({ data: text('ab'), metadata: text('m') })));

  it('10 is not a terminator', () =>
    expectDecoding(bytes(hex('41 61 10'), repeat(0x62, 16), [0]), node(`a${'b'.repeat(16)}`)));

  it('20 is a terminator, the rest is not read', () => {
    const result = decode(hex('41 61 20 41 62 00'));
    expect(result.tree.structurallyEquals(node('a'))).toBe(true);
    expect(result.consumed).toBe(3);
  });

  it('a root without content', () => expectDecoding(hex('60 41 61 00'), noContent(node('a'))));

  it('auxiliary nodes are removed', () => expectDecoding(hex('41 52 40 C0 C1 41 00'), node('R', node('A'))));

  it('N auxiliary siblings', () =>
    expectDecoding(bytes(hex('41 52 41 41'), repeat(0xc0, 1000), hex('C1 42 00')), node('R', node('A'), node('B'))));

  it('N placeholders', () => expectDecoding(bytes(repeat(0x40, 1000), [0]), empty()));

  it('an empty node can receive content', () => expectDecoding(hex('41 52 60 01 61 00'), node('R', node('a'))));
});

describe('10 File identification', () => {
  it('signed root', () =>
    expectEncoding(new Element({ metadata: text('PRMT'), children: [node('a')] }), hex('64 50 52 4D 54 41 61 00')));

  it('signed root without children', () =>
    expectEncoding(new Element({ metadata: text('PRMT') }), hex('64 50 52 4D 54 00')));
});

describe('11 Streams of older encoders', () => {
  it('up to 5.0.0', () => expectDecoding(hex('41 50 C1 4D 00'), node('P')));

  it('up to 6.0.0', () => expectDecoding(hex('41 52 41 58 40 80 81 59 00'), node('R', node('X'))));
});
