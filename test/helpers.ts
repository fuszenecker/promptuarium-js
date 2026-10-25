import { Element } from '../src/index.js';

const encoder = new TextEncoder();

/** A node with ASCII data, like `X("abc")` in BINARY_FORMAT.md. */
export function node(data: string, ...children: Element[]): Element {
  return new Element({ data: encoder.encode(data), children });
}

/** A node without content, with children (`c` in BINARY_FORMAT.md). */
export function noContent(...children: Element[]): Element {
  return new Element({ children });
}

/** An empty node (`(empty)` in BINARY_FORMAT.md). */
export function empty(): Element {
  return new Element();
}

/** Bytes from hex, e.g. `hex('41 52 00')`. */
export function hex(text: string): Uint8Array {
  const digits = text.replace(/\s/g, '');
  return Uint8Array.from(digits.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** Bytes from text. */
export function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Concatenates byte sequences. */
export function bytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const result = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of arrays) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/** Compares long byte sequences quickly (toEqual compares typed arrays element by element). */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left.buffer, left.byteOffset, left.length).equals(
    Buffer.from(right.buffer, right.byteOffset, right.length),
  );
}

/** `count` copies of a byte. */
export function repeat(value: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(value);
}
