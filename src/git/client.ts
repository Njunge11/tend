import { simpleGit, type SimpleGit } from "simple-git";

const UNSAFE_GIT_ENV_KEYS = [
  "EDITOR",
  "VISUAL",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "PAGER",
] as const;

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };

  for (const key of UNSAFE_GIT_ENV_KEYS) {
    delete env[key];
  }

  return env;
}

export function createGit(root: string, extraEnv: NodeJS.ProcessEnv = {}): SimpleGit {
  return simpleGit(root).env(gitEnv(extraEnv));
}
