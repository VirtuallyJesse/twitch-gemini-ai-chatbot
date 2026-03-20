const render_url = process.env.RENDER_EXTERNAL_URL;

if (!render_url) {
    console.log("No RENDER_EXTERNAL_URL found. Please set it as environment variable.");
}

const job = {
    start: () => {
        if (!render_url) {
            console.log("Keep-alive ping disabled: RENDER_EXTERNAL_URL not set.");
            return;
        }

        // Target the lightweight /healthz endpoint instead of root
        const url = render_url.endsWith('/') ? `${render_url}healthz` : `${render_url}/healthz`;
        
        console.log(`Starting keep-alive ping for ${url} every 5 minutes.`);

        // Ping every 5 minutes (300,000 milliseconds) to prevent Render free tier from sleeping (15m timeout)
        setInterval(() => {
            fetch(url, { cache: 'no-store' })
                .then(response => {
                    if (!response.ok) {
                        console.log(`Keep-alive ping failed with status: ${response.status}`);
                    }
                })
                .catch(error => {
                    console.log(`Keep-alive ping error: ${error.message}`);
                });
        }, 5 * 60 * 1000);
    }
};

export { job };
