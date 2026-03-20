class UrlHandler {
    extractYouTubeVideoId(url) {
        const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    async fetchYouTubeMetadata(videoId, youtube_api_key) {
        if (!youtube_api_key) {
            return null;
        }

        try {
            const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${youtube_api_key}&part=snippet`);
            if (!response.ok) {
                throw new Error(`YouTube API HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (!data.items || data.items.length === 0) {
                throw new Error('Video not found');
            }

            const video = data.items[0].snippet;
            const metadata = {
                title: video.title,
                description: video.description,
                channelName: video.channelTitle
            };
            
            console.log(`✅ YouTube API Success: "${metadata.title}" by ${metadata.channelName} (${metadata.description.substring(0, 100)}${metadata.description.length > 100 ? '...' : ''})`);
            
            return metadata;
        } catch (error) {
            console.error(`Error fetching YouTube metadata for video ${videoId}:`, error.message || error);
            return null;
        }
    }
}

export default UrlHandler;