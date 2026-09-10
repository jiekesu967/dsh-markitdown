/**
 * The engine chain: find the best available MarkItDown implementation once, then
 * reuse it for the life of the plugin fiber.
 *
 * Preference order is deliberate. Microsoft's own CLI wins when it is installed;
 * `uvx` comes next because it runs the real package with no permanent install;
 * a Python interpreter already carrying the package is third; the built-in
 * converter is the floor that keeps the tool useful with nothing installed.
 */
import { ExecutableNotFoundError, run, which } from './exec.js';
const PYTHON_ENV = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
};
/** Resolves and caches the engine for one plugin instance. */
export class EngineChain {
    #choice;
    #command;
    #uvxPackage;
    #probeTimeoutMs;
    #cached;
    #log = [];
    constructor(options) {
        this.#choice = options.choice;
        this.#command = options.command;
        this.#uvxPackage = options.uvxPackage ?? 'markitdown[all]';
        this.#probeTimeoutMs = options.probeTimeoutMs;
    }
    /** Probe transcript of the most recent resolution, for diagnostics. */
    get log() {
        return this.#log;
    }
    /** Forget the cached engine so the next call re-probes. */
    invalidate() {
        this.#cached = undefined;
    }
    /**
     * Resolve the engine to use, probing once and caching the winner.
     * @param signal - cancellation for the probe itself.
     * @returns the resolved engine.
     * @throws Error when an explicitly requested engine is unavailable.
     */
    async resolve(signal) {
        if (this.#cached !== undefined)
            return this.#cached;
        const options = { signal, timeoutMs: this.#probeTimeoutMs };
        this.#log = [];
        const order = this.#choice === 'auto' ? ['markitdown', 'uvx', 'python', 'builtin'] : [this.#choice];
        for (const id of order) {
            const engine = await this.#probe(id, options);
            if (engine !== undefined) {
                this.#cached = engine;
                return engine;
            }
            if (this.#choice !== 'auto') {
                throw new Error(`engine "${this.#choice}" is not available. ${this.#log.join('; ')}. ` +
                    'Install Microsoft MarkItDown (pip install "markitdown[all]"), install uv (https://docs.astral.sh/uv/) ' +
                    'so `uvx markitdown` works, or set engine to "builtin".');
            }
        }
        throw new Error(`no conversion engine is available. ${this.#log.join('; ')}`);
    }
    async #probe(id, options) {
        switch (id) {
            case 'builtin':
                this.#log.push('builtin: always available');
                return { id, label: 'built-in converter (no external dependency)', argv: [], env: undefined, internal: true };
            case 'markitdown': {
                const found = this.#command === undefined ? await which('markitdown', options) : { path: this.#command };
                if ('reason' in found) {
                    this.#log.push(`markitdown: ${found.reason}`);
                    return undefined;
                }
                if (!(await this.#responds([found.path, '--help'], options))) {
                    this.#log.push(`markitdown: ${found.path} did not respond to --help`);
                    return undefined;
                }
                this.#log.push(`markitdown: ${found.path}`);
                return { id, label: `markitdown CLI (${found.path})`, argv: [found.path], env: undefined, internal: false };
            }
            case 'uvx': {
                const found = await which('uvx', options);
                if ('reason' in found) {
                    this.#log.push(`uvx: ${found.reason}`);
                    return undefined;
                }
                if (!(await this.#responds([found.path, '--version'], options))) {
                    this.#log.push(`uvx: ${found.path} did not respond to --version`);
                    return undefined;
                }
                this.#log.push(`uvx: ${found.path} (first conversion downloads ${this.#uvxPackage})`);
                return {
                    id,
                    label: `uvx ${this.#uvxPackage} (${found.path})`,
                    argv: [found.path, '--from', this.#uvxPackage, 'markitdown'],
                    env: PYTHON_ENV,
                    internal: false,
                };
            }
            case 'python': {
                let anyReason = 'python is not on PATH';
                for (const name of ['python', 'python3', 'py']) {
                    const found = await which(name, options);
                    if ('reason' in found) {
                        anyReason = found.reason;
                        continue;
                    }
                    if (!(await this.#responds([found.path, '-m', 'markitdown', '--help'], options))) {
                        anyReason = `${found.path} has no markitdown module`;
                        continue;
                    }
                    this.#log.push(`python: ${found.path} -m markitdown`);
                    return {
                        id,
                        label: `python -m markitdown (${found.path})`,
                        argv: [found.path, '-m', 'markitdown'],
                        env: PYTHON_ENV,
                        internal: false,
                    };
                }
                this.#log.push(`python: ${anyReason}`);
                return undefined;
            }
        }
    }
    async #responds(argv, options) {
        try {
            await run(argv, options);
            return true;
        }
        catch (error) {
            if (error instanceof ExecutableNotFoundError)
                return false;
            // A non-zero exit from `--help` still proves the program is installed and
            // executable, which is all the probe needs to establish.
            return /exited with status/.test(String(error));
        }
    }
}
/**
 * Run one conversion through an external engine.
 * @param engine - the resolved engine; must not be the built-in one.
 * @param input - absolute process path or URL handed to the engine.
 * @param options - deadline, cancellation, and extra CLI arguments.
 * @returns the converted Markdown and the engine's standard error.
 * @throws Error when the engine fails or produces no output.
 */
export async function convertExternal(engine, input, options) {
    const argv = [...engine.argv, ...(options.extraArgs ?? []), input];
    let result;
    try {
        result = await run(argv, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            ...(engine.env === undefined ? {} : { env: engine.env }),
        });
    }
    catch (error) {
        if (error instanceof ExecutableNotFoundError) {
            throw new Error(`${engine.label} disappeared while converting ${input}: ${error.message}`);
        }
        throw error;
    }
    const markdown = result.stdout.replace(/^\uFEFF/, '');
    if (markdown.trim() === '') {
        throw new Error(`${engine.label} produced no Markdown for ${input}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`);
    }
    return { markdown, stderr: filterEngineNoise(result.stderr) };
}
/**
 * Drop the package-manager progress `uvx` prints on first use, keeping anything
 * that looks like a real diagnostic. Without this the first conversion returns
 * fifteen lines of download chatter to the model alongside the document.
 * @param stderr - raw standard error from the engine.
 * @returns the remaining diagnostic lines, trimmed.
 */
export function filterEngineNoise(stderr) {
    const noise = /^\s*(Downloading|Downloaded|Installed|Resolved|Prepared|Audited|Building|Built|Installing|Uninstalling|Uninstalled|Creating|Updating|Updated|Using|Removed|warning: The `|note: )/;
    return stderr
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== '' && !noise.test(line))
        .join('\n')
        .trim();
}
//# sourceMappingURL=engine.js.map