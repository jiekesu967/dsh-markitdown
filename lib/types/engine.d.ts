/** One concrete conversion backend. */
export type EngineId = 'markitdown' | 'uvx' | 'python' | 'builtin';
/** A user-facing engine selection, including automatic detection. */
export type EngineChoice = EngineId | 'auto';
/** An engine that has been proven available and is ready to launch. */
export interface ResolvedEngine {
    /** Stable identifier of the backend family. */
    id: EngineId;
    /** Human-readable description used in results and error messages. */
    label: string;
    /** Executable plus fixed leading arguments. Empty for the built-in engine. */
    argv: readonly string[];
    /** Extra environment applied to the child process. */
    env: Record<string, string> | undefined;
    /** True when the plugin reads the bytes itself instead of invoking a program. */
    internal: boolean;
}
/** Outcome of one external conversion. */
export interface ConversionOutcome {
    /** Converted Markdown. */
    markdown: string;
    /** Diagnostics the engine printed on standard error. */
    stderr: string;
}
/** Resolves and caches the engine for one plugin instance. */
export declare class EngineChain {
    #private;
    constructor(options: {
        choice: EngineChoice;
        command?: string | undefined;
        /** Package spec `uvx` should run; the extras are what make Office formats work. */
        uvxPackage?: string | undefined;
        probeTimeoutMs: number;
    });
    /** Probe transcript of the most recent resolution, for diagnostics. */
    get log(): readonly string[];
    /** Forget the cached engine so the next call re-probes. */
    invalidate(): void;
    /**
     * Resolve the engine to use, probing once and caching the winner.
     * @param signal - cancellation for the probe itself.
     * @returns the resolved engine.
     * @throws Error when an explicitly requested engine is unavailable.
     */
    resolve(signal?: AbortSignal): Promise<ResolvedEngine>;
}
/**
 * Run one conversion through an external engine.
 * @param engine - the resolved engine; must not be the built-in one.
 * @param input - absolute process path or URL handed to the engine.
 * @param options - deadline, cancellation, and extra CLI arguments.
 * @returns the converted Markdown and the engine's standard error.
 * @throws Error when the engine fails or produces no output.
 */
export declare function convertExternal(engine: ResolvedEngine, input: string, options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    extraArgs?: readonly string[];
}): Promise<ConversionOutcome>;
/**
 * Drop the package-manager progress `uvx` prints on first use, keeping anything
 * that looks like a real diagnostic. Without this the first conversion returns
 * fifteen lines of download chatter to the model alongside the document.
 * @param stderr - raw standard error from the engine.
 * @returns the remaining diagnostic lines, trimmed.
 */
export declare function filterEngineNoise(stderr: string): string;
