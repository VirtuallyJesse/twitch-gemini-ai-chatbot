// src/utils/dev_fixtures.js
//
// Deterministic mock fixtures engine for visual QA, manual testing,
// and UI development. Completely isolated from production runtime and local_dev.js.

export const CHATTERS = {
    VelvetNoir: { name: 'VelvetNoir', color: '#ff6b8f', badges: ['sub'] },
    GlitchGremlin: { name: 'GlitchGremlin', color: '#7ed957', badges: ['mod'] },
    NovaByte: { name: 'NovaByte', color: '#63a8ff', badges: ['vip'] },
    SynthSorrow: { name: 'SynthSorrow', color: '#d98cff', badges: ['sub', 'bits'] },
    PixelPunk99: { name: 'PixelPunk99', color: '#ffb454', badges: [] },
    DriftKing: { name: 'DriftKing', color: '#4fd8b8', badges: ['sub'] },
    LoFiLuna: { name: 'LoFiLuna', color: '#ff8a66', badges: ['vip'] },
    ByteMe: { name: 'ByteMe', color: '#5fc9e8', badges: [] },
    QuantumQueen: { name: 'QuantumQueen', color: '#ffd166', badges: ['mod'] },
    NeonBot: { name: 'NeonBot', color: '#a273ff', badges: ['bot'] }
};

export const CHANNELS = [
    { id: 'pixelforge', name: 'pixelforge', linked: true, broadcaster: 'PixelPunk99' },
    { id: 'nova_vt', name: 'nova_vt', linked: true, broadcaster: 'NovaByte' },
    { id: 'glitchden', name: 'glitchden', linked: false, broadcaster: 'GlitchGremlin' },
    { id: 'emberkat', name: 'emberkat', linked: false }
];

export const DEV_MOCK_EMOTES = {
    Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
    LUL: 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/1.0',
    PogChamp: 'https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/1.0',
    BibleThump: 'https://static-cdn.jtvnw.net/emoticons/v2/86/default/dark/1.0',
    Kreygasm: 'https://static-cdn.jtvnw.net/emoticons/v2/41/default/dark/1.0',
    HeyGuys: 'https://static-cdn.jtvnw.net/emoticons/v2/30259/default/dark/1.0',
    NotLikeThis: 'https://static-cdn.jtvnw.net/emoticons/v2/58765/default/dark/1.0',
    SeemsGood: 'https://static-cdn.jtvnw.net/emoticons/v2/64138/default/dark/1.0',
    VoHiYo: 'https://static-cdn.jtvnw.net/emoticons/v2/81274/default/dark/1.0',
    '<3': 'https://static-cdn.jtvnw.net/emoticons/v2/9/default/dark/1.0',
    monkaS: 'https://cdn.betterttv.net/emote/566c9fde65dbbdab32ec053e/1x.webp',
    KEKW: 'https://cdn.betterttv.net/emote/5e9c6c187e090362f8b0b9e8/1x',
    catJAM: 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/1x',
    Clap: 'https://cdn.betterttv.net/emote/55b6f480e66682f576dd94f5/1x',
    FeelsGoodMan: 'https://cdn.betterttv.net/emote/566c9fde65dbbdab32ec053e/1x.webp',
    PepeHands: 'https://cdn.betterttv.net/emote/59f27b3f4ebd8047f54dee29/1x',
    EZ: 'https://cdn.betterttv.net/emote/5590b223b344e2c42a9e28e3/1x',
    OMEGALUL: 'https://cdn.7tv.app/emote/60ae958e229664e8667aea38/1x.webp',
    widepeepoHappy: 'https://cdn.7tv.app/emote/01GF1Y2Q5G0000BGNJSP34TQRD/1x.webp',
    CatBag: 'https://cdn.frankerfacez.com/emote/25927/1',
    Pog: 'https://cdn.frankerfacez.com/emote/210748/1'
};

