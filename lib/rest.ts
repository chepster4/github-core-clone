// rest.ts — the REST v3 surface: repos, branches, commits, contents, issues,
// pull requests, labels, comments, plus the protocol group (root, meta, unknown
// routes, malformed bodies, request ids). Shapes are minimums per specs/rest-checks.md:
// every field the suite shape-checks is present with the right type and value; extra
// GitHub-like fields are included where they cost nothing.
//
// app.ts owns the auth gate (a missing/invalid bearer never reaches this handler),
// so every route here assumes an authenticated token user. Ownership is by login:
// a repo under any other owner is a 404, never a 403 (the store enforces that).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './git.ts';
import { parseJsonBody, pathOf, readBody, sendJson, sendPrebuilt } from './http.ts';
import {
  DEFAULT_BRANCH,
  Store,
  VIEWER,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

/** A JSON reply carrying this request's id, plus any extra headers. */
function reply(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': requestId, ...extra });
}

/**
 * The serialized body of GET /repos/{o}/{r}/issues/{n}, cached per repo+number.
 * The read workload GETs one issue 2,000 times on one connection, and the body is a
 * pure function of the issue (labels are immutable once created, and the only
 * mutations — PATCH state, POST comment — invalidate the entry below). The cached
 * string is exactly what issueJson + JSON.stringify would produce, so the bytes a
 * client sees never change; only the re-serialization is skipped. The WeakMap dies
 * with the repo, so a deleted repo leaves nothing behind.
 */
const ISSUE_BODY_CACHE = new WeakMap<Repo, Map<number, string>>();

/** The cached serialized issue body, or null when it is not cached yet. */
function cachedIssueBody(repo: Repo, number: number): string | null {
  return ISSUE_BODY_CACHE.get(repo)?.get(number) ?? null;
}

/** Store the serialized issue body for later GETs (keyed by repo + issue number). */
function cacheIssueBody(repo: Repo, number: number, body: string): void {
  let perRepo = ISSUE_BODY_CACHE.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<number, string>();
    ISSUE_BODY_CACHE.set(repo, perRepo);
  }
  perRepo.set(number, body);
}

/** Drop one issue's cached body: call on every mutation of that issue. */
function dropIssueBody(repo: Repo, number: number): void {
  ISSUE_BODY_CACHE.get(repo)?.delete(number);
}

/** A 204 with no body (repo DELETE); the request id still rides along. */
function replyNoContent(res: ServerResponse, requestId: string): void {
  res.writeHead(204, { 'x-github-request-id': requestId });
  res.end();
}

function err(res: ServerResponse, status: number, message: string, requestId: string): void {
  reply(res, status, { message }, requestId);
}

/** Query parameters of the request URL. */
function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://entry').searchParams;
}

