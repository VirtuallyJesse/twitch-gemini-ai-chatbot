/** Keep transcript listeners attached through transport drain; console log, then storage, flush last. */
export async function shutdownRuntime({ transport, server, emotes, consoleLog, storage }) {
    for (const stop of [() => transport.stop(), () => server.stop(), () => emotes.dispose()]) {
        try {
            await stop();
        } catch (error) {
            console.error('[Shutdown] Runtime stop failed:', error?.message || error);
        }
    }
    await consoleLog?.flush();
    await storage.dispose();
}
