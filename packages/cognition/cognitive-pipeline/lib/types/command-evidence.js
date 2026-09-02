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
/**
 * Verify one exit-code expectation against the exit code the runner settled
 * on. Fail-closed: a null exit code (spawn error, timeout, or signal death)
 * never matches — cannot verify is a violation, never a pass.
 * @param input - the command, expectation, and timeout.
 * @param run - the exit-code provider (the service routes it through the
 *   shell capability seam).
 * @returns the input plus the observed exit code and whether it matched.
 */
export async function verifyCommandAnchor(input, run) {
    const exitCode = await run(input.command, input.timeoutMs);
    const matched = exitCode !== null
        ? (input.expect === 'exit-zero' ? exitCode === 0 : exitCode !== 0)
        : false;
    return { ...input, exitCode, matched };
}
//# sourceMappingURL=command-evidence.js.map