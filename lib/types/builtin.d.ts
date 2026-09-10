/** Thrown when the built-in engine is asked for a format it cannot read. */
export declare class BuiltinUnsupportedError extends Error {
    constructor(message: string);
}
/**
 * Whether the built-in engine claims a file name at all.
 * @param name - file name or path.
 * @returns true when a native or plain-text converter exists.
 */
export declare function builtinSupports(name: string): boolean;
/**
 * Convert raw bytes with the built-in engine.
 * @param bytes - whole file content.
 * @param name - file name used to pick the converter (a URL path is fine).
 * @returns Markdown text.
 */
export declare function convertBuiltin(bytes: Buffer, name: string): string;
/**
 * Convert a Markdown document served over HTTP by reading it as text.
 * @param body - response text.
 * @param contentType - response `content-type`, when known.
 * @param name - a name to derive the converter from.
 * @returns Markdown text.
 */
export declare function convertBuiltinResponse(body: Buffer, contentType: string, name: string): string;
