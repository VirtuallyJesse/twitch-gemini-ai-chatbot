/** Keep transcript listeners attached through transport drain; storage flushes last. */
export async function shutdownRuntime({ transport, server, emotes, storage }) {
    for (const stop of [() => transport.stop(), () => server.stop(), () => emotes.dispose()]) {
        try {
            await stop();
        } catch (error) {
            console.error('[Shutdown] Runtime stop failed:', error?.message || error);
        }
    }
    await storage.dispose();
}
