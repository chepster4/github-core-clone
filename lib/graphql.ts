// graphql.ts — a small GraphQL v4 executor for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts). It parses the documents,
// executes them against the Store, and answers the shapes the suite asserts:
// opaque stable global ids, CREATED_AT DESC issue ordering with number-DESC ties,
// cursor pagination, nullable repository, batched operations, and an errors array
// naming an unknown field (HTTP 200, never 4xx, for a GraphQL-level error).

import { Store, VIEWER, VIEWER_LOGIN, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------- global ids

/** An opaque global id: base64 of `<Kind>:<parts...>`. Never the bare decimal id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', repo.id, issueNumber, commentId);
}

/** Decode a global id into [kind, parts], or null when it does not parse. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    const kind = text.slice(0, at);
    if (!/^[A-Za-z]+$/.test(kind)) return null;
    return { kind, parts: text.slice(at + 1).split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { type: 'name'; value: string }
  | { type: 'int'; value: number }
  | { type: 'float'; value: number }
  | { type: 'string'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc ?? '';
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { type: 'float', value: parseFloat(text) } : { type: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ type: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i} in GraphQL document`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'inline'; readonly typeName: string | null; readonly selection: SelectionNode[] };

export interface OperationNode {
  readonly type: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly selection: SelectionNode[];
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`expected name ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().type !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    let type: OperationNode['type'] = 'query';
    let name: string | null = null;
    if (token.type === 'punct' && token.value === '{') {
      return { type: 'query', name: null, selection: this.parseSelectionSet() };
    }
    if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = token.value as OperationNode['type'];
      this.next();
      const after = this.peek();
      if (after.type === 'name') name = this.next().value as string;
    } else if (token.type === 'name' && token.value === 'fragment') {
      throw new Error('named fragments are not supported by this executor');
    } else {
      throw new Error(`unexpected token ${JSON.stringify(token)} at the start of a GraphQL operation`);
    }
    // Variable definitions: ($name: Type = default, ...)
    if (this.peek().type === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.skipBalanced('(', ')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, selection };
  }

  /** Skip a balanced (...) or [...] span (variable definitions, directives). */
  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.type === 'eof') throw new Error('unbalanced brackets in GraphQL document');
      if (token.type === 'punct' && token.value === open) depth += 1;
      else if (token.type === 'punct' && token.value === close) depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.type === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.type === 'eof') throw new Error('unterminated selection set in GraphQL document');
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.type === 'punct' && token.value === '...') {
      this.next();
      let typeName: string | null = null;
      const next = this.peek();
      if (next.type === 'name' && next.value === 'on') {
        this.next();
        typeName = this.expectName();
      }
      return { kind: 'inline', typeName, selection: this.parseSelectionSet() };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    const colon = this.peek();
    if (colon.type === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    const open = this.peek();
    if (open.type === 'punct' && open.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token.type === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selection: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace.type === 'punct' && brace.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next.type === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const next = this.peek();
        if (next.type === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.type === 'int') return { kind: 'int', value: token.value };
    if (token.type === 'float') return { kind: 'float', value: token.value };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

/** Resolve a parsed argument value against the request's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- executor

export interface GraphQLError {
  readonly message: string;
}

export interface GraphQLResult {
  readonly data: Record<string, unknown> | null;
  readonly errors?: GraphQLError[];
}

interface ExecContext {
  readonly store: Store;
  readonly errors: GraphQLError[];
}

/** The fields each type exposes (validation + introspection share this table). */
const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

/** The object type a field returns (scalars resolve directly, no entry here). */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue' },
  CommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** The concrete type a value of an abstract/interface type has (for inline fragments). */
function concreteType(typeName: string, value: unknown): string {
  if (typeName === 'Node') {
    const record = value as { __nodeKind?: string };
    return record.__nodeKind ?? 'Repository';
  }
  return typeName;
}

type Resolver = (parent: any, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function repoOf(ctx: ExecContext, id: unknown): Repo | undefined {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  const dbId = Number(decoded.parts[0]);
  return ctx.store.listRepos().find((repo) => repo.id === dbId);
}

function issueOf(ctx: ExecContext, id: unknown): { repo: Repo; issue: Issue } | undefined {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'Issue') return undefined;
  const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (repo === undefined) return undefined;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue === undefined ? undefined : { repo, issue };
}

function pullOf(ctx: ExecContext, id: unknown): { repo: Repo; pull: PullRequest } | undefined {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
  const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (repo === undefined) return undefined;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull === undefined ? undefined : { repo, pull };
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface IssueConnectionValue {
  readonly nodes: Issue[];
  readonly pageInfo: { hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
  readonly totalCount: number;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): IssueConnectionValue {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase() === 'OPEN' ? 'open' : 'closed'));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  // CREATED_AT ordering; ties break by number. seq and number correlate, so this is
  // descending number for DESC and ascending for ASC.
  list.sort((a, b) => direction * (a.seq - b.seq) || direction * (a.number - b.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1]?.number ?? 0);
  const startCursor = page.length === 0 ? null : encodeCursor(page[0]?.number ?? 0);
  return {
    nodes: page,
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: after !== null, startCursor },
    totalCount,
  };
}

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MILESTONE', 'WIKI'];

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ login: VIEWER_LOGIN, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email }),
    repository: (_parent, args, ctx) => {
      if (args.owner !== VIEWER_LOGIN) return null;
      return ctx.store.getRepo(String(args.owner), String(args.name)) ?? null;
    },
    node: (_parent, args, ctx) => {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
        return repo === undefined ? null : { __nodeKind: 'Repository', repo };
      }
      if (decoded.kind === 'Issue') {
        const found = issueOf(ctx, args.id);
        return found === undefined ? null : { __nodeKind: 'Issue', ...found };
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullOf(ctx, args.id);
        return found === undefined ? null : { __nodeKind: 'PullRequest', ...found };
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      if (name === 'Issue' || name === 'PullRequest' || name === 'Repository') {
        return { __typeName: name, kind: 'OBJECT' };
      }
      if (name === 'SearchType') return { __typeName: name, kind: 'ENUM' };
      return null;
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const repo = repoOf(ctx, input.repositoryId);
      if (repo === undefined) throw new Error(`repository ${String(input.repositoryId)} not found`);
      const issue = ctx.store.createIssue(repo, { title: input.title ?? '', body: input.body ?? '' });
      return { __payload: 'createIssue', repo, issue };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as { issueId?: string };
      const found = issueOf(ctx, input.issueId);
      if (found === undefined) throw new Error(`issue ${String(input.issueId)} not found`);
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.store.isoAt(ctx.store.tick());
      return { __payload: 'closeIssue', ...found };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string };
      const repo = repoOf(ctx, input.repositoryId);
      if (repo === undefined) throw new Error(`repository ${String(input.repositoryId)} not found`);
      const pull = ctx.store.createPull(repo, {
        title: input.title ?? '',
        body: '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? 'main',
      });
      return { __payload: 'createPullRequest', repo, pull };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
      const found = pullOf(ctx, input.pullRequestId);
      if (found === undefined) throw new Error(`pull request ${String(input.pullRequestId)} not found`);
      const merged = ctx.store.squashMerge(found.repo, found.pull);
      if (merged === null) throw new Error(`pull request #${found.pull.number} cannot be merged (conflict)`);
      return { __payload: 'mergePullRequest', ...found };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as { subjectId?: string; body?: string };
      const found = issueOf(ctx, input.subjectId);
      if (found === undefined) throw new Error(`issue ${String(input.subjectId)} not found`);
      const seq = ctx.store.tick();
      const comment = {
        id: found.repo.nextCommentId++,
        body: input.body ?? '',
        user: VIEWER,
        createdAt: ctx.store.isoAt(seq),
        updatedAt: ctx.store.isoAt(seq),
      };
      found.issue.comments.push(comment);
      return { __payload: 'addComment', ...found, comment };
    },
  },
  Repository: {
    id: (repo: Repo) => repoGlobalId(repo),
    databaseId: (repo: Repo) => repo.id,
    name: (repo: Repo) => repo.name,
    nameWithOwner: (repo: Repo) => `${repo.owner}/${repo.name}`,
    owner: (repo: Repo) => ({ login: repo.owner, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email }),
    defaultBranchRef: (repo: Repo) => ({ name: repo.defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (repo: Repo) => repo.description,
    isPrivate: (repo: Repo) => repo.private,
    createdAt: (repo: Repo) => repo.createdAt,
    updatedAt: (repo: Repo) => repo.createdAt,
    issue: (repo: Repo, args) => repo.issues.get(Number(args.number)) ?? null,
    issues: (repo: Repo, args) => issueConnection(repo, args),
    pullRequests: (repo: Repo, args) => {
      const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq || b.number - a.number);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
      const page = list.slice(0, first);
      return {
        nodes: page,
        pageInfo: { hasNextPage: list.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: list.length,
      };
    },
    pullRequest: (repo: Repo, args) => repo.pulls.get(Number(args.number)) ?? null,
  },
  Issue: {
    id: (issue: Issue, _args, ctx) => {
      const found = ctx.store.listRepos().find((candidate) => candidate.issues.get(issue.number) === issue);
      return found === undefined ? '' : issueGlobalId(found, issue);
    },
    number: (issue: Issue) => issue.number,
    title: (issue: Issue) => issue.title,
    state: (issue: Issue) => (issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (issue: Issue) => issue.body,
    createdAt: (issue: Issue) => issue.createdAt,
    updatedAt: (issue: Issue) => issue.updatedAt,
  },
  IssueConnection: {
    nodes: (value: IssueConnectionValue) => value.nodes,
    pageInfo: (value: IssueConnectionValue) => value.pageInfo,
    totalCount: (value: IssueConnectionValue) => value.totalCount,
  },
  PageInfo: {
    hasNextPage: (value: { hasNextPage: boolean }) => value.hasNextPage,
    endCursor: (value: { endCursor: string | null }) => value.endCursor,
    hasPreviousPage: (value: { hasPreviousPage: boolean }) => value.hasPreviousPage,
    startCursor: (value: { startCursor: string | null }) => value.startCursor,
  },
  PullRequest: {
    id: (pull: PullRequest, _args, ctx) => {
      const found = ctx.store.listRepos().find((candidate) => candidate.pulls.get(pull.number) === pull);
      return found === undefined ? '' : pullGlobalId(found, pull);
    },
    number: (pull: PullRequest) => pull.number,
    title: (pull: PullRequest) => pull.title,
    body: (pull: PullRequest) => pull.body,
    state: (pull: PullRequest) => pullState(pull),
    merged: (pull: PullRequest) => pull.merged,
    headRefName: (pull: PullRequest) => pull.head,
    baseRefName: (pull: PullRequest) => pull.base,
    mergeable: (pull: PullRequest, _args, ctx) => {
      const found = ctx.store.listRepos().find((candidate) => candidate.pulls.get(pull.number) === pull);
      return found === undefined ? pull.mergeable : ctx.store.computeMergeable(found, pull);
    },
    files: (pull: PullRequest, args, ctx) => {
      const repo = ctx.store.listRepos().find((candidate) => candidate.pulls.get(pull.number) === pull);
      if (repo === undefined) return { nodes: [] };
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
      if (baseTip === null || headTip === null) return { nodes: [] };
      const base = ctx.store.mergeBase(repo, baseTip, headTip);
      const baseTree = base === null ? null : ctx.store.commitTree(repo, base);
      const headTree = ctx.store.commitTree(repo, headTip);
      const paths = ctx.store.diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : paths.length;
      const page = paths.slice(0, first);
      return {
        nodes: page.map((path) => ({ path })),
        pageInfo: { hasNextPage: paths.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: paths.length,
      };
    },
    createdAt: (pull: PullRequest) => pull.createdAt,
    updatedAt: (pull: PullRequest) => pull.updatedAt,
  },
  PullRequestConnection: {
    nodes: (value: { nodes: PullRequest[] }) => value.nodes,
    pageInfo: (value: { pageInfo: unknown }) => value.pageInfo,
    totalCount: (value: { totalCount: number }) => value.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (value: { nodes: Array<{ path: string }> }) => value.nodes,
    pageInfo: (value: { pageInfo: unknown }) => value.pageInfo ?? null,
    totalCount: (value: { totalCount: number }) => value.totalCount ?? 0,
  },
  PullRequestChangedFile: {
    path: (value: { path: string }) => value.path,
  },
  Ref: {
    name: (value: { name: string }) => value.name,
  },
  User: {
    id: (value: { id?: string }) => value.id ?? String(VIEWER.id),
    login: (value: { login: string }) => value.login,
    name: (value: { name?: string }) => value.name ?? '',
    email: (value: { email?: string }) => value.email ?? '',
  },
  CreateIssuePayload: {
    issue: (value: { issue: Issue }) => value.issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (value: { issue: Issue }) => value.issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (value: { pull: PullRequest }) => value.pull,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (value: { pull: PullRequest }) => value.pull,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (value: { comment: { id: number; body: string }; repo: Repo; issue: Issue }) => ({
      node: { __commentId: value.comment.id, __repo: value.repo, __issue: value.issue, body: value.comment.body },
      cursor: encodeCursor(value.comment.id),
    }),
    subject: (value: { issue: Issue }) => value.issue,
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (value: { node: unknown }) => value.node,
    cursor: (value: { cursor: string }) => value.cursor,
  },
  IssueComment: {
    id: (value: { __commentId: number; __repo: Repo; __issue: Issue }) => commentGlobalId(value.__repo, value.__issue.number, value.__commentId),
    body: (value: { body: string }) => value.body,
    createdAt: (value: { createdAt?: string }) => value.createdAt ?? '',
    updatedAt: (value: { updatedAt?: string }) => value.updatedAt ?? '',
    author: () => ({ login: VIEWER_LOGIN, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email }),
  },
  __Type: {
    name: (value: { __typeName: string }) => value.__typeName,
    kind: (value: { kind: string }) => value.kind,
    fields: (value: { __typeName: string }) => {
      const names = FIELDS[value.__typeName] ?? [];
      return names.map((name) => ({ name }));
    },
    enumValues: (value: { __typeName: string }) => {
      if (value.__typeName !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((name) => ({ name }));
    },
  },
  __Field: {
    name: (value: { name: string }) => value.name,
  },
  __EnumValue: {
    name: (value: { name: string }) => value.name,
  },
  Node: {
    // Node values are unwrapped to their concrete object before resolution (see
    // resolveObject); these resolvers are never called, but the table documents the type.
    id: () => '',
  },
};

// The payload object a mutation returns carries its kind; map it to the payload type.
function payloadType(value: { __payload?: string }): string {
  switch (value.__payload) {
    case 'createIssue':
      return 'CreateIssuePayload';
    case 'closeIssue':
      return 'CloseIssuePayload';
    case 'createPullRequest':
      return 'CreatePullRequestPayload';
    case 'mergePullRequest':
      return 'MergePullRequestPayload';
    case 'addComment':
      return 'AddCommentPayload';
    default:
      return 'CreateIssuePayload';
  }
}

/** Resolve one object's selection set into a JSON object (null stays null). */
function resolveObject(
  typeName: string,
  value: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  // A Node value is a wrapper ({__nodeKind, repo|issue|pull}); unwrap it to its concrete
  // object and resolve every field against the concrete type.
  let actualType = concreteType(typeName, value);
  let effectiveValue: unknown = value;
  if (typeName === 'Node') {
    const record = value as { __nodeKind?: string; repo?: Repo; issue?: Issue; pull?: PullRequest };
    if (record.__nodeKind === 'Repository') effectiveValue = record.repo ?? value;
    else if (record.__nodeKind === 'Issue') effectiveValue = record.issue ?? value;
    else if (record.__nodeKind === 'PullRequest') effectiveValue = record.pull ?? value;
    actualType = record.__nodeKind ?? actualType;
  }
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeName !== null && selection.typeName !== actualType) continue;
      const nested = resolveObject(actualType, effectiveValue, selection.selection, variables, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const known = (FIELDS[actualType] ?? []).includes(field.name);
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${actualType}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(field.args)) args[name] = resolveValue(node as ValueNode, variables);
    const resolver = RESOLVERS[actualType]?.[field.name];
    if (resolver === undefined) continue;
    let resolved: unknown;
    try {
      resolved = resolver(effectiveValue, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      continue;
    }
    if (field.selection === null) {
      out[responseKey] = resolved ?? null;
      continue;
    }
    const childType = FIELD_TYPE[actualType]?.[field.name];
    if (childType === undefined) {
      out[responseKey] = resolved ?? null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[responseKey] = resolved.map((item) => resolveObject(childType, item, field.selection as SelectionNode[], variables, ctx));
      continue;
    }
    if (childType === 'Node') {
      out[responseKey] = resolveObject('Node', resolved, field.selection, variables, ctx);
      continue;
    }
    // A mutation payload's concrete type depends on which mutation ran.
    const effectiveType =
      actualType === 'Mutation' && resolved !== null && typeof resolved === 'object' && '__payload' in (resolved as Record<string, unknown>)
        ? payloadType(resolved as { __payload?: string })
        : childType;
    out[responseKey] = resolveObject(effectiveType, resolved, field.selection, variables, ctx);
  }
  return out;
}

/** Execute one operation document. Returns the envelope; never throws for a GraphQL error. */
export function executeOperation(
  store: Store,
  queryText: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  const ctx: ExecContext = { store, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(queryText)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in GraphQL document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveObject(rootType, {}, operation.selection, variables, ctx);
  const result: GraphQLResult = { data: data ?? {} };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/**
 * Execute a GraphQL request body: one operation object, or an array of them (batched).
 * Returns one envelope, or an array of envelopes in request order.
 */
export function executeGraphQL(
  store: Store,
  body: unknown,
): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      const operation = (entry ?? {}) as { query?: unknown; variables?: unknown };
      const variables = (operation.variables ?? {}) as Record<string, unknown>;
      return executeOperation(store, String(operation.query ?? ''), variables);
    });
  }
  const operation = (body ?? {}) as { query?: unknown; variables?: unknown };
  const variables = (operation.variables ?? {}) as Record<string, unknown>;
  return executeOperation(store, String(operation.query ?? ''), variables);
}
