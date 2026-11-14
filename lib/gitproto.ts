// gitproto.ts — the git smart-HTTP surface: advertisement, ls-refs, fetch, push.
//
// Protocol choice (from specs/git-wire.md + specs/git-checks.md): upload-pack always
// answers protocol v2 (the checks drive it with `Git-Protocol: version=2`, and a v2
// answer is also tolerated for the one v0 info/refs probe in `git.advertise-headers`);
// receive-pack is v0-only, because the push client throws `push-protocol` otherwise.
// A v0 upload-pack fetch is never requested by any check, so a non-v2 upload-pack POST
// is answered 400 instead of served.
//
// Packs are delta-free by design: every object the client needs is sent whole, in oid
// order, so `readPack` on the client side never has to resolve a delta and a fresh
// clone can never hit `pack-delta-base`. Reachability is computed with git.ts
// `collectReachable`, which is the same walk the client uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  collectTreeClosure,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sideBandFrame,
  writePack,
  ZERO_OID,
  type GitObject,
  type PktLineItem,
} from './git.ts';
import { readBody, sendJson } from './http.ts';
import { DEFAULT_BRANCH, Store } from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** The capabilities the v2 upload-pack advertisement carries. */
const V2_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ['fetch', 'shallow filter'],
  ['ls-refs', 'unborn'],
  ['object-format', 'sha1'],
  ['agent', 'github-core-clone/1.0.0'],
];

/** The capability tokens the v0 receive-pack advertisement carries (first ref line). */
const RECEIVE_CAPABILITIES = 'report-status side-band-64k delete-refs ofs-delta agent symref=HEAD:refs/heads/main';

/** One sideband data packet carries at most this many channel bytes (65516 - 1 band byte). */
const SIDEBAND_MAX = 65515;

/** A request is malformed when the pkt-line framing cannot be read at all. */
class Malformed extends Error {}

/**
 * Read one pkt-line at `offset` of `buffer`. Returns the item and the offset just past
 * it; a data item's `data` is the payload without its 4-byte header. Throws Malformed
 * on a bad header or a truncated line — the whole HTTP body is already in hand, so an
 * incomplete line is malformed, not "wait for more bytes".
 */
function readPktLineAt(buffer: Buffer, offset: number): { item: PktLineItem; next: number } {
  if (offset + 4 > buffer.length) throw new Malformed('truncated pkt-line');
  const hex = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Malformed(`bad pkt-line length ${JSON.stringify(hex)}`);
  const length = parseInt(hex, 16);
  if (length === 0) return { item: { kind: 'flush' }, next: offset + 4 };
  if (length === 1) return { item: { kind: 'delim' }, next: offset + 4 };
  if (length === 2) return { item: { kind: 'response-end' }, next: offset + 4 };
  if (length < 4 || length > 65520) throw new Malformed(`pkt-line length ${length} is out of range`);
  if (offset + length > buffer.length) throw new Malformed('truncated pkt-line');
  return { item: { kind: 'data', data: buffer.subarray(offset + 4, offset + length) }, next: offset + length };
}

/**
 * The data payloads of one pkt-line section: up to (not including) the first delim
 * (`0001`, the v2 command/argument split) or flush (`0000`, the section end). Returns
 * the lines, the offset just past the terminator, and which terminator ended it.
 */
function readSection(buffer: Buffer, start: number): { lines: Buffer[]; after: number; terminator: 'delim' | 'flush' } {
  const lines: Buffer[] = [];
  let offset = start;
  for (;;) {
    const { item, next } = readPktLineAt(buffer, offset);
    if (item.kind === 'flush') return { lines, after: next, terminator: 'flush' };
    if (item.kind === 'delim') return { lines, after: next, terminator: 'delim' };
    if (item.kind === 'data') lines.push(item.data);
    // A response-end packet inside a request section is ignored.
    offset = next;
  }
}

/** The text of pkt-line payloads, each with exactly one trailing LF stripped. */
function textLines(lines: readonly Buffer[]): string[] {
  return lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
}

