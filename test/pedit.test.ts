// Cross-checks with pedit, the command line tool of the reference implementation (Promptuarium repository, tools/PEdit).
// Set PEDIT to the path of pedit.dll; by default the sibling checkout ../Promptuarium is used. Skipped if pedit is not found.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode, Element, encode } from '../src/index.js';
import { hex, sameBytes } from './helpers.js';

const run = promisify(execFile);
const pedit =
  process.env.PEDIT ?? resolve(import.meta.dirname, '../../Promptuarium/tools/PEdit/bin/Debug/net10.0/pedit.dll');

async function peditRun(...args: string[]): Promise<string> {
  const { stdout } = await run('dotnet', [pedit, ...args]);
  return stdout;
}

/** A deterministic random tree with empty nodes, nodes without content, and contents of various lengths. */
function randomTree(seed: number): Element {
  let state = seed;
  const next = (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
  const content = () => {
    const kind = next(6);
    const length = kind < 2 ? 0 : kind < 4 ? next(16) : kind < 5 ? next(300) : next(70_000);
    return Uint8Array.from({ length }, () => next(256));
  };

  const root = new Element({ data: content(), metadata: content() });
  const stack: [Element, number][] = [[root, 0]];

  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [parent, depth] = entry;
    const count = depth < 5 ? next(depth < 2 ? 5 : 3) : 0;

    for (let index = 0; index < count; index++) {
      const child = new Element({ data: content(), metadata: content() });
      parent.add(child);
      stack.push([child, depth + 1]);
    }
  }

  return root;
}

interface DumpNode {
  depth: number;
  data: { hex: string } | null;
  metadata: { hex: string } | null;
}

/** Rebuilds a tree from `pedit dump --json` (a flat list in pre-order). */
function fromDump(json: string): Element {
  const nodes = (JSON.parse(json) as { nodes: DumpNode[] }).nodes;
  const path: Element[] = [];

  for (const entry of nodes) {
    const element = new Element({
      data: entry.data ? hex(entry.data.hex) : new Uint8Array(0),
      metadata: entry.metadata ? hex(entry.metadata.hex) : new Uint8Array(0),
    });

    path.length = entry.depth;
    path.at(-1)?.add(element);
    path.push(element);
  }

  return path[0] as Element;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe.skipIf(!existsSync(pedit))('cross-check with pedit (C# reference implementation)', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'promptuarium-js-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([1, 2, 3, 4, 5, 6])(
    'random tree %i: C# reads the JS encoding, and encodes it to the same bytes',
    async (seed) => {
      const tree = randomTree(seed);
      const file = join(directory, `random-${seed}.prm`);
      const encoded = encode(tree);
      await writeFile(file, encoded);

      // C# decodes the JS encoding to the same tree
      expect(fromDump(await peditRun('dump', file, '--json')).structurallyEquals(tree)).toBe(true);

      // C# encodes the same tree to the same bytes (set saves the file again, with the same root data)
      const resaved = join(directory, `resaved-${seed}.prm`);
      const data = tree.data.length > 0 ? `hex:${toHex(tree.data)}` : 'empty';
      await peditRun('set', file, '/', '--data', data, '--output', resaved);

      expect(sameBytes(await readFile(resaved), encoded)).toBe(true);
    },
  );

  it('JS reads the C# encoding of the worked example', async () => {
    const file = join(directory, 'worked.prm');
    await peditRun('new', file);
    await peditRun('set', file, '/', '--data', 'ascii:R');
    await peditRun('add', file, '/', '--data', 'ascii:X');
    await peditRun('add', file, '/0');
    await peditRun('add', file, '/0/0', '--data', 'ascii:d');
    await peditRun('add', file, '/', '--data', 'ascii:Y', '--metadata', 'ascii:m');

    const bytes = await readFile(file);
    const { tree, consumed } = decode(bytes);

    expect(consumed).toBe(bytes.length);
    expect(sameBytes(encode(tree), bytes)).toBe(true);
    expect(tree.treeToString()).toBe('(52 = "R")\n>(58 = "X")\n>>()\n>>>(64 = "d")\n>([6D = "m"] 59 = "Y")\n');
  });

  it('pedit chunks accepts the JS encoding', async () => {
    const file = join(directory, 'chunks.prm');
    const encoded = encode(randomTree(42));
    await writeFile(file, encoded);

    const result = JSON.parse(await peditRun('chunks', file, '--json')) as {
      consumed: number;
      trailing: number;
      error: string | null;
    };

    expect(result).toMatchObject({ consumed: encoded.length, trailing: 0, error: null });
  });
});
