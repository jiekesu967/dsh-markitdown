import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type EngineChoice } from './engine.js';
/** Plugin id, matching the package name. */
export declare const name = "dsh-markitdown";
/** The tool runtime is a hard dependency; the filesystem seam is optional. */
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /** Which engine to use; `auto` probes the chain in preference order. */
    engine: EngineChoice;
    /** Explicit `markitdown` executable, overriding PATH lookup. */
    command?: string | undefined;
    /** Package spec `uvx` runs; the extras are what make Office/PDF formats work. */
    uvxPackage: string;
    /** Per-conversion deadline in milliseconds. */
    timeoutMs: number;
    /** Maximum characters returned inline; longer output is truncated. */
    maxChars: number;
    /** Maximum bytes the built-in engine will read into memory. */
    maxBytes: number;
    /** Whether http(s) URL inputs are accepted. */
    allowUrls: boolean;
    /** Extra arguments appended to every external engine invocation. */
    extraArgs: string[];
}
/** Configuration schema; every field is optional in `cordis.patch.yml`. */
export declare const Config: z<Schemastery.ObjectS<{
    engine: z<string, string>;
    command: z<string, string>;
    uvxPackage: z<string, string>;
    timeoutMs: z<number, number>;
    maxChars: z<number, number>;
    maxBytes: z<number, number>;
    allowUrls: z<boolean, boolean>;
    extraArgs: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    engine: z<string, string>;
    command: z<string, string>;
    uvxPackage: z<string, string>;
    timeoutMs: z<number, number>;
    maxChars: z<number, number>;
    maxBytes: z<number, number>;
    allowUrls: z<boolean, boolean>;
    extraArgs: z<string[], string[]>;
}>>;
/**
 * Register the conversion tool.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
