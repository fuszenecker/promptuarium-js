import { appendChild, clearParent, Element, retainChildren } from './element.js';
import { PromptuariumError } from './errors.js';
import { Append, chunkLength, DirectionMask, Down, MetaData, New, Up } from './format.js';

/** Limits for decoding, e.g. from an untrusted source. */
export interface DecodeOptions {
  /** Maximum number of bytes consumed (control bytes included). */
  maxBytes?: number;
  /** Maximum number of nodes created (auxiliary nodes included). */
  maxNodes?: number;
}

/** The result of {@link decode}. */
export interface DecodeResult {
  /** The tree. */
  tree: Element;
  /** The number of bytes consumed, up to and including the terminator. Further trees may follow from here. */
  consumed: number;
}

/** The result of {@link decodeStream}. */
export interface DecodeStreamResult {
  /** The tree. */
  tree: Element;
  /** The bytes of the last chunk of the source after the terminator (they are not part of the tree). */
  rest: Uint8Array;
}

/** A Web ReadableStream (structurally, so no DOM types are needed). */
interface ReadableStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void };
}

/** A source of bytes: an (async) iterable of Uint8Array (e.g. a Node Readable) or a Web ReadableStream. */
export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | ReadableStreamLike;

/**
 * A push-based decoder (BINARY_FORMAT.md, section 5): feed it with bytes until it is done, then take the tree.
 * It never consumes bytes after the terminator.
 */
export class Decoder {
  readonly #options: DecodeOptions;
  readonly #virtual = new Element();
  readonly #kept = new Set<Element>();
  #parent: Element = this.#virtual;
  #node: Element = this.#virtual;

  // The content of the current node, collected until the decoder moves to another node
  #dataParts: Uint8Array[] = [];
  #metaDataParts: Uint8Array[] = [];

  // The rest of the payload being read
  #remaining = 0;
  #payloadIsMetaData = false;

  #consumed = 0;
  #nodes = 0;
  #done = false;

  constructor(options: DecodeOptions = {}) {
    this.#options = options;
  }

  /** True after the terminator. */
  get done(): boolean {
    return this.#done;
  }

  /** The number of bytes consumed so far. */
  get consumed(): number {
    return this.#consumed;
  }

  /**
   * Consumes bytes, up to the terminator at most.
   * @returns The number of bytes consumed from `bytes`; less than its length only if the terminator was reached.
   */
  push(bytes: Uint8Array): number {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('The decoder accepts Uint8Array chunks only.');
    }

    let offset = 0;

    while (offset < bytes.length && !this.#done) {
      if (this.#remaining > 0) {
        const length = Math.min(this.#remaining, bytes.length - offset);
        this.#count(length);
        (this.#payloadIsMetaData ? this.#metaDataParts : this.#dataParts).push(bytes.slice(offset, offset + length));
        this.#remaining -= length;
        offset += length;
        continue;
      }

      const control = bytes[offset++] as number;
      this.#count(1);
      this.#chunk(control);
    }

    return offset;
  }

  /**
   * Finishes decoding: removes the auxiliary nodes and returns the tree.
   * A missing terminator is accepted, but a stream that ends inside a payload is an error.
   */
  finish(): Element {
    if (this.#remaining > 0) {
      throw new PromptuariumError('UNEXPECTED_END', 'Unexpected end of stream inside a payload.');
    }

    this.#finishNode();
    removeAuxiliaryNodes(this.#virtual, this.#kept);

    const root = this.#virtual.children[0];

    if (!root) {
      return new Element();
    }

    clearParent(root);
    return root;
  }

  #chunk(control: number): void {
    const direction = control & DirectionMask;
    const length = chunkLength(control);

    switch (direction) {
      case New:
        this.#newNode(this.#parent);
        break;
      case Down:
        this.#parent = this.#node;
        this.#newNode(this.#parent);
        break;
      case Up: {
        const grandParent = this.#parent.parent;

        if (!grandParent) {
          throw new PromptuariumError('ABOVE_ROOT', 'The stream navigates above the root.');
        }

        this.#parent = grandParent;
        this.#newNode(this.#parent);
        break;
      }
    }

    if (length === 0) {
      if (direction === Append) {
        this.#done = true;
      } else if ((control & MetaData) !== 0) {
        // An empty node (60, A0, E0): part of the tree
        this.#kept.add(this.#node);
      }

      return;
    }

    this.#remaining = length;
    this.#payloadIsMetaData = (control & MetaData) !== 0;
  }

  #newNode(parent: Element): void {
    this.#finishNode();

    if (++this.#nodes > (this.#options.maxNodes ?? Number.POSITIVE_INFINITY)) {
      throw new PromptuariumError(
        'LIMIT_EXCEEDED',
        `The stream contains more nodes than the limit (${this.#options.maxNodes}).`,
      );
    }

    this.#node = new Element();
    appendChild(parent, this.#node);
  }

  /** Stores the collected content into the current node. */
  #finishNode(): void {
    if (this.#dataParts.length > 0) {
      this.#node.data = concat(this.#dataParts);
      this.#dataParts = [];
    }

    if (this.#metaDataParts.length > 0) {
      this.#node.metadata = concat(this.#metaDataParts);
      this.#metaDataParts = [];
    }
  }

