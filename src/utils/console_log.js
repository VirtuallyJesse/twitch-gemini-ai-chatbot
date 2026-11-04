// src/utils/console_log.js
//
// Byte-capped mirror of the process console for the admin log download.
// capture() tees stream writes into timestamped, secret-redacted lines;
// persistTo() appends new lines to storage in batches, so the window survives
// restarts without writing while idle. Storage holds the only full copy, so a
// download also sees lines appended by an overlapping instance during a deploy.
// All configuration crosses the constructor; this module reads zero process.env variables.

import { createRedactor } from './execution_trace.js';

const STORAGE_KEY = 'console_log';
// ~500 normal chat turns (~4 KB each) or fewer AI_VERBOSE turns; the stored
// copy grows to 2x before compaction, well under Upstash's 10 MB request cap.
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LINE_CHARS = 64 * 1024;
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const defaultTimers = { setInterval: (...args) => setInterval(...args) };

/** Keeps the newest whole lines of text that fit in maxBytes. */
function tail(text, maxBytes) {
    const buffer = Buffer.from(text);
    if (buffer.length <= maxBytes) return text;
    const cut = buffer.subarray(buffer.length - maxBytes);
    return cut.subarray(cut.indexOf(10) + 1).toString('utf8');
}

export class ConsoleLog {
    #unsaved = [];
    #unsavedBytes = 0;
    #storage = null;
    #flushing = Promise.resolve();
    #redact;
    #maxBytes;
    #flushIntervalMs;
    #now;
    #timers;

    constructor({
        redactions = [],
        maxBytes = DEFAULT_MAX_BYTES,
        flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
        now = () => new Date(),
        timerImpl = defaultTimers
    } = {}) {
        this.#redact = createRedactor(redactions);
        this.#maxBytes = maxBytes;
        this.#flushIntervalMs = flushIntervalMs;
        this.#now = now;
        this.#timers = timerImpl;
    }

    /** Tees each stream's writes into the log; the stream's own output is untouched. */
    capture(...streams) {
        for (const stream of streams) {
            const write = stream.write.bind(stream);
            let pending = '';
            stream.write = (chunk, ...rest) => {
                try {
                    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                    const parts = pending.split('\n');
                    pending = parts.pop();
                    if (pending.length > MAX_LINE_CHARS) {
                        parts.push(pending);
                        pending = '';
                    }
                    for (const part of parts) this.#push(part);
                } catch {
                    // Logging must never break because the mirror failed.
                }
                return write(chunk, ...rest);
            };
        }
    }

    /** Starts appending captured lines to storage every interval. */
    persistTo(storage) {
        this.#storage = storage;
        this.#timers.setInterval(() => this.flush(), this.#flushIntervalMs)?.unref?.();
    }

    /** Writes lines captured since the last flush; a no-op when nothing is new. */
    flush() {
        this.#flushing = this.#flushing.then(() => this.#write()).catch(() => {});
        return this.#flushing;
    }

    /** Flushes, then returns the newest maxBytes of log text; unsaved lines stand in when storage is unreachable. */
    async text() {
        await this.flush();
        const stored = this.#storage ? await this.#storage.getValue(STORAGE_KEY) : null;
        const unsaved = this.#unsaved.length ? `${this.#unsaved.join('\n')}\n` : '';
        return tail(`${stored ?? ''}${unsaved}`, this.#maxBytes);
    }

    #push(raw) {
        const clean = this.#redact(raw.replace(ANSI_PATTERN, '').replace(/\r$/, ''));
        const body = clean.length > MAX_LINE_CHARS
            ? `${clean.slice(0, MAX_LINE_CHARS)} [truncated ${clean.length - MAX_LINE_CHARS} chars]`
            : clean;
        this.#unsaved.push(`${this.#now().toISOString()} ${body}`);
        this.#unsavedBytes += Buffer.byteLength(this.#unsaved.at(-1)) + 1;
        this.#trimUnsaved();
    }

    #trimUnsaved() {
        while (this.#unsavedBytes > this.#maxBytes && this.#unsaved.length > 1) {
            this.#unsavedBytes -= Buffer.byteLength(this.#unsaved.shift()) + 1;
        }
    }

    async #write() {
        if (!this.#storage || this.#unsaved.length === 0) return;
        const batch = this.#unsaved;
        this.#unsaved = [];
        this.#unsavedBytes = 0;
        const length = await this.#storage.appendValue(STORAGE_KEY, `${batch.join('\n')}\n`);
        if (length == null) {
            // Keep the batch for the next flush, ahead of anything logged meanwhile.
            this.#unsaved = [...batch, ...this.#unsaved];
            this.#unsavedBytes = this.#unsaved.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
            this.#trimUnsaved();
            return;
        }
        if (length > 2 * this.#maxBytes) {
            const stored = await this.#storage.getValue(STORAGE_KEY);
            if (stored != null) await this.#storage.setValue(STORAGE_KEY, tail(stored, this.#maxBytes));
        }
    }
}
