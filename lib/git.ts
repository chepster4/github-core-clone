// git.ts — the git object model, packfile codec and pkt-line framing, stdlib only.
// Every byte format mirrors the suite's own git-client.ts, so the objects this forge writes
// hash exactly like the objects the suite builds for the same content.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const HEX40 = /^[0-9a-f]{40}$/;
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Parsed commits, keyed by the stored object bytes (objects are immutable once stored). */
const COMMIT_CACHE = new WeakMap<Uint8Array, CommitView>();
/** Parsed trees, keyed by the stored object bytes (objects are immutable once stored). */
const TREE_CACHE = new WeakMap<Uint8Array, TreeEntry[]>();

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object header `<type> <size>\0` that prefixes the bytes a SHA-1 is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  // A Buffer is hashed in place; anything else is copied once (never twice).
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const cached = TREE_CACHE.get(data);
  if (cached !== undefined) return cached;
  const entries = parseTreeUncached(data);
  TREE_CACHE.set(data, entries);
  return entries;
}

/** The uncached tree parse (see parseTree). */
function parseTreeUncached(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const cached = COMMIT_CACHE.get(data);
  if (cached !== undefined) return cached;
  const view = parseCommitUncached(data);
  COMMIT_CACHE.set(data, view);
  return view;
}

/** The uncached commit parse (see parseCommit). */
function parseCommitUncached(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** The default identity the forge's own commits carry, so bytes are reproducible. */
export const FORGE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- packfiles

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = Buffer.from(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = zlibInflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.from(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
  readonly count: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out. Every object's SHA-1 is recomputed
 * and its declared size checked; a mismatch is an error.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const checksumOk = trailer === packChecksum(buffer);

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
  }

  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack is truncated in its object list');
    let byte = buffer[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack object header is truncated');
      byte = buffer[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: base offset encoded as (offset - baseOffset) in the git variable form.
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buffer[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buffer[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base object id.
      if (offset + 20 > trailerStart) throw new Error('ref-delta has no base object id');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buffer, offset);
    entry.data = inflated.data;
    offset = inflated.next;
    if (entry.data.length !== size) {
      throw new Error(`pack object at ${entryOffset} declares ${size} bytes, inflated ${entry.data.length}`);
    }
    raw.push(entry);
  }

  // Resolve deltas. Deltas may chain; resolve iteratively (a base always precedes its delta in
  // a well-formed pack, but chains are resolved in passes to be safe).
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  const resolveOne = (entry: RawEntry, depth: number): { type: GitObjectType; data: Buffer } => {
    if (depth > 100) throw new Error('delta chain is too deep');
    if (entry.resolved !== undefined && entry.resolvedType !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved };
    }
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = CODE_TYPE[entry.typeCode] as GitObjectType;
      entry.resolvedType = type;
      entry.resolved = entry.data;
      return { type, data: entry.data };
    }
    let base: { type: GitObjectType; data: Buffer } | undefined;
    if (entry.baseOffset !== undefined) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      base = resolveOne(baseEntry, depth + 1);
    } else if (entry.baseOid !== undefined) {
      const inPack = [...raw].find((candidate) => {
        if (candidate.resolvedType === undefined || candidate.resolved === undefined) return false;
        return hashObject(candidate.resolvedType, candidate.resolved) === entry.baseOid;
      });
      if (inPack !== undefined) {
        base = resolveOne(inPack, depth + 1);
      } else if (options.resolveBase !== undefined) {
        const external = options.resolveBase(entry.baseOid);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available (thin pack)`);
        base = { type: external.type, data: external.data };
      } else {
        throw new Error(`ref-delta base ${entry.baseOid} is not in the pack (thin pack)`);
      }
    } else {
      throw new Error(`pack object at ${entry.offset} has unknown type code ${entry.typeCode}`);
    }
    const resolved = applyDelta(base.data, entry.data);
    entry.resolvedType = base.type;
    entry.resolved = resolved;
    return { type: base.type, data: resolved };
  };

  for (const entry of raw) {
    const { type, data } = resolveOne(entry, 0);
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
  }
  return { objects, checksumOk, count: declaredCount };
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's; git does not require
 * a particular order. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    // Level 1: the client only inflates and checks the pack checksum, so the
    // fastest valid zlib stream wins over the smallest one.
    parts.push(deflateSync(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks skipped),
 * tag → its target, blob → nothing. Throws on a missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The objects a shallow fetch sends for one commit: the commit itself plus its whole tree closure, never its parents. */
export function collectTreeClosure(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      stack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The objects reachable from `newTips` that a server holding `serverTips` does not have. */
export function objectsToSend(
  lookup: ObjectLookup,
  serverTips: Iterable<string>,
  newTips: Iterable<string>,
): GitObject[] {
  const onServer = collectReachable(serverTips, lookup, { allowMissing: true });
  const wanted = collectReachable(newTips, lookup);
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (onServer.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) send.push(object);
  }
  return send;
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: Uint8Array | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length + 4;
  const header = Buffer.allocUnsafe(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** A flush packet: `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** A delimiter packet: `0001` (protocol v2). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** A response-end packet: `0002` (protocol v2). */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktLineItem =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Parse a buffer of pkt-lines. Returns the items and how many bytes were consumed; a trailing
 * incomplete line leaves `consumed` short of the buffer length (the caller waits for more bytes).
 */
export function parsePktLines(buffer: Buffer): { items: PktLineItem[]; consumed: number } {
  const items: PktLineItem[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(hex, 16);
    if (Number.isNaN(length)) throw new Error(`pkt-line has a bad length ${JSON.stringify(hex)}`);
    if (length === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4) throw new Error(`pkt-line length ${length} is below 4`);
    if (offset + length > buffer.length) break; // incomplete: wait for more bytes
    items.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, consumed: offset };
}

/** The side-band-64k channel of one byte: 1 = data, 2 = progress, 3 = error. */
export function sideBandFrame(channel: 1 | 2 | 3, payload: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from([channel]), Buffer.from(payload)]);
  return pktLine(body);
}
