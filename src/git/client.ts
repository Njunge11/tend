import { simpleGit, type SimpleGit } from "simple-git";

const UNSAFE_GIT_ENV_KEYS = ["GIT_EDITOR", "GIT_PAGER", "GIT_SEQUENCE_EDITOR", "PAGER"] as const;

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };

  for (const key of UNSAFE_GIT_ENV_KEYS) {
    delete env[key];
  }

  return env;
}

export function createGit(root: string): SimpleGit {
  return simpleGit(root).env(gitEnv());
}
