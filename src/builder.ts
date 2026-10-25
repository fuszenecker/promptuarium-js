import { Element } from './element.js';
import { PromptuariumError } from './errors.js';

/** The maximum length of a signature: it fits in a single linear chunk at the beginning of the stream. */
export const MaxSignatureLength = 15;

/**
 * Builds a node step by step: its data, metadata, children, or a signature
 * (BINARY_FORMAT.md, section 10: a root without data, whose metadata is the signature).
 *
 * @example
 * const root = new ElementBuilder()
 *   .withSignature(new TextEncoder().encode('PRMT'))
 *   .withChildren(content)
 *   .build();
 */
export class ElementBuilder {
  #data: Uint8Array | undefined;
  #metadata: Uint8Array | undefined;
  #signature: Uint8Array | undefined;
  readonly #children: Element[] = [];

  /** Sets the data of the node. */
  withData(data: Uint8Array): this {
    this.#data = data;
    return this;
  }

  /** Sets the metadata of the node. */
  withMetadata(metadata: Uint8Array): this {
    this.#metadata = metadata;
    return this;
  }

  /**
   * Makes the node a signed root: no data, and the signature (1 to 15 bytes, copied) as metadata,
   * so every stream of the tree starts with the same bytes. The content goes into the children.
   */
  withSignature(signature: Uint8Array): this {
    if (signature.length < 1 || signature.length > MaxSignatureLength) {
      throw new RangeError(`A signature is 1 to ${MaxSignatureLength} bytes long, not ${signature.length} bytes.`);
    }

    this.#signature = signature.slice();
    return this;
  }

  /** Adds children to the node. They are moved into the node when it is built. */
  withChildren(...children: Element[]): this {
    this.#children.push(...children);
    return this;
  }

  /** Builds the node. */
  build(): Element {
    if (this.#signature && (this.#data || this.#metadata)) {
      throw new PromptuariumError(
        'INVALID_OPERATION',
        'A signed root has no data, and its metadata is the signature: withSignature can not be combined with withData or withMetadata.',
      );
    }

    return new Element({
      ...(this.#data ? { data: this.#data } : {}),
      // Every built node gets its own copy of the signature
      ...(this.#signature ? { metadata: this.#signature.slice() } : this.#metadata ? { metadata: this.#metadata } : {}),
      children: this.#children,
    });
  }
}
