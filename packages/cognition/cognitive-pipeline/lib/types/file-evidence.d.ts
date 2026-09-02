/**
 * Workspace file-state evidence: the second external-witness class for claim
 * audits (alongside session-ledger tool calls). The check reads the file at
 * audit time, so the verdict comes from the disk, never from the model's
 * memory of what it wrote.
 * @module @deepseek-ai/dsh-cognitive-pipeline/file-evidence
 */
import type { FileExpect } from './types.ts';
/** The input a file anchor resolves against. */
export interface FileAnchorInput {
    /** Workspace path; relative paths resolve against the working directory. */
    readonly path: string;
    /** The file-state expectation. */
    readonly expect: FileExpect;
    /** Expected sha256 hex for `matches-hash`. */
    readonly hash?: string;
    /** Searched substring for `contains`. */
    readonly text?: string;
}
/** The mechanically-verified file fact, mirroring the input plus the verdict. */
export type FileAnchorResult = FileAnchorInput & {
    readonly matched: boolean;
};
/**
 * Verify one file-state expectation against the current disk. Fail-closed: an
 * unreadable path resolves to `matched: false` (cannot verify is a violation,
 * never a pass), except that `missing` matches exactly when the file is
 * absent.
 * @param input - the path, expectation, and expectation parameters.
 * @returns the input plus whether the file state matched.
 */
export declare function verifyFileAnchor(input: FileAnchorInput): Promise<FileAnchorResult>;
//# sourceMappingURL=file-evidence.d.ts.map