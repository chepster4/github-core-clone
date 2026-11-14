// store.ts — the forge's whole state, in memory, deterministic.
// No wall clock anywhere: every timestamp comes from a monotonic sequence counter, so two
// runs that receive the same requests in the same order leave byte-identical state.
// The token owner is the scenario's viewer, derived from the kit's fixed SCENARIO_SEED
// (verified against the kit's own buildScenario(): viewer 'adaiversen', id 1000).

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
  ZERO_OID,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';

/** The scenario's day one: every generated timestamp is this plus a sequence offset. */
export const EPOCH_SEC = 1735689600;
/** The base timestamp the forge's own commits carry, plus a sequence offset. */
export const COMMIT_EPOCH_SEC = 1700000000;

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export const VIEWER: User = Object.freeze({
  id: VIEWER_ID,
  login: VIEWER_LOGIN,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly user: User;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly user: User;
  comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
  /** Creation order, for CREATED_AT ordering (ties break by number). */
  readonly seq: number;
}

export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PullState = 'open' | 'closed';

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergeable: MergeableState;
  head: string;
  base: string;
  headSha: string | null;
  baseSha: string | null;
  mergeCommitSha: string | null;
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  readonly createdAt: string;
  readonly seq: number;
}

/** The forge's whole store. One instance per process; the server never writes to disk. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  /** The deterministic clock: every timestamp derives from this counter. */
  private seq = 0;

  /** The next sequence value, for ordering and timestamps. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp for sequence value `seq`. */
  isoAt(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** A commit timestamp (unix seconds) for sequence value `seq`. */
  commitTimeAt(seq: number): number {
    return COMMIT_EPOCH_SEC + seq;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}): Repo | null {
    const key = Store.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description: options.description ?? '',
      private: options.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: this.isoAt(seq),
      seq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repo only when `owner` is the token owner; any other owner is a 404, never a 403. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(Store.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(Store.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
    return oid;
  }

  /** Store an object whose oid is already known (a pack read just hashed it): no second SHA-1. */
  putObjectKnown(repo: Repo, oid: string, type: GitObjectType, data: Uint8Array): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs, sorted by name (the ls-refs order). */
  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    return [...repo.refs.entries()].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  /** The tip commit of a branch, or null when the branch has no commit yet. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(this.refName(branch)) ?? null;
  }

  /** The tree of a commit, or null when the commit is unknown. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** True when `ancestor` is reachable from `oid` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    if (ancestor === ZERO_OID) return true;
    // Walk parents from `oid` and stop the moment `ancestor` is seen: a
    // fast-forward push's parent IS the old tip, so this is one commit parse
    // instead of a walk over the whole history. Only a true non-ancestor
    // walks the full reachable set, exactly as before.
    const seen = new Set<string>();
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current) || current === ZERO_OID) continue;
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The merge base of two commits: the first common ancestor found walking both histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = collectReachable([a], this.lookup(repo), { allowMissing: true });
    // Walk b's ancestry breadth-first (parents before grandparents) for the nearest common one.
    // An index pointer, not shift(): shifting a 200-long queue per step is quadratic.
    const queue: string[] = [b];
    let head = 0;
    const seen = new Set<string>();
    while (head < queue.length) {
      const oid = queue[head++] as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return null;
  }

  // ------------------------------------------------------------- trees & paths

  /** Read one path from a tree (recursive). Returns the entry or null. */
  readPath(repo: Repo, treeOid: string, path: string): TreeEntry | null {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) return null;
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The blob bytes at a path in a tree, or null when absent / not a file. */
  readBlobAt(repo: Repo, treeOid: string, path: string): Buffer | null {
    const entry = this.readPath(repo, treeOid, path);
    if (entry === null || entry.mode === '40000') return null;
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return object.data;
  }

  /**
   * A new tree with `path` set to `blobOid` (or removed when `blobOid` is null), built on
   * `baseTreeOid` (null = an empty tree). Returns the new tree's oid.
   */
  writePath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) throw new Error('a path needs at least one segment');
    const rewrite = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = parts[depth] as string;
      const last = depth === parts.length - 1;
      const next: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        replaced = true;
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
          // else: dropped (deleted)
        } else if (blobOid !== null) {
          const child = rewrite(entry.oid, depth + 1);
          next.push({ mode: '40000', name, oid: child });
        }
        // else: deleting a path under a directory removes the whole subtree entry
      }
      if (!replaced) {
        if (blobOid === null) return treeOid ?? this.putObject(repo, 'tree', buildTree([]));
        if (last) {
          next.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = rewrite(null, depth + 1);
          next.push({ mode: '40000', name, oid: child });
        }
      }
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return rewrite(baseTreeOid, 0);
  }

  /** All file paths in a tree (recursive), as `path -> blob oid`. */
  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (current: string, prefix: string): void => {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Paths that differ between two trees (added, removed or changed). */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): string[] {
    const base = baseTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, headTreeOid);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const changed: string[] = [];
    for (const path of paths) {
      if (base.get(path) !== head.get(path)) changed.push(path);
    }
    return changed.sort();
  }

  // ------------------------------------------------------------- commits

  /** Create a commit object on a branch (fast-forward only when the caller checks it). */
  commitOnBranch(
    repo: Repo,
    branch: string,
    options: { message: string; tree: string; parents: string[]; author?: string; committer?: string },
  ): string {
    const seq = this.tick();
    const commit = buildCommit({
      tree: options.tree,
      parents: options.parents,
      message: options.message,
      author: options.author,
      committer: options.committer,
      timestamp: this.commitTimeAt(seq),
    });
    const oid = this.putObject(repo, 'commit', commit);
    this.setRef(repo, this.refName(branch), oid);
    return oid;
  }

  /**
   * The three-way merge of `baseTree`, `headTree` onto `mergeBaseTree`, at file granularity.
   * Returns the merged tree oid, or null when the same path changed differently on both sides.
   */
  threeWayMerge(
    repo: Repo,
    mergeBaseTreeOid: string | null,
    baseTreeOid: string | null,
    headTreeOid: string | null,
  ): string | null {
    const base = mergeBaseTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, mergeBaseTreeOid);
    const ours = baseTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, baseTreeOid);
    const theirs = headTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, headTreeOid);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, string>();
    for (const path of paths) {
      const ancestor = base.get(path);
      const our = ours.get(path);
      const their = theirs.get(path);
      if (our === their) {
        if (our !== undefined) merged.set(path, our);
      } else if (ancestor === our) {
        if (their !== undefined) merged.set(path, their);
      } else if (ancestor === their) {
        if (our !== undefined) merged.set(path, our);
      } else {
        return null; // both sides changed the same path differently: a real conflict
      }
    }
    // Rebuild nested trees from the flat map.
    let treeOid: string | null = null;
    for (const [path, oid] of [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      treeOid = this.writePath(repo, treeOid, path, oid);
    }
    return treeOid ?? this.putObject(repo, 'tree', buildTree([]));
  }

  // ------------------------------------------------------------- issues & pulls

  createIssue(repo: Repo, fields: { title: string; body?: string; labels?: string[] }): Issue {
    const seq = this.tick();
    const at = this.isoAt(seq);
    const issue: Issue = {
      number: repo.nextNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: [...(fields.labels ?? [])],
      user: VIEWER,
      comments: [],
      createdAt: at,
      updatedAt: at,
      seq,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    fields: { title: string; body?: string; head: string; base: string },
  ): PullRequest {
    const seq = this.tick();
    const at = this.isoAt(seq);
    const pull: PullRequest = {
      number: repo.nextNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      mergeable: 'UNKNOWN',
      head: fields.head,
      base: fields.base,
      headSha: this.branchTip(repo, fields.head),
      baseSha: this.branchTip(repo, fields.base),
      mergeCommitSha: null,
      user: VIEWER,
      createdAt: at,
      updatedAt: at,
      seq,
    };
    pull.mergeable = this.computeMergeable(repo, pull);
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** A PR's mergeability, from the git state: fast-forward or a clean three-way merge. */
  computeMergeable(repo: Repo, pull: PullRequest): MergeableState {
    const headSha = this.branchTip(repo, pull.head);
    const baseSha = this.branchTip(repo, pull.base);
    if (headSha === null || baseSha === null) return 'UNKNOWN';
    if (headSha === baseSha) return 'MERGEABLE';
    if (this.isAncestor(repo, baseSha, headSha)) return 'MERGEABLE';
    const base = this.mergeBase(repo, baseSha, headSha);
    if (base === null) return 'CONFLICTING';
    const baseTree = this.commitTree(repo, base);
    const oursTree = this.commitTree(repo, baseSha);
    const theirsTree = this.commitTree(repo, headSha);
    if (baseTree === null || oursTree === null || theirsTree === null) return 'UNKNOWN';
    return this.threeWayMerge(repo, baseTree, oursTree, theirsTree) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a PR: one commit on the base branch with the merged tree. Returns its oid or null. */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    const headSha = this.branchTip(repo, pull.head);
    const baseSha = this.branchTip(repo, pull.base);
    if (headSha === null || baseSha === null) return null;
    const base = this.mergeBase(repo, baseSha, headSha);
    let mergedTree: string | null;
    if (this.isAncestor(repo, baseSha, headSha)) {
      // Fast-forward: the squash commit just carries the head tree.
      mergedTree = this.commitTree(repo, headSha);
    } else {
      if (base === null) return null;
      mergedTree = this.threeWayMerge(
        repo,
        this.commitTree(repo, base),
        this.commitTree(repo, baseSha),
        this.commitTree(repo, headSha),
      );
    }
    if (mergedTree === null) return null;
    const seq = this.tick();
    const commit = buildCommit({
      tree: mergedTree,
      parents: [baseSha],
      message: `${pull.title} (#${pull.number})\n`,
      timestamp: this.commitTimeAt(seq),
    });
    const oid = this.putObject(repo, 'commit', commit);
    this.setRef(repo, this.refName(pull.base), oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = oid;
    pull.updatedAt = this.isoAt(seq);
    return oid;
  }
}
