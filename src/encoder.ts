import type { Element } from './element.js';
import { Append, Down, MetaData, New, split, Terminator, Up } from './format.js';

const BlockSize = 64 * 1024;

/**
 * Encodes a tree into the canonical byte sequence (BINARY_FORMAT.md, section 6), in blocks of at most 64 KiB.
 * Suitable for streaming: the whole stream is never in memory at once.
 *
 * @example
 * const stream = ReadableStream.from(encodeChunks(tree));
 */
export function* encodeChunks(root: Element): Generator<Uint8Array, void, undefined> {
  const writer = new BlockWriter();

  // Pre-order, without recursion; the decoder starts on a virtual root at depth -1
  const stack: [Element, number][] = [[root, 0]];
  let previousDepth = -1;

  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, depth] = entry;
    let direction: number;

    if (depth > previousDepth) {
      direction = Down;
    } else if (depth === previousDepth) {
      direction = New;
    } else {
      // Up climbs one level only, the extra levels are climbed by Up markers
      for (let level = 0; level < previousDepth - depth - 1; level++) {
        writer.byte(Up);
      }

      direction = Up;
    }

    if (node.data.length === 0 && node.metadata.length === 0) {
      // A placeholder (Data type) for a node with children, an empty node (MetaData type) otherwise
      writer.byte(direction | (node.children.length > 0 ? 0 : MetaData));
    }

    direction = writeContent(writer, node.data, direction, 0);
    writeContent(writer, node.metadata, direction, MetaData);

    previousDepth = depth;

    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push([node.children[index] as Element, depth + 1]);
    }

    yield* writer.takeBlocks();
  }

  writer.byte(Terminator);
  yield* writer.takeBlocks();
  yield* writer.flush();
}

/**
 * Encodes a tree into the canonical byte sequence (BINARY_FORMAT.md, section 6).
 */
export function encode(root: Element): Uint8Array {
  const blocks = [...encodeChunks(root)];

  if (blocks.length === 1) {
    return blocks[0] as Uint8Array;
  }

  const result = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;

  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }

  return result;
}

/** Writes the chunks of a content; returns the direction of the next chunk of the same node (Append after a chunk). */
function writeContent(writer: BlockWriter, content: Uint8Array, direction: number, type: number): number {
  let offset = 0;

  for (const chunk of split(content.length)) {
    writer.byte(direction | type | chunk.sizeBits);
    writer.bytes(content.subarray(offset, offset + chunk.length));
    offset += chunk.length;
    direction = Append;
  }

  return direction;
}

/** Collects bytes into blocks of BlockSize bytes. */
class BlockWriter {
  #block = new Uint8Array(BlockSize);
  #filled = 0;
  readonly #ready: Uint8Array[] = [];

  byte(value: number): void {
    if (this.#filled === BlockSize) {
      this.#finishBlock();
    }

    this.#block[this.#filled++] = value;
  }

  bytes(values: Uint8Array): void {
    let offset = 0;

    while (offset < values.length) {
      if (this.#filled === BlockSize) {
        this.#finishBlock();
      }

      const length = Math.min(values.length - offset, BlockSize - this.#filled);
      this.#block.set(values.subarray(offset, offset + length), this.#filled);
      this.#filled += length;
      offset += length;
    }
  }

  /** The completed blocks. */
  *takeBlocks(): Generator<Uint8Array> {
    while (this.#ready.length > 0) {
      yield this.#ready.shift() as Uint8Array;
    }
  }

  /** The last, partial block. */
  *flush(): Generator<Uint8Array> {
    if (this.#filled > 0) {
      yield this.#block.slice(0, this.#filled);
      this.#filled = 0;
    }
  }

  #finishBlock(): void {
    this.#ready.push(this.#block);
    this.#block = new Uint8Array(BlockSize);
    this.#filled = 0;
  }
}