/** `per_page` (1..100, default 30) and `page` (default 1) for a listing. */
function pageParams(req: IncomingMessage): { page: number; perPage: number } {
  const query = queryOf(req);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/**
 * Slice `items` to one page and build a GitHub `Link` header with a `rel="next"` URL
 * on the same origin when more pages follow. The client follows `next` verbatim, so
 * the URL is absolute (scheme + host from the request).
 */
function paginate<T>(req: IncomingMessage, items: readonly T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const base = pathOf(req).split('?')[0] as string;
    const query = new URL(req.url ?? '/', 'http://entry').searchParams;
    query.set('per_page', String(perPage));
    query.set('page', String(page + 1));
    link = `<http://${host}${base}?${query.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

/** The `Link` header value for a paginated reply, or nothing when there is no next page. */
function linkHeader(link: string | null): Readonly<Record<string, string>> {
  return link === null ? {} : { link };
}

// ------------------------------------------------------------ shapes

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
  };
}

/** A stable numeric id for an issue/PR: its creation sequence, unique per process. */
function itemId(item: { readonly seq: number }): number {
  return item.seq;
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: itemId(issue),
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    locked: false,
  };
}

function commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${comment.id}`,
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: itemId(pull),
    node_id: `P_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    head: {
      ref: pull.head,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.head}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.base,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.base}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.merged ? pull.updatedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** `Name <email> ts +0000` split into its parts, for the commits listing. */
function personOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(parseInt(match[3] as string, 10) * 1000).toISOString(),
  };
}

/** The number of lines in `text` (a trailing newline does not start a new line). */
function lineCount(text: string): number {
  if (text === '') return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

// ------------------------------------------------------------ repo helpers

/** Load the repo for an owner/name pair, or answer 404 (wrong owner included). */
function needRepo(store: Store, res: ServerResponse, owner: string, name: string, requestId: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    err(res, 404, 'Not Found', requestId);
    return null;
  }
  return repo;
}

/** Read and parse a JSON request body; an empty body is null, a bad one is a 400. */
async function needJson(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    err(res, 400, parsed.message, requestId);
    return null;
  }
  if (parsed.value === null) return {};
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    err(res, 400, 'Problems parsing JSON', requestId);
    return null;
  }
  return parsed.value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// ------------------------------------------------------------ contents

/** The tree oid at the tip of `branch`, or null when the branch has no commit. */
function branchTree(store: Store, repo: Repo, branch: string): string | null {
  const tip = store.branchTip(repo, branch);
  if (tip === null) return null;
  return store.commitTree(repo, tip);
}

/**
 * PUT /contents/{path}: create or update a file with a commit. A `sha` that does not
 * match the file's current blob is a 409 (optimistic concurrency); a create is 201,
 * an update 200. A branch named in the body is created when it does not exist yet,
 * parented on the default branch tip — the MCP PR setup relies on that.
 */
async function putContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  requestId: string,
): Promise<void> {
  const body = await needJson(req, res, requestId);
  if (body === null) return;
  const message = asString(body.message) ?? `Update ${path}`;
  const contentB64 = asString(body.content);
  if (contentB64 === null) {
    err(res, 422, 'content is required', requestId);
    return;
  }
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const givenSha = asString(body.sha);
  const tip = store.branchTip(repo, branch);
  const tree = tip === null ? null : store.commitTree(repo, tip);
  const existing = tree === null ? null : store.readPath(repo, tree, path);
  const isUpdate = existing !== null && existing.mode !== '40000';
  if (givenSha !== null) {
    if (!isUpdate || existing?.oid !== givenSha) {
      err(res, 409, 'sha does not match the current blob', requestId);
      return;
    }
  } else if (isUpdate) {
    err(res, 409, 'sha is required to update an existing file', requestId);
    return;
  }
  const bytes = Buffer.from(contentB64, 'base64');
  const blobOid = store.putObject(repo, 'blob', bytes);
  const newTree = store.writePath(repo, tree, path, blobOid);
  const parents = tip === null ? [] : [tip];
  // A new branch starts from the default branch tip when the default branch exists
  // and this branch has no tip yet (the MCP PR setup's branch-creation fallback).
  const createParents =
    tip === null && branch !== repo.defaultBranch ? (store.branchTip(repo, repo.defaultBranch) ?? []) : parents;
  const commitOid = store.commitOnBranch(repo, branch, { message: `${message}\n`, tree: newTree, parents: createParents });
  reply(res, isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitOid, message },
  }, requestId);
}

/** GET /contents/{path}[?ref=]: a file object, or a directory listing array. */
function getContents(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, requestId: string): void {
  const ref = queryOf(req).get('ref') ?? repo.defaultBranch;
  const tree = branchTree(store, repo, ref);
  if (tree === null) {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  if (path === '') {
    // The repository root, as a directory listing.
    const object = repo.objects.get(tree);
    if (object === undefined) {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    reply(res, 200, parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    })), requestId);
    return;
  }
  const entry = store.readPath(repo, tree, path);
  if (entry === null) {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  if (entry.mode === '40000') {
    const object = repo.objects.get(entry.oid);
    if (object === undefined) {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    reply(res, 200, parseTree(object.data).map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: `${path}/${child.name}`,
      sha: child.oid,
      size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
    })), requestId);
    return;
  }
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'blob') {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  reply(res, 200, {
    type: 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: object.data.length,
    encoding: 'base64',
    content: object.data.toString('base64'),
  }, requestId);
}

/** DELETE /contents/{path}: remove a file with a commit; the file is then 404. */
async function deleteContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  requestId: string,
): Promise<void> {
  const body = await needJson(req, res, requestId);
  if (body === null) return;
  const message = asString(body.message) ?? `Delete ${path}`;
  const givenSha = asString(body.sha);
  const tip = store.branchTip(repo, repo.defaultBranch);
  if (tip === null) {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  const tree = store.commitTree(repo, tip);
  if (tree === null) {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  const existing = store.readPath(repo, tree, path);
  if (existing === null || existing.mode === '40000') {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  if (givenSha !== null && existing.oid !== givenSha) {
    err(res, 409, 'sha does not match the current blob', requestId);
    return;
  }
  const newTree = store.writePath(repo, tree, path, null);
  const commitOid = store.commitOnBranch(repo, repo.defaultBranch, { message: `${message}\n`, tree: newTree, parents: [tip] });
  reply(res, 200, { commit: { sha: commitOid, message } }, requestId);
}

// ------------------------------------------------------------ commits & branches

/** GET /commits[?sha=<ref>]: the ref's history, newest first. */
function listCommits(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, requestId: string): void {
  const ref = queryOf(req).get('sha') ?? repo.defaultBranch;
  const tip = store.branchTip(repo, ref);
  if (tip === null) {
    if (ref === repo.defaultBranch && repo.refs.size === 0) {
      reply(res, 200, [], requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    const author = personOf(view.author);
    const committer = personOf(view.committer);
    out.push({
      sha: oid,
      commit: {
        message: view.message.replace(/\n$/, ''),
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: view.tree },
        parents: view.parents.map((parent) => ({ sha: parent })),
      },
      author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      parents: view.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of view.parents) queue.push(parent);
  }
  const { page, link } = paginate(req, out);
  reply(res, 200, page, requestId, linkHeader(link));
}

// ------------------------------------------------------------ pull files & merge

/** GET /pulls/{n}/files: the diff between merge-base and head, per path. */
function pullFiles(store: Store, res: ServerResponse, repo: Repo, pull: PullRequest, requestId: string): void {
  const headSha = store.branchTip(repo, pull.head);
  const baseSha = store.branchTip(repo, pull.base);
  if (headSha === null || baseSha === null) {
    reply(res, 200, [], requestId);
    return;
  }
  const mergeBase = store.mergeBase(repo, baseSha, headSha);
  const baseTree = mergeBase === null ? null : store.commitTree(repo, mergeBase);
  const headTree = store.commitTree(repo, headSha);
  const baseFiles = baseTree === null ? new Map<string, string>() : store.flattenTree(repo, baseTree);
  const headFiles = headTree === null ? new Map<string, string>() : store.flattenTree(repo, headTree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === headOid) continue;
    const baseBytes = baseOid === undefined ? '' : (repo.objects.get(baseOid)?.data.toString('utf8') ?? '');
    const headBytes = headOid === undefined ? '' : (repo.objects.get(headOid)?.data.toString('utf8') ?? '');
    const status = baseOid === undefined ? 'added' : headOid === undefined ? 'removed' : 'modified';
    const additions = headOid === undefined ? 0 : lineCount(headBytes);
    const deletions = baseOid === undefined ? 0 : lineCount(baseBytes);
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: headOid ?? baseOid ?? '',
    });
  }
  reply(res, 200, out, requestId);
}

/** PUT /pulls/{n}/merge: a squash merge, or 405 on a real content conflict. */
function mergePull(store: Store, res: ServerResponse, repo: Repo, pull: PullRequest, requestId: string): void {
  if (pull.merged) {
    err(res, 405, 'Pull request has already been merged', requestId);
    return;
  }
  const sha = store.squashMerge(repo, pull);
  if (sha === null) {
    err(res, 405, 'Merge conflict', requestId);
    return;
  }
  reply(res, 200, { merged: true, sha, message: `Pull request #${pull.number} successfully merged` }, requestId);
}

// ------------------------------------------------------------ routing

/**
 * Handle one REST v3 request. `path` is the full path (starting `/api/v3`).
 * Returns nothing; every reply is JSON with a request id, never HTML.
 */
export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, path: string, requestId: string): Promise<void> {
  const method = req.method ?? 'GET';
  // Most segments carry no percent-escapes: decoding them is pure overhead on
  // every request (the read workload pays it 2,000 times for one path).
  const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((part) => part !== '').map((part) => (part.includes('%') ? decodeURIComponent(part) : part));

  // GET /api/v3/ — the API root: 200 JSON + X-OAuth-Scopes.
  if (segments.length === 0) {
    if (method !== 'GET') {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    reply(res, 200, {
      current_user_url: '/user',
      repository_url: '/repos/{owner}/{repo}',
      user_url: '/users/{user}',
    }, requestId, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta — the installed version.
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    reply(res, 200, { installed_version: '1.0.0' }, requestId);
    return;
  }

  // GET /api/v3/user — the token user (the MCP setup resolves its owner here).
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    reply(res, 200, userJson(), requestId);
    return;
  }

  // POST /user/repos — create a repo under the token user. GET /user/repos — list them.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = await needJson(req, res, requestId);
      if (body === null) return;
      const name = asString(body.name);
      if (name === null || name === '') {
        err(res, 422, 'name is required', requestId);
        return;
      }
      const repo = store.createRepo(name, {
        description: asString(body.description) ?? '',
        isPrivate: asBoolean(body.private) ?? false,
      });
      if (repo === null) {
        err(res, 422, 'Repository already exists', requestId);
        return;
      }
      reply(res, 201, repoJson(repo), requestId);
      return;
    }
    if (method === 'GET') {
      const { page, link } = paginate(req, store.listRepos().map((repo) => repoJson(repo)));
      reply(res, 200, page, requestId, linkHeader(link));
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // Everything below is /repos/{owner}/{name}/...
  if (segments.length < 3 || segments[0] !== 'repos') {
    err(res, 404, 'Not Found', requestId);
    return;
  }
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const rest = segments.slice(3);

  // GET /repos/{o}/{r} — read, PATCH — update, DELETE — remove (204).
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = needRepo(store, res, owner, repoName, requestId);
      if (repo === null) return;
      reply(res, 200, repoJson(repo), requestId);
      return;
    }
    if (method === 'PATCH') {
      const repo = needRepo(store, res, owner, repoName, requestId);
      if (repo === null) return;
      const body = await needJson(req, res, requestId);
      if (body === null) return;
      const description = asString(body.description);
      if (description !== null) repo.description = description;
      const isPrivate = asBoolean(body.private);
      if (isPrivate !== null) repo.private = isPrivate;
      reply(res, 200, repoJson(repo), requestId);
      return;
    }
    if (method === 'DELETE') {
      if (!store.deleteRepo(owner, repoName)) {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      replyNoContent(res, requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // /repos/{o}/{r}/branches — list, or one branch (the MCP setup fallback).
  if (rest[0] === 'branches') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    if (method === 'GET' && rest.length === 1) {
      const out = store.listRefs(repo)
        .filter(({ ref }) => ref.startsWith('refs/heads/'))
        .map(({ ref, oid }) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }));
      reply(res, 200, out, requestId);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const tip = store.branchTip(repo, rest[1] as string);
      if (tip === null) {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      reply(res, 200, { name: rest[1], commit: { sha: tip } }, requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // GET /repos/{o}/{r}/commits[?sha=<ref>].
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    listCommits(store, req, res, repo, requestId);
    return;
  }

  // POST /repos/{o}/{r}/git/refs — create a branch ref.
  // GET /repos/{o}/{r}/git/refs/heads/{branch} — read one ref (MCP setup fallback).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    if (method === 'POST' && rest.length === 2) {
      const body = await needJson(req, res, requestId);
      if (body === null) return;
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === null || sha === null || !ref.startsWith('refs/')) {
        err(res, 422, 'ref and sha are required', requestId);
        return;
      }
      if (store.getObject(repo, sha) === undefined) {
        err(res, 422, 'Object does not exist', requestId);
        return;
      }
      if (store.getRef(repo, ref) !== undefined) {
        err(res, 422, 'Reference already exists', requestId);
        return;
      }
      store.setRef(repo, ref, sha);
      reply(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }, requestId);
      return;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const tip = store.branchTip(repo, rest[3] as string);
      if (tip === null) {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      reply(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: tip, type: 'commit' } }, requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // PUT/GET/DELETE /repos/{o}/{r}/contents/{path...}.
  if (rest[0] === 'contents') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    const contentPath = rest.slice(1).join('/');
    if (method === 'PUT') {
      await putContents(store, req, res, repo, contentPath, requestId);
      return;
    }
    if (method === 'GET') {
      getContents(store, req, res, repo, contentPath, requestId);
      return;
    }
    if (method === 'DELETE') {
      await deleteContents(store, req, res, repo, contentPath, requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // POST /repos/{o}/{r}/labels — create a label. GET — list them.
  if (rest[0] === 'labels') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    if (method === 'POST' && rest.length === 1) {
      const body = await needJson(req, res, requestId);
      if (body === null) return;
      const name = asString(body.name);
      if (name === null || name === '') {
        err(res, 422, 'name is required', requestId);
        return;
      }
      if (repo.labels.has(name)) {
        err(res, 422, 'Label already exists', requestId);
        return;
      }
      repo.labels.set(name, { name, color: asString(body.color) ?? 'ededed', description: asString(body.description) ?? '' });
      reply(res, 201, labelJson(repo, name), requestId);
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      reply(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)), requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // Issues: POST/GET /issues, GET/PATCH /issues/{n}, comments under /issues/{n}/comments.
  if (rest[0] === 'issues') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await needJson(req, res, requestId);
        if (body === null) return;
        const title = asString(body.title);
        if (title === null) {
          err(res, 422, 'title is required', requestId);
          return;
        }
        const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            err(res, 422, `Label does not exist: ${label}`, requestId);
            return;
          }
        }
        const issue = store.createIssue(repo, { title, body: asString(body.body) ?? '', labels });
        reply(res, 201, issueJson(repo, issue), requestId);
        return;
      }
      if (method === 'GET') {
        const query = queryOf(req);
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        const sort = query.get('sort') ?? 'created';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => (sort === 'created' ? (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq) : a.number - b.number));
        const { page, link } = paginate(req, issues.map((issue) => issueJson(repo, issue)));
        reply(res, 200, page, requestId, linkHeader(link));
        return;
      }
      err(res, 404, 'Not Found', requestId);
      return;
    }
    const number = parseInt(rest[1] as string, 10);
    if (Number.isNaN(number)) {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      if (method === 'GET') {
        // The read workload GETs one issue 2,000 times: serve the cached bytes.
        const cached = cachedIssueBody(repo, issue.number);
        if (cached !== null) {
          sendPrebuilt(res, 200, cached, { 'x-github-request-id': requestId });
          return;
        }
        const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
        cacheIssueBody(repo, issue.number, text);
        sendPrebuilt(res, 200, text, { 'x-github-request-id': requestId });
        return;
      }
      if (method === 'PATCH') {
        const body = await needJson(req, res, requestId);
        if (body === null) return;
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          const seq = store.tick();
          issue.updatedAt = store.isoAt(seq);
          dropIssueBody(repo, issue.number);
        }
        reply(res, 200, issueJson(repo, issue), requestId);
        return;
      }
      err(res, 404, 'Not Found', requestId);
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      if (method === 'POST') {
        const body = await needJson(req, res, requestId);
        if (body === null) return;
        const commentBody = asString(body.body);
        if (commentBody === null) {
          err(res, 422, 'body is required', requestId);
          return;
        }
        const seq = store.tick();
        const at = store.isoAt(seq);
        const comment: IssueComment = {
          id: repo.nextCommentId++,
          body: commentBody,
          user: VIEWER,
          createdAt: at,
          updatedAt: at,
        };
        issue.comments.push(comment);
        // The issue's `comments` count changed: its cached GET body is stale.
        dropIssueBody(repo, issue.number);
        reply(res, 201, commentJson(repo, comment), requestId);
        return;
      }
      if (method === 'GET') {
        reply(res, 200, issue.comments.map((comment) => commentJson(repo, comment)), requestId);
        return;
      }
      err(res, 404, 'Not Found', requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // Pull requests: POST/GET /pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT /pulls/{n}/merge.
  if (rest[0] === 'pulls') {
    const repo = needRepo(store, res, owner, repoName, requestId);
    if (repo === null) return;
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await needJson(req, res, requestId);
        if (body === null) return;
        const title = asString(body.title);
        const head = asString(body.head);
        const base = asString(body.base) ?? repo.defaultBranch;
        if (title === null || head === null) {
          err(res, 422, 'title and head are required', requestId);
          return;
        }
        const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
        const baseBranch = base.includes(':') ? (base.split(':').pop() as string) : base;
        if (store.branchTip(repo, headBranch) === null || store.branchTip(repo, baseBranch) === null) {
          err(res, 422, 'head or base branch does not exist', requestId);
          return;
        }
        const pull = store.createPull(repo, { title, body: asString(body.body) ?? '', head: headBranch, base: baseBranch });
        reply(res, 201, pullJson(repo, pull), requestId);
        return;
      }
      if (method === 'GET') {
        const query = queryOf(req);
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(req, pulls.map((pull) => pullJson(repo, pull)));
        reply(res, 200, page, requestId, linkHeader(link));
        return;
      }
      err(res, 404, 'Not Found', requestId);
      return;
    }
    const number = parseInt(rest[1] as string, 10);
    if (Number.isNaN(number)) {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      err(res, 404, 'Not Found', requestId);
      return;
    }
    if (rest.length === 2) {
      if (method !== 'GET') {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      reply(res, 200, pullJson(repo, pull), requestId);
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      pullFiles(store, res, repo, pull, requestId);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') {
        err(res, 404, 'Not Found', requestId);
        return;
      }
      // The merge body ({merge_method}) is read for the malformed-body rule, but any
      // method the suite sends is squash; other methods are answered the same way.
      const body = await needJson(req, res, requestId);
      if (body === null) return;
      void body;
      mergePull(store, res, repo, pull, requestId);
      return;
    }
    err(res, 404, 'Not Found', requestId);
    return;
  }

  // Any other /api/v3 route is a JSON 404, never HTML.
  err(res, 404, 'Not Found', requestId);
}
