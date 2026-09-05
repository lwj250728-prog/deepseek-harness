/**
 * Workspace file-state evidence: the second external-witness class for claim
 * audits (alongside session-ledger tool calls). The check reads the file at
 * audit time, so the verdict comes from the disk, never from the model's
 * memory of what it wrote.
 * @module @deepseek-ai/dsh-cognitive-pipeline/file-evidence
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { FileExpect } from './types.ts'

/** The input a file anchor resolves against. */
export interface FileAnchorInput {
  /** Workspace path; relative paths resolve against the working directory. */
  readonly path: string
  /** The file-state expectation. */
  readonly expect: FileExpect
  /** Expected sha256 hex for `matches-hash`. */
  readonly hash?: string
  /** Searched substring for `contains`. */
  readonly text?: string
}

/** The mechanically-verified file fact, mirroring the input plus the verdict. */
export type FileAnchorResult = FileAnchorInput & { readonly matched: boolean }

/**
 * Verify one file-state expectation against the current disk. Fail-closed: an
 * unreadable path resolves to `matched: false` (cannot verify is a violation,
 * never a pass), except that `missing` matches exactly when the file is
 * absent.
 * @param input - the path, expectation, and expectation parameters.
 * @returns the input plus whether the file state matched.
 */
export async function verifyFileAnchor(input: FileAnchorInput): Promise<FileAnchorResult> {
  const filePath = isAbsolute(input.path) ? input.path : resolve(process.cwd(), input.path)
  if (input.expect === 'missing') {
    try {
      await stat(filePath)
      return { ...input, matched: false }
    } catch {
      return { ...input, matched: true }
    }
  }
  let content: Buffer
  try {
    content = await readFile(filePath)
  } catch {
    return { ...input, matched: false }
  }
  switch (input.expect) {
    case 'exists':
      return { ...input, matched: true }
    case 'matches-hash': {
      const digest = createHash('sha256').update(content).digest('hex')
      return { ...input, matched: digest === (input.hash ?? '') }
    }
    case 'contains': {
      const needle = input.text ?? ''
      return { ...input, matched: needle.length > 0 && content.toString('utf8').includes(needle) }
    }
  }
}