const IMG_POOL = [
    { url: '/media/img1.jpg', prompt: 'neon cyberpunk fox spirit, glowing synthwave palette', cmd: '!image' },
    { url: '/media/img2.jpg', prompt: 'surreal floating islands with waterfalls at golden dusk', cmd: '!image' },
    { url: '/media/img3.jpg', prompt: 'retro-futuristic astronaut drifting through a vaporwave sunset', cmd: '!image' },
    { url: '/media/img4.jpg', prompt: 'bioluminescent jellyfish forest in a deep sea trench', cmd: '!image' },
    { url: '/media/img5.jpg', prompt: 'cozy pixel-art fantasy tavern, warm hearth light', cmd: '!image' },
    { url: '/media/img6.jpg', prompt: 'cybernetic samurai in violet rain, glitchcore portrait', cmd: '!image' },
    { url: '/media/img7.jpg', prompt: 'long-exposure light ritual, electric ribbons in the void', cmd: '!image' },
    { url: '/media/img8.jpg', prompt: 'chromatic ink storms colliding in zero gravity', cmd: '!image' },
    { url: '/media/img9.jpg', prompt: 'rain-slick megacity at 3am, neon bleeding into puddles', cmd: '!image' },
    { url: '/media/img10.jpg', prompt: 'iridescent holo-silk folding through hyperspace', cmd: '!image' }
];

const VID_POOL = [
    { url: '/media/vid1.mp4', prompt: 'endless neon tunnel pulsing to a synthwave beat', cmd: '!video' },
    { url: '/media/vid2.mp4', prompt: 'living ink nebula blooming in slow motion', cmd: '!video' },
    { url: '/media/vid3.mp4', prompt: 'cyberpunk street timelapse, ghosts of headlights', cmd: '!video' },
    { url: '/media/vid4.mp4', prompt: 'plasma aurora breathing over a glass desert', cmd: '!video' },
    { url: 'https://i.nuuls.com/rcUxQ.mp4', prompt: 'unedited chatter clip, straight off the cdn', cmd: '!video' }
];

const AUD_POOL = [
    { url: '/media/aud1.wav', prompt: 'lo-fi synthwave lullaby for insomniac androids', type: 'music', cmd: '!song' },
    { url: '/media/aud2.wav', prompt: 'retro coin cascade with a laser zap finish', type: 'tts', cmd: '!tts' },
    { url: '/media/aud3.wav', prompt: 'haunted mall announcer welcoming lost souls', type: 'tts', cmd: '!tts' },
    { url: '/media/aud4.wav', prompt: 'rainy night phonk with vinyl crackle', type: 'music', cmd: '!song' }
];

