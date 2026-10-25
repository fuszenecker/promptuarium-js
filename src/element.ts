import { PromptuariumError } from './errors.js';

const Empty = new Uint8Array(0);

/** The initial values of a new {@link Element}. */
export interface ElementInit {
  /** The data (default: empty). */
  data?: Uint8Array;
  /** The metadata (default: empty). */
  metadata?: Uint8Array;
  /** The children; nodes that have another parent are moved into the new node. */
  children?: Iterable<Element>;
}

// Internal operations for the decoder (not exported from the package)
let appendChild: (parent: Element, child: Element) => void;
let retainChildren: (parent: Element, keep: (child: Element) => boolean) => void;
let clearParent: (node: Element) => void;

/**
 * A node of a Promptuarium tree: data, metadata and an ordered list of children.
 *
 * The data and the metadata are plain bytes; an absent and an empty content are the same.
 * A node has at most one parent, and the tree operations refuse cycles.
 */
export class Element implements Iterable<Element> {
  /** The data of the node. */
  data: Uint8Array;

  /** The metadata of the node. */
  metadata: Uint8Array;

  #parent: Element | null = null;
  readonly #children: Element[] = [];

  static {
    appendChild = (parent, child) => {
      parent.#children.push(child);
      child.#parent = parent;
    };

    retainChildren = (parent, keep) => {
      let kept = 0;

      for (const child of parent.#children) {
        if (keep(child)) {
          parent.#children[kept++] = child;
        } else {
          child.#parent = null;
        }
      }

      parent.#children.length = kept;
    };

    clearParent = (node) => {
      node.#parent = null;
    };
  }

  constructor(init: ElementInit = {}) {
    this.data = init.data ?? Empty;
    this.metadata = init.metadata ?? Empty;

    if (init.children) {
      this.add(...init.children);
    }
  }

  /** The parent of the node, or null for a root. */
  get parent(): Element | null {
    return this.#parent;
  }

  /** The children of the node. Use the tree operations (add, insert, remove, detach) to change them. */
  get children(): readonly Element[] {
    return this.#children;
  }

  /** The root of the tree that contains this node. */
  get root(): Element {
    let node: Element = this;

    while (node.#parent) {
      node = node.#parent;
    }

    return node;
  }

  /** The child at the given position. Throws a RangeError if there is no such child. */
  at(index: number): Element {
    const child = this.#children[index];

    if (!Number.isInteger(index) || child === undefined) {
      throw new RangeError(`Index ${index} is out of range [0...${this.#children.length - 1}]`);
    }

    return child;
  }

  /** Appends nodes to the children. A node that has another parent is moved here. */
  add(...nodes: Element[]): this {
    for (const node of nodes) {
      this.#prepareNewChild(node);
      appendChild(this, node);
    }

    return this;
  }

  /** Inserts a node at the given position (0 to the number of children). A node that has another parent is moved here. */
  insert(index: number, node: Element): this {
    if (!Number.isInteger(index) || index < 0 || index > this.#children.length) {
      throw new RangeError(`Index ${index} is out of range [0...${this.#children.length}]`);
    }

    this.#prepareNewChild(node);
    this.#children.splice(index, 0, node);
    node.#parent = this;
    return this;
  }

  /** Removes a child (with its subtree). Throws if the node is not a child of this node. */
  remove(node: Element): this {
    this.detach(node);
    return this;
  }

  /**
   * Detaches a child (with its subtree) and returns it; without an argument, detaches this node from its parent and returns it.
   * Throws if the node is not a child of this node.
   */
  detach(node?: Element): Element {
    if (node === undefined) {
      const parent = this.#parent;

      if (parent) {
        parent.#detachChild(this);
      }

      return this;
    }

    if (node.#parent !== this) {
      throw new PromptuariumError('INVALID_OPERATION', 'The node is not a child of this node.');
    }

    this.#detachChild(node);
    return node;
  }

  /**
   * Calls the handler for every node of the tree, in pre-order. The ancestors are listed from the root to the parent;
   * the array is only valid during the call (copy it if it is needed later).
   */
  walk(handler: (node: Element, ancestors: readonly Element[]) => void): this {
    // Iterating (instead of recursion) keeps arbitrarily deep trees from overflowing the stack
    const stack: [Element, number][] = [[this, 0]];
    const ancestors: Element[] = [];

    for (let entry = stack.pop(); entry; entry = stack.pop()) {
      const [node, depth] = entry;
      ancestors.length = depth;
      handler(node, ancestors);
      ancestors.push(node);

      for (let index = node.#children.length - 1; index >= 0; index--) {
        stack.push([node.#children[index] as Element, depth + 1]);
      }
    }

    return this;
  }

  /**
   * Compares the structure and the contents of two trees: the data, the metadata and the children (in order) of every node.
   * The parents are not compared, so a subtree can be compared to a standalone tree.
   */
  structurallyEquals(other: Element | null | undefined): boolean {
    if (!other) {
      return false;
    }

    const stack: [Element, Element][] = [[this, other]];

    for (let pair = stack.pop(); pair; pair = stack.pop()) {
      const [left, right] = pair;

      if (left === right) {
        continue;
      }

      if (
        left.#children.length !== right.#children.length ||
        !bytesEqual(left.data, right.data) ||
        !bytesEqual(left.metadata, right.metadata)
      ) {
        return false;
      }

      for (let index = 0; index < left.#children.length; index++) {
        stack.push([left.#children[index] as Element, right.#children[index] as Element]);
      }
    }

    return true;
  }

  /** Creates a deep copy of the subtree (the contents are copied too). The copy has no parent. */
  clone(): Element {
    const copy = new Element({ data: this.data.slice(), metadata: this.metadata.slice() });
    const stack: [Element, Element][] = [[this, copy]];

    for (let pair = stack.pop(); pair; pair = stack.pop()) {
      const [source, target] = pair;

      for (const child of source.#children) {
        const childCopy = new Element({ data: child.data.slice(), metadata: child.metadata.slice() });
        appendChild(target, childCopy);
        stack.push([child, childCopy]);
      }
    }

    return copy;
  }

  /** The children of the node. */
  [Symbol.iterator](): Iterator<Element> {
    return this.#children[Symbol.iterator]();
  }

  /** The content of the node, e.g. `([6D = "m"] 59 = "Y")`. */
  toString(): string {
    const parts: string[] = [];

    if (this.metadata.length > 0) {
      parts.push(`[${contentToString(this.metadata)}]`);
    }

    if (this.data.length > 0) {
      parts.push(contentToString(this.data));
    }

    return `(${parts.join(' ')})`;
  }

  /** The tree, one node per line, indented by the tabulator. */
  treeToString(tabulator = '>'): string {
    const lines: string[] = [];
    this.walk((node, ancestors) => lines.push(`${tabulator.repeat(ancestors.length)}${node.toString()}\n`));
    return lines.join('');
  }

  #prepareNewChild(node: Element): void {
    if (!(node instanceof Element)) {
      throw new TypeError('A child must be an Element.');
    }

    if (node.#parent === this) {
      throw new PromptuariumError('INVALID_OPERATION', 'The node is already a child of this node.');
    }

    // Only a node with children can be an ancestor of this node, so leaves need no walk up the tree
    if (node === this || (node.#children.length > 0 && isAncestor(node, this))) {
      throw new PromptuariumError('INVALID_OPERATION', 'A node can not be added to itself or to its own descendant.');
    }

    // A node has only one parent
    const previousParent = node.#parent;

    if (previousParent) {
      previousParent.#detachChild(node);
    }
  }

  #detachChild(node: Element): void {
    const index = this.#children.indexOf(node);
    this.#children.splice(index, 1);
    node.#parent = null;
  }
}

function isAncestor(ancestor: Element, node: Element): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }

  return false;
}

/** Compares two byte sequences. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function contentToString(content: Uint8Array): string {
  let hex = '';
  let text = '';

  for (const byte of content) {
    hex += byte.toString(16).toUpperCase().padStart(2, '0');
    text += byte >= 0x20 && byte <= 0x7f ? String.fromCharCode(byte) : '.';
  }

  return `${hex} = "${text}"`;
}

/** @internal */
export { appendChild, clearParent, retainChildren };
