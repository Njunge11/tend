import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FileEdit = { path: string; contents: string };

/**
 * The atomic unit of a fix: edits to one file plus (optionally) its sibling test,
 * applied and reverted together. Captures each file's prior state on apply so a
 * revert — even after a partial apply — restores the working tree exactly.
 */
export class ChangeSet {
  /** path → original contents, or null if the file did not exist before. */
  private readonly originals = new Map<string, string | null>();

  constructor(private readonly edits: FileEdit[]) {}

  apply(): void {
    for (const edit of this.edits) {
      if (!this.originals.has(edit.path)) {
        this.originals.set(edit.path, existsSync(edit.path) ? readFileSync(edit.path, "utf8") : null);
      }
      mkdirSync(dirname(edit.path), { recursive: true });
      writeFileSync(edit.path, edit.contents);
    }
  }

  revert(): void {
    for (const [path, original] of this.originals) {
      if (original === null) {
        if (existsSync(path)) rmSync(path, { force: true });
      } else {
        writeFileSync(path, original);
      }
    }
  }
}