const RAW_LOGS = {
    pixelforge: [
        { kind: 'event', event: 'online', text: 'stream went live · Art + AI · 1080p60' },
        { user: 'PixelPunk99', text: 'yo the queue is moving fast tonight PogChamp' },
        { user: 'VelvetNoir', text: '!image neon cyberpunk fox spirit portrait' },
        { user: 'NeonBot', text: 'queued @VelvetNoir · job #4821 · eta 14s · style: synthwave' },
        { user: 'GlitchGremlin', text: 'chat behave, the bot is cooking Kappa' },
        { user: 'NovaByte', text: 'that last render was insane OMEGALUL' },
        { user: 'NeonBot', text: '@VelvetNoir your image is ready → https://neonbot.app/g/4821 · archived to gallery' },
        { user: 'SynthSorrow', text: 'THE FOX PogChamp THE FOX widepeepoHappy' },
        { kind: 'event', event: 'raid', text: 'nova_vt raided the channel with 214 viewers' },
        { user: 'LoFiLuna', text: 'raid landed HeyGuys HeyGuys' },
        { user: 'DriftKing', text: 'ok that one goes hard, saving it as wallpaper SeemsGood' },
        { user: 'ByteMe', text: '!song lo-fi synthwave lullaby for insomniac androids' },
        { user: 'NeonBot', text: 'composing 32 bars for @ByteMe · bpm 72 · key F#m' },
        { kind: 'event', event: 'cheer', text: 'SynthSorrow cheered 500 bits' },
        { user: 'LoFiLuna', text: 'bot got better taste in music than half this chat KEKW' },
        { user: 'QuantumQueen', text: 'reminder: prompts with artist names get auto-rejected, keep it clean' },
        { user: 'PixelPunk99', text: '<3 this stream is my serotonin catJAM' },
        { user: 'NeonBot', text: '@ByteMe your track is live → https://neonbot.app/g/4822 · 0:13' },
        { kind: 'event', event: 'sub', text: 'DriftKing subscribed at Tier 1 · 7 month streak' },
        { user: 'NovaByte', text: '!video endless neon tunnel pulsing to a synthwave beat' },
        { user: 'VelvetNoir', text: 'fox supremacy Clap next up a whole fox army' },
        { kind: 'event', event: 'gift', text: 'QuantumQueen gifted 5 subs to the community' },
        { user: 'ByteMe', text: 'gallery is straight heat tonight FeelsGoodMan' },
        { user: 'NeonBot', text: 'video pipeline engaged for @NovaByte · eta 38s' }
    ],
    nova_vt: [
        { kind: 'event', event: 'online', text: 'stream went live · vtuber gen night' },
        { user: 'NovaByte', text: 'welcome raiders, bot commands are !image !video !song !tts' },
        { user: 'DriftKing', text: '!video cyberpunk street timelapse, ghosts of headlights' },
        { user: 'NeonBot', text: 'queued @DriftKing · job #1207 · video pipeline warm · eta 40s' },
        { user: 'SynthSorrow', text: 'video gen on this channel is criminally underrated Pog' },
        { user: 'ByteMe', text: 'fps on those loops is butter smooth monkaS actually how' },
        { user: 'NeonBot', text: '@DriftKing your clip is ready → https://neonbot.app/g/1207 · 8s loop' },
        { kind: 'event', event: 'follow', text: 'pixel_wanderer followed the channel' },
        { user: 'QuantumQueen', text: 'mods are watching the prompt queue, keep it wholesome Kappa' },
        { user: 'PixelPunk99', text: 'can the bot do pixel art? asking for me BibleThump' },
        { user: 'NeonBot', text: 'yes @PixelPunk99 — try !image with style:pixel · 16 palettes loaded' },
        { user: 'VelvetNoir', text: 'pixel tavern when LUL' },
        { user: 'GlitchGremlin', text: 'clip that, the bot just flexed EZ Clap' },
        { kind: 'event', event: 'sub', text: 'LoFiLuna subscribed at Tier 2 · 3 month streak' },
        { user: 'SynthSorrow', text: '!image holo-silk folding through hyperspace' },
        { user: 'NeonBot', text: 'queued @SynthSorrow · job #1210 · eta 12s' },
        { user: 'DriftKing', text: 'hyperspace silk?? this chat is unhinged KEKW' },
        { user: 'NeonBot', text: 'render complete → https://neonbot.app/g/1210 · gallery archive updated' },
        { user: 'LoFiLuna', text: 'every render is a banger, no misses VoHiYo' },
        { user: 'ByteMe', text: 'W bot W chat W stream Kreygasm' }
    ],
    glitchden: [
        { user: 'GlitchGremlin', text: 'late night gen hours, best hours Kappa' },
        { user: 'SynthSorrow', text: '!image cybernetic samurai in violet rain' },
        { user: 'NeonBot', text: 'queued @SynthSorrow · job #7719 · eta 11s · style: glitchcore' },
        { user: 'ByteMe', text: 'the den delivers again catJAM' },
        { user: 'NeonBot', text: '@SynthSorrow your image is ready → https://neonbot.app/g/7719' },
        { user: 'LoFiLuna', text: 'chromatic aberration goes brrrr OMEGALUL' },
        { user: 'QuantumQueen', text: '!song rainy night phonk with vinyl crackle' },
        { user: 'DriftKing', text: 'phonk at 2am is a lifestyle widepeepoHappy' },
        { user: 'NeonBot', text: '@QuantumQueen your track is live → https://neonbot.app/g/7720 · 0:12' },
        { user: 'PixelPunk99', text: 'this bot needs a raise fr <3' },
        { user: 'NovaByte', text: 'imagine paying your bot KEKW it runs on hype alone' },
        { user: 'ByteMe', text: '!tts retro coin cascade with a laser zap finish' },
        { user: 'NeonBot', text: 'sfx ready → https://neonbot.app/g/7721 · 0:03 · archived' },
        { user: 'VelvetNoir', text: 'PETTHEBOT CatBag PETTHEBOT' },
        { user: 'QuantumQueen', text: '!tts haunted mall announcer welcoming lost souls' },
        { user: 'NeonBot', text: 'voice clip ready for @QuantumQueen → https://neonbot.app/g/7722 · archived' },
        { user: 'PixelPunk99', text: 'den never misses PepeHands im emotional' }
    ],
    emberkat: []
};

