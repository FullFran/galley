/** A repository the signed-in user can open through the galley GitHub App. */
export interface Repository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** Last push (or update) time, ISO 8601, when GitHub sent it. */
  updatedAt?: string;
}

/** The branch the user edits in a repository, and the files at its head. */
export interface WorkingState {
  /** Working branch name, `galley/<login>`. */
  branch: string;
  /** False until the first save creates the branch from the default branch. */
  branchExists: boolean;
  /** Commit SHA the next save must use as its parent. */
  headSha: string;
  /** File paths (blobs only) at `headSha`. */
  files: string[];
  /** True when GitHub returned an incomplete tree. */
  truncated: boolean;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface SaveResult {
  commitSha: string;
  /** Undefined when the commit landed but the pull request could not be found or opened. */
  pullRequestUrl?: string;
}

/** Port between the app and wherever repositories live. */
export interface RepoGateway {
  listRepositories(): Promise<Repository[]>;
  openRepository(repo: Repository): Promise<WorkingState>;
  /**
   * Reads a UTF-8 text file at `ref` (commit SHA or branch name). A byte order
   * mark is kept as U+FEFF. Throws `NotTextError` for anything that is not UTF-8.
   */
  readFile(repo: Repository, path: string, ref: string): Promise<string>;
  /** Reads any file at `ref` as bytes, e.g. a figure for the preview. */
  readBytes(repo: Repository, path: string, ref: string): Promise<Uint8Array>;
  /**
   * Saves all changes as one commit whose parent is `expectedHeadSha`, moves the
   * working branch fast-forward only, and opens or reuses its pull request.
   * Throws `ConflictError` when the branch no longer points at `expectedHeadSha`.
   * Once the branch has moved, a failing pull request step no longer throws.
   */
  save(
    repo: Repository,
    changes: FileChange[],
    message: string,
    expectedHeadSha: string,
  ): Promise<SaveResult>;
}
