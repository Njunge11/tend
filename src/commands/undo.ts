import type { SimpleGit } from "simple-git";
import type { Snapshot } from "../git/snapshot.js";

/** `tend undo` — restore the pre-run snapshot exactly. */
export async function undoCommand(deps: { snapshot: Snapshot; git: SimpleGit }): Promise<void> {
  await deps.snapshot.restore(deps.git);
}