  #count(length: number): void {
    this.#consumed += length;

    if (this.#consumed > (this.#options.maxBytes ?? Number.POSITIVE_INFINITY)) {
      throw new PromptuariumError(
        'LIMIT_EXCEEDED',
        `The stream is longer than the limit (${this.#options.maxBytes} bytes).`,
      );
    }
  }
}

/**
 * Decodes a tree from bytes. Further data (e.g. another tree) may follow the tree, see `consumed`.
 */
export function decode(bytes: Uint8Array, options?: DecodeOptions): DecodeResult {
  const decoder = new Decoder(options);
  const consumed = decoder.push(bytes);
  return { tree: decoder.finish(), consumed };
}

/**
 * Decodes one tree from a stream. The source is not read beyond the chunk that contains the terminator;
 * the bytes of that chunk after the terminator are returned as `rest`. The source is closed afterwards:
 * to read several trees from the same source, use {@link decodeTrees}.
 */
export async function decodeStream(source: ByteSource, options?: DecodeOptions): Promise<DecodeStreamResult> {
  const decoder = new Decoder(options);

  for await (const chunk of iterate(source)) {
    const consumed = decoder.push(chunk);

    if (decoder.done) {
      return { tree: decoder.finish(), rest: chunk.subarray(consumed) };
    }
  }

  return { tree: decoder.finish(), rest: new Uint8Array(0) };
}

/**
 * Decodes the trees that follow each other in a stream, until the end of the source.
 */
export async function* decodeTrees(
  source: ByteSource,
  options?: DecodeOptions,
): AsyncGenerator<Element, void, undefined> {
  let decoder = new Decoder(options);

  for await (const chunk of iterate(source)) {
    let offset = 0;

    while (offset < chunk.length) {
      offset += decoder.push(chunk.subarray(offset));

      if (decoder.done) {
        yield decoder.finish();
        decoder = new Decoder(options);
      }
    }
  }

  // The last tree may end without a terminator
  if (decoder.consumed > 0) {
    yield decoder.finish();
  }
}

async function* iterate(source: ByteSource): AsyncGenerator<Uint8Array, void, undefined> {
  if (Symbol.asyncIterator in source || Symbol.iterator in source) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }

  const reader = source.getReader();

  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      if (result.value) {
        yield result.value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Removes the auxiliary nodes that ended up empty, bottom-up and in linear time (BINARY_FORMAT.md, 5.1). */
function removeAuxiliaryNodes(virtual: Element, kept: Set<Element>): void {
  // In reverse pre-order every node comes after its descendants
  const nodes: Element[] = [];
  const stack: Element[] = [virtual];

  for (let node = stack.pop(); node; node = stack.pop()) {
    nodes.push(node);

    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push(node.children[index] as Element);
    }
  }

  for (let index = nodes.length - 1; index >= 0; index--) {
    retainChildren(
      nodes[index] as Element,
      (child) => child.data.length > 0 || child.metadata.length > 0 || child.children.length > 0 || kept.has(child),
    );
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) {
    return parts[0] as Uint8Array;
  }

  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}
