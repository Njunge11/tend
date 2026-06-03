import type { SimpleGit } from "simple-git";
import type { Snapshot } from "../git/snapshot.js";

/** `tend diff` — the files the tool edited (snapshot vs now), the dev's own changes filtered out. */
export async function diffCommand(deps: { snapshot: Snapshot; git: SimpleGit }): Promise<string[]> {
  return deps.snapshot.changedSince(deps.git);
}
