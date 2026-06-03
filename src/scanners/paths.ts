import { isAbsolute, relative } from "node:path";

/** Make a scanner-reported path repo-relative (POSIX separators); pass relatives through. */
export function toRepoRelative(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return rel.split("\\").join("/");
}