/** Split `bytes` into sideband band-1 frames, each within the pkt-line size limit. */
function sidebandPack(bytes: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += SIDEBAND_MAX) {
    frames.push(sideBandFrame(1, bytes.subarray(offset, Math.min(bytes.length, offset + SIDEBAND_MAX))));
  }
  if (frames.length === 0) frames.push(sideBandFrame(1, Buffer.alloc(0)));
  return frames;
}

/** The peeled (target) commit of an annotated tag object, or null when it is not a tag. */
function peelTag(repoObjects: ReadonlyMap<string, GitObject>, oid: string): string | null {
  const object = repoObjects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ------------------------------------------------------------ advertisements

/** GET info/refs for upload-pack: preamble + `version 2` + capability lines. */
function uploadPackAdvertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
  for (const [key, value] of V2_CAPABILITIES) parts.push(pktLine(`${key}=${value}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * GET info/refs for receive-pack: a v0 advertisement. First line is HEAD carrying the
 * capabilities after NUL (or the `capabilities^{}` pseudo-ref when the repo is empty),
 * then one line per ref, then peeled `^{}` lines for annotated tags.
 */
function receivePackAdvertisement(store: Store, repo: Parameters<Store['listRefs']>[0]): Buffer {
  const refs = store.listRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPABILITIES}\n`));
  } else {
    const mainTip = store.getRef(repo, `refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\0${RECEIVE_CAPABILITIES}\n`));
    for (const { ref, oid } of refs) parts.push(pktLine(`${oid} ${ref}\n`));
    for (const { ref, oid } of refs) {
      const peeled = peelTag(repo.objects, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/**
 * POST git-upload-pack `command=ls-refs`. Answers one line per ref (HEAD first when it
 * exists), honouring `peel` / `symrefs` / `unborn` / `ref-prefix` — the prefix filter is
 * applied server-side, because `git.ls-refs-prefix` judges the raw refs sent.
 */
function lsRefs(store: Store, repo: Parameters<Store['listRefs']>[0], body: Buffer): Buffer {
  const command = readSection(body, 0);
  const commandText = textLines(command.lines);
  if (commandText[0] !== 'command=ls-refs') throw new Malformed('expected command=ls-refs');
  const argsLines = readSection(body, command.after).lines;
  const args = parseLsRefsArgs(textLines(argsLines));
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));

  const out: Buffer[] = [];
  const mainTip = store.getRef(repo, `refs/heads/${DEFAULT_BRANCH}`);
  if (mainTip !== undefined) {
    if (matches('HEAD')) {
      out.push(pktLine(args.symrefs ? `${mainTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : `${mainTip} HEAD\n`));
    }
  } else if (args.unborn && matches('HEAD')) {
    out.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
  }
  for (const { ref, oid } of store.listRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelTag(repo.objects, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ------------------------------------------------------------ fetch (v2)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
  }
  // Deduped preserving order, as the client does.
  args.wants = [...new Set(args.wants)];
  return args;
}

/** Distances (in parent hops) from the nearest want, for commits reachable from `wants`. */
function commitDistances(repo: Parameters<Store['listRefs']>[0], wants: readonly string[]): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const push = (oid: string, dist: number): void => {
    if (oid === ZERO_OID || distances.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    if (object.type === 'tag') {
      // A wanted tag counts at the distance of its target commit.
      distances.set(oid, dist);
      push(parseTag(object.data).object, dist);
      return;
    }
    if (object.type !== 'commit') return;
    distances.set(oid, dist);
    queue.push({ oid, dist });
  };
  for (const want of wants) push(want, 0);
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) push(parent, dist + 1);
  }
  return distances;
}

/**
 * The objects a fetch sends, and the shallow-info lines it reports. With no depth the
 * set is `reachable(wants) - reachable(haves)`; with `deepen N` it is the depth-N
 * prefix of the wanted history, minus what the client already holds, and the boundary
 * commits (distance N-1, with parents cut off) are reported `shallow`, while old
 * boundaries whose parents are now included are reported `unshallow`.
 */
function fetchSelection(
  store: Store,
  repo: Parameters<Store['listRefs']>[0],
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  if (args.depth === null) {
    const held = collectReachable(args.haves, store.lookup(repo), { allowMissing: true });
    const wanted = collectReachable(args.wants, store.lookup(repo), { allowMissing: true });
    const objects: GitObject[] = [];
    for (const oid of [...wanted].sort()) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    return { objects, shallow: [], unshallow: [] };
  }

  const depth = Math.max(1, args.depth);
  const distances = commitDistances(repo, args.wants);
  const included = new Set<string>();
  for (const [oid, dist] of distances) {
    if (dist < depth) included.add(oid);
  }
  // With a depth limit the client's haves are shallow boundaries: it holds each
  // have's own tree closure, not its ancestors (a deepen must deliver the parent
  // of a boundary it already has). Full-history haves only apply without depth.
  const held = new Set<string>();
  for (const have of args.haves) {
    for (const reachable of collectTreeClosure([have], store.lookup(repo), { allowMissing: true })) held.add(reachable);
  }
  // Every included commit contributes its own tree closure only — never its parents,
  // or a depth-1 fetch would carry the whole history.
  const wanted = new Set<string>();
  for (const oid of included) {
    for (const reachable of collectTreeClosure([oid], store.lookup(repo), { allowMissing: true })) wanted.add(reachable);
  }
  // A wanted tag whose target commit is included travels with it.
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag' && included.has(parseTag(object.data).object)) wanted.add(want);
  }
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Boundary: an included commit at distance depth-1 that still has a parent.
  const shallow: string[] = [];
  for (const [oid, dist] of distances) {
    if (dist !== depth - 1 || !included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
  }
  // Unshallow: an old boundary whose parents are all included now.
  const unshallow: string[] = [];
  for (const boundary of args.shallow) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** POST git-upload-pack `command=fetch` (v2): sections + a sideband-framed pack. */
function fetchV2(store: Store, repo: Parameters<Store['listRefs']>[0], body: Buffer): Buffer {
  const command = readSection(body, 0);
  const commandText = textLines(command.lines);
  if (commandText[0] !== 'command=fetch') throw new Malformed('expected command=fetch');
  const argsLines = readSection(body, command.after).lines;
  const args = parseFetchArgs(textLines(argsLines));
  for (const oid of [...args.wants, ...args.haves, ...args.shallow]) {
    if (!isObjectId(oid)) throw new Malformed(`not an object id: ${oid}`);
  }
  if (Number.isNaN(args.depth)) throw new Malformed('deepen is not a number');

  const { objects, shallow, unshallow } = fetchSelection(store, repo, args);
  const pack = writePack(objects);

  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ push (receive-pack)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command section of a receive-pack body; returns commands, caps, pack offset. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; capabilities: string[]; packStart: number } {
  const section = readSection(body, 0);
  if (section.terminator !== 'flush') throw new Malformed('push command list has no flush');
  const lines = section.lines;
  const afterFlush = section.after;
  let capabilities: string[] = [];
  const commands: PushCommand[] = [];
  lines.forEach((line, index) => {
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const head = (nul === -1 ? text : text.slice(0, nul)).replace(/\n$/, '');
    if (nul !== -1 && index === 0) capabilities = text.slice(nul + 1).replace(/\n$/, '').split(' ').filter((token) => token !== '');
    const parts = head.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string) || !(parts[2] as string).startsWith('refs/')) {
      throw new Malformed(`bad push command line: ${JSON.stringify(head)}`);
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  });
  if (commands.length === 0) throw new Malformed('push with no commands');
  return { commands, capabilities, packStart: afterFlush };
}

/**
 * POST git-receive-pack. Unpacks the pack first (a refused ref still unpacks ok),
 * then judges each command in order: create / fast-forward / delete apply, anything
 * else is `ng <ref> non-fast-forward` and leaves the ref untouched.
 */
function receivePack(store: Store, repo: Parameters<Store['listRefs']>[0], body: Buffer): Buffer {
  const { commands, capabilities, packStart } = parsePushCommands(body);
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = body.subarray(packStart);

  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const object of parsed.objects.values()) store.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackDetail = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
  }

  const report: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    const current = store.getRef(repo, command.ref);
    if (unpackDetail !== 'ok') {
      report.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push(`ng ${command.ref} remote ref does not exist`);
      else if (current !== command.oldOid) report.push(`ng ${command.ref} non-fast-forward`);
      else {
        store.deleteRef(repo, command.ref);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists`);
      } else if (store.getObject(repo, command.newOid) === undefined) {
        report.push(`ng ${command.ref} missing object`);
      } else {
        store.setRef(repo, command.ref, command.newOid);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update: old must be the current tip and new a descendant of old.
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else if (store.getObject(repo, command.newOid) === undefined) {
      report.push(`ng ${command.ref} missing object`);
    } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
    } else {
      store.setRef(repo, command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    }
  }

  const reportBytes = Buffer.concat(report.map((line) => pktLine(`${line}\n`)));
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < reportBytes.length; offset += SIDEBAND_MAX) {
      parts.push(sideBandFrame(1, reportBytes.subarray(offset, Math.min(reportBytes.length, offset + SIDEBAND_MAX))));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  return Buffer.concat([reportBytes, pktFlush()]);
}

// ------------------------------------------------------------ routing
//
// app.ts owns the auth gate (every non-/healthz request must carry the trial's
// bearer token) and calls this handler with the owner/repo already split out of
// the path, plus the per-request id for the X-GitHub-Request-Id header.

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** A JSON reply carrying this request's id (the REST protocol checks require it). */
function reply(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  sendJson(res, status, body, { 'x-github-request-id': requestId });
}

/**
 * Handle one git smart-HTTP request. `rest` is the path after `<owner>/<repo>.git`:
 * `/info/refs`, `/git-upload-pack`, or `/git-receive-pack`.
 */
export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rest: string,
  requestId: string,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);

  if (req.method === 'GET' && rest === '/info/refs') {
    const query = new URL(req.url ?? '/', 'http://entry').searchParams;
    const service = query.get('service');
    if (repo === undefined) {
      reply(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    if (service === 'git-upload-pack') {
      sendGit(res, 200, UPLOAD_AD_CT, uploadPackAdvertisement(), requestId);
    } else if (service === 'git-receive-pack') {
      sendGit(res, 200, RECEIVE_AD_CT, receivePackAdvertisement(store, repo), requestId);
    } else {
      reply(res, 400, { message: 'unknown service' }, requestId);
    }
    return;
  }

  if (req.method === 'POST' && rest === '/git-upload-pack') {
    if (repo === undefined) {
      reply(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    try {
      const body = await readBody(req);
      const first = textLines(readSection(body, 0).lines)[0] ?? '';
      let out: Buffer;
      if (first === 'command=ls-refs') out = lsRefs(store, repo, body);
      else if (first === 'command=fetch') out = fetchV2(store, repo, body);
      else throw new Malformed(`unsupported upload-pack command: ${JSON.stringify(first)}`);
      sendGit(res, 200, UPLOAD_RESULT_CT, out, requestId);
    } catch (err) {
      reply(res, 400, { message: err instanceof Error ? err.message : 'bad request' }, requestId);
    }
    return;
  }

  if (req.method === 'POST' && rest === '/git-receive-pack') {
    if (repo === undefined) {
      reply(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    try {
      const body = await readBody(req);
      const out = receivePack(store, repo, body);
      sendGit(res, 200, RECEIVE_RESULT_CT, out, requestId);
    } catch (err) {
      reply(res, 400, { message: err instanceof Error ? err.message : 'bad request' }, requestId);
    }
    return;
  }

  reply(res, 404, { message: 'Not Found' }, requestId);
}