function mulberry32(seed) {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function generateMockMedia(count = 72) {
    const rnd = mulberry32(0xc0ffee);
    const authors = Object.keys(CHATTERS).filter((n) => n !== 'NeonBot');
    const channels = ['pixelforge', 'nova_vt', 'glitchden'];
    const now = Date.now();
    const out = [];

    let elapsedMinutes = 5;

    for (let i = 0; i < count; i++) {
        const roll = rnd();
        const author = authors[Math.floor(rnd() * authors.length)];
        const channel = channels[Math.floor(rnd() * channels.length)];
        const chatter = CHATTERS[author] || { color: '#a273ff', badges: [] };
        const timestamp = now - elapsedMinutes * 60 * 1000;

        if (roll < 0.55) {
            const item = IMG_POOL[Math.floor(rnd() * IMG_POOL.length)];
            out.push({
                id: `dev-img-${i}`,
                timestamp,
                channel,
                username: author,
                command: item.cmd,
                prompt: item.prompt,
                mediaUrl: item.url,
                mediaType: 'image',
                color: chatter.color,
                badges: chatter.badges
            });
        } else if (roll < 0.80) {
            const item = VID_POOL[Math.floor(rnd() * VID_POOL.length)];
            out.push({
                id: `dev-vid-${i}`,
                timestamp,
                channel,
                username: author,
                command: item.cmd,
                prompt: item.prompt,
                mediaUrl: item.url,
                mediaType: 'video',
                color: chatter.color,
                badges: chatter.badges
            });
        } else {
            const item = AUD_POOL[Math.floor(rnd() * AUD_POOL.length)];
            out.push({
                id: `dev-aud-${i}`,
                timestamp,
                channel,
                username: author,
                command: item.cmd,
                prompt: item.prompt,
                mediaUrl: item.url,
                mediaType: item.type,
                color: chatter.color,
                badges: chatter.badges
            });
        }

        elapsedMinutes += 4 + Math.floor(rnd() * 95);
    }

    return out;
}

export function generateMockChatLogs() {
    const out = {};
    const now = Date.now();

    for (const [chan, rawList] of Object.entries(RAW_LOGS)) {
        if (!rawList.length) {
            out[chan] = [];
            continue;
        }

        const rnd = mulberry32(chan.charCodeAt(0) * 881 + chan.length * 37);
        let t = now - (rawList.length * 45 * 1000);

        out[chan] = rawList.map((entry, idx) => {
            t += (15 + Math.floor(rnd() * 50)) * 1000;
            const chatter = entry.user ? CHATTERS[entry.user] : null;

            if (entry.kind === 'event') {
                return {
                    id: `${chan}-evt-${idx}`,
                    timestamp: t,
                    event: entry.event,
                    text: entry.text
                };
            }

            return {
                id: `${chan}-msg-${idx}`,
                timestamp: t,
                username: entry.user,
                text: entry.text,
                color: chatter?.color,
                badges: chatter?.badges || []
            };
        });
    }

    return out;
}

export async function seedStorageWithFixtures(storage) {
    if (!storage) return;

    // 1. Seed Media entries
    const mediaItems = generateMockMedia(64);
    for (let i = mediaItems.length - 1; i >= 0; i--) {
        await storage.addMediaEntry(mediaItems[i]);
    }

    // 2. Seed Chat entries
    const logsByChannel = generateMockChatLogs();
    for (const [channel, messages] of Object.entries(logsByChannel)) {
        const chanKey = channel.startsWith('#') ? channel : `#${channel}`;
        for (const msg of messages) {
            await storage.addChatMessage(chanKey, msg);
        }
    }
}
