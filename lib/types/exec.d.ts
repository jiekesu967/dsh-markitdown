/** Raised when the configured executable does not exist. */
export declare class ExecutableNotFoundError extends Error {
    readonly executable: string;
    constructor(executable: string);
}
/** One finished subprocess. */
export interface ProcessResult {
    /** Decoded standard output. */
    stdout: string;
    /** Decoded standard error. */
    stderr: string;
    /** Process exit status; `0` on success. */
    code: number;
}
/** Options shared by every launch. */
export interface RunOptions {
    /** Caller cancellation; the child is killed when it aborts. */
    signal?: AbortSignal | undefined;
    /** Cooperative deadline in milliseconds. */
    timeoutMs: number;
    /** Output cap in bytes before the child is killed. */
    maxBuffer?: number;
    /** Environment overrides merged over `process.env`. */
    env?: Record<string, string> | undefined;
}
/**
 * Run one executable and capture its output.
 * @param argv - executable plus arguments; never shell-interpreted.
 * @param options - deadline, cancellation, buffer cap, and environment.
 * @returns the finished process result.
 * @throws ExecutableNotFoundError when argv[0] does not exist.
 * @throws Error on cancellation, timeout, or a non-zero exit status.
 */
export declare function run(argv: readonly string[], options: RunOptions): Promise<ProcessResult>;
/** Result of a PATH lookup: either a usable executable or the reason there is none. */
export type WhichResult = {
    path: string;
} | {
    reason: string;
};
/**
 * Resolve a command name to a real executable path.
 * @param name - command name without extension.
 * @param options - cancellation and deadline for the lookup itself.
 * @returns the absolute path, or the reason no usable executable was found.
 */
export declare function which(name: string, options: RunOptions): Promise<WhichResult>;
/**
 * Whether a resolved path can be launched without a shell. On Windows that means
 * a `.exe`/`.com` image; a `.cmd`/`.bat` shim would need `cmd.exe` and would put
 * the arguments back through command-line parsing, so it is rejected.
 * @param path - a path produced by `where`/`which`.
 * @returns true when `execFile` can launch it directly.
 */
export declare function isRealExecutable(path: string): boolean;
