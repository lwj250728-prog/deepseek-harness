/**
 * Command exit-code evidence: the third external-witness class for claim
 * audits (alongside session-ledger tool calls and workspace file states).
 * The command is actually RUN at audit time through the shell capability
 * seam (`ctx.shell`), so the verdict comes from the process exit code, never
 * from the model's memory of what it ran. This is how "the tests really
 * pass" becomes machine-decidable instead of a state. The pipeline never
 * spawns processes itself — the shell executor owns execution.
 * @module @deepseek-ai/dsh-cognitive-pipeline/command-evidence
 */
import type { CommandExpect } from './types.ts';
/** The input a command anchor resolves against. */
export interface CommandAnchorInput {
    /** The command to run through the shell executor. */
    readonly command: string;
    /** The exit-code expectation. */
    readonly expect: CommandExpect;
    /** Hard timeout in milliseconds; a command that does not settle fails closed. */
    readonly timeoutMs: number;
}
/** The mechanically-verified command fact, mirroring the input plus the verdict. */
export type CommandAnchorResult = CommandAnchorInput & {
    /** The observed exit code, null when the command could not settle. */
    readonly exitCode: number | null;
    readonly matched: boolean;
};
/**
 * Verify one exit-code expectation against the exit code the runner settled
 * on. Fail-closed: a null exit code (spawn error, timeout, or signal death)
 * never matches — cannot verify is a violation, never a pass.
 * @param input - the command, expectation, and timeout.
 * @param run - the exit-code provider (the service routes it through the
 *   shell capability seam).
 * @returns the input plus the observed exit code and whether it matched.
 */
export declare function verifyCommandAnchor(input: CommandAnchorInput, run: (command: string, timeoutMs: number) => Promise<number | null>): Promise<CommandAnchorResult>;
//# sourceMappingURL=command-evidence.d.ts.map