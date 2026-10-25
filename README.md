# promptuarium

TypeScript / JavaScript implementation of **Promptuarium**, a space-efficient, streamable binary container for trees.

A Promptuarium tree is a tree of nodes, where every node has a **data** and a **metadata** byte sequence and an ordered list of **children**. That is all: the format defines the structure, the meaning of the bytes is up to you. The structure is always preserved, empty nodes included.

- Byte-identical with the reference implementation ([Promptuarium](https://github.com/fuszenecker/Promptuarium), .NET), following the [specification](https://github.com/fuszenecker/Promptuarium/blob/master/BINARY_FORMAT.md).
- Streaming: decode from Node streams, Web `ReadableStream`s or any (async) iterable of `Uint8Array`; encode in blocks.
- Arbitrarily deep trees, no recursion; limits for untrusted input.
- No dependencies; ESM; runs in Node.js (20+), browsers, Deno and Bun.

## Installation

```sh
npm install promptuarium
```

## Usage

```ts
import { decode, Element, encode } from 'promptuarium';

const utf8 = new TextEncoder();

const tree = new Element({
  data: utf8.encode('root'),
  children: [
    new Element({ data: utf8.encode('first'), metadata: utf8.encode('text/plain') }),
    new Element(), // an empty node, preserved like any other node
  ],
});

const bytes = encode(tree); // Uint8Array
const { tree: decoded } = decode(bytes);

decoded.structurallyEquals(tree); // true
```

Contents are `Uint8Array`s (a Node.js `Buffer` is one as well). An absent and an empty content are the same: an empty `Uint8Array`.

### Tree operations

```ts
const root = new Element();
const child = new Element({ data: utf8.encode('child') });

root.add(child); // append (a node with another parent is moved)
root.insert(0, new Element()); // insert at a position
root.at(1); // the child at a position (RangeError if there is none)
root.detach(child); // detach and return a child
child.parent; // null
root.walk((node, ancestors) => console.log(ancestors.length, node.toString()));
root.clone(); // deep copy
```

A node has at most one parent, and cycles are refused (`PromptuariumError` with code `INVALID_OPERATION`).

### Streams

```ts
import { decodeStream, decodeTrees, encodeChunks } from 'promptuarium';

// Decode one tree from a Node stream, a Web ReadableStream or an (async) iterable of Uint8Array
const { tree, rest } = await decodeStream(response.body);

// Decode trees that follow each other in a stream
for await (const tree of decodeTrees(socket)) {
  // ...
}

// Encode in blocks of at most 64 KiB
const stream = ReadableStream.from(encodeChunks(tree));
```

The decoder never consumes bytes after the terminator of a tree. `decodeStream` returns the bytes of the last chunk after the terminator as `rest`; to read several trees from the same source, use `decodeTrees`. For a byte array, `decode` returns the number of bytes `consumed`, so the next tree starts there.

For full control, the push-based `Decoder` can be fed with bytes directly:

```ts
const decoder = new Decoder();
decoder.push(firstBytes); // returns the number of bytes consumed
decoder.push(moreBytes);
if (decoder.done) {
  const tree = decoder.finish();
}
```

### Untrusted input

```ts
decode(bytes, { maxBytes: 10 * 1024 * 1024, maxNodes: 100_000 });
```

Exceeding a limit throws a `PromptuariumError` with code `LIMIT_EXCEEDED`. Invalid streams throw `ABOVE_ROOT` (navigating above the root) or `UNEXPECTED_END` (the stream ends inside a payload).

### Signature

A file can start with a fixed signature, so that it can be recognized e.g. by the `file` command (specification, section 10):

```ts
import { ElementBuilder } from 'promptuarium';

const root = new ElementBuilder().withSignature(utf8.encode('PRMT')).withChildren(content).build();
// encode(root) starts with 64 50 52 4D 54
```

## Development

```sh
npm install
npm test               # unit tests, including all test vectors of the specification
npm run test:interop   # cross-checks with pedit (the .NET reference tool), if ../Promptuarium is built
npm run lint
npm run typecheck
npm run build
```

`test:interop` encodes random trees with this implementation and checks that the reference implementation decodes them to the same tree and encodes them to the same bytes, and vice versa. Set `PEDIT` to the path of `pedit.dll` if the reference implementation is not checked out next to this repository.

## License

MIT
