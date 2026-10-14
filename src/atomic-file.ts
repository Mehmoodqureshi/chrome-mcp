import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

/** Replace one file without exposing an empty or partially written file to Chrome. */
export function writeFileAtomic(path: string, contents: string | Buffer, mode = 0o644): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* already renamed, or never created */ }
  }
}
