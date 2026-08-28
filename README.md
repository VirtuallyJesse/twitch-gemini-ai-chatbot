<div align="center">

<img src="assets/banner.png" alt="Twitch Gemini Chatbot Banner" width="100%">

# Twitch Gemini Chatbot

**A free, AI-powered Twitch chatbot running on Google Gemini. Deploys in minutes, runs 24/7.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](#license)

</div>

---

## Features

<div align="center">
<img src="assets/features.png" alt="Features Overview" width="100%">
</div>

---

## Quick Start

A high-level checklist — the [Tutorial](#tutorial) below covers every step in detail.

1. **Fork this repository** to your GitHub account
2. **Create a Twitch application** at [`dev.twitch.tv/console`](https://dev.twitch.tv/console) — note your Client ID & Secret
3. **Get Gemini API key(s)** from [`console.cloud.google.com`](https://console.cloud.google.com/)
4. **Create an Upstash Redis database** at [`console.upstash.com`](https://console.upstash.com) — copy the Redis connection string
5. *(Optional)* **Get a Tavily API key** from [`app.tavily.com`](https://app.tavily.com) to enable live web search
6. *(Optional)* **Get a Pollinations API key** from [`enter.pollinations.ai`](https://enter.pollinations.ai) to use Pollinations for media generation
7. **Deploy your fork to Render** and fill in your environment variables
8. **Authorize the bot** at `https://YOUR-APP.onrender.com/auth/login`
9. **Open your dashboard** at `https://YOUR-APP.onrender.com/` to join channels and customize personality, commands, models, and alerts

That's it. No local install. No terminal commands.

---

## Tutorial

Full walkthrough for each requirement. Complete these in order.

<!-- ─── 1. FORK & DEPLOY ─────────────────────────────────── -->

<details>
<summary><strong>1 — Fork & Deploy to Render</strong></summary>

<br>

#### 1. Fork the repository

1. Click **Fork** at the top right of this GitHub repo
2. Click **Create Fork** to make a copy in your own GitHub account

> 💡 Forking keeps your bot isolated and stable so updates here never restart your bot mid-stream. You do not need to edit any code or files.

#### 2. Deploy to Render

Click the button below to deploy your fork:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Sign into [Render](https://render.com) with your **GitHub account**
2. Render will detect your fork and open the Blueprint form
3. Fill in the environment variables as you complete the sections below
4. Click **Deploy Blueprint** once every value is ready

</details>

<!-- ─── 2. TWITCH ──────────────────────────────────────── -->

<details>
<summary><strong>2 — Twitch Setup</strong></summary>

<br>

To give your bot its own name and chat badge, you'll use two Twitch accounts:
1. **Your Streamer Account** (where you go live)
2. **Your Bot Account** (a separate Twitch account created for your bot)

> 💡 **Tip:** Keep your main browser logged into your **Streamer account**, and open an **Incognito window** logged into your **Bot account**.

#### 1. Create the Twitch application

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console) and sign in with your **main Twitch account**
2. Click **Register Your Application**
3. Fill in the form:
   - **Name:** anything you like (e.g. `My Stream Bot`)
   - **OAuth Redirect URL:** `https://YOUR-APP.onrender.com/auth/callback`  
     *(Replace `YOUR-APP` with your Render service name)*
   - **Category:** `Chat Bot`
4. Click **Create**

#### 2. Get your credentials

1. Click **Manage** on your new application
2. Copy the **Client ID**
3. Click **New Secret** and copy the **Client Secret**

#### 3. Render environment variables

| Variable | What to enter |
|---|---|
| `TWITCH_USERNAME` | Your **bot account's** username (lowercase) |
| `ADMIN_USERNAMES` | Your **streamer account's** username (grants access to dashboard settings) |
| `TWITCH_CLIENT_ID` | The Client ID copied above |
| `TWITCH_CLIENT_SECRET` | The Client Secret copied above |

#### 4. Connect and configure your accounts (after Render deploys)

1. In your **Bot's Incognito window**, visit:
   ```
   https://YOUR-APP.onrender.com/auth/login
   ```
   Click **Authorize** to connect the bot to chat.

2. In your **Streamer browser**, open your dashboard:
   ```
   https://YOUR-APP.onrender.com/
   ```
   - Click **Sign in with Twitch** in the top right.
   - Click the **`[Link Broadcaster]`** button next to your channel name to enable stream controls and live alerts.
   - Click your profile name → **⚙️ Bot Configuration** to customize persona, commands, and alerts.

3. **Mod the Bot:** In your Twitch stream chat, type `/mod yourbotusername` so the bot can use its full toolkit.

</details>

<!-- ─── 3. GEMINI ──────────────────────────────────────── -->

<details>
<summary><strong>3 — Gemini API Keys</strong></summary>

<br>

> ⚠️ Create your keys through the **Google Cloud Console** — not Google AI Studio. Keys created in the Cloud Console are managed separately and behave differently.

#### Create a project

1. Go to [`console.cloud.google.com`](https://console.cloud.google.com/) and sign in with your Google account
2. Click the **project dropdown** at the top of the page, then **New Project**
3. Name it anything (e.g. `gemini-bot-1`) and click **Create**

#### Enable the Gemini API

1. With your new project selected, go to **APIs & Services → Library**
   - Direct link: [`console.cloud.google.com/apis/library`](https://console.cloud.google.com/apis/library)
2. Search for **Generative Language API**
3. Click it, then click **Enable**

#### Create an API key

1. Go to **APIs & Services → Credentials**
   - Direct link: [`console.cloud.google.com/apis/credentials`](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → API key**
3. Copy the generated key — it starts with `AIza`

#### Multiple keys (recommended)

Each key is tied to one project and gets its own daily quota — more keys = more capacity. Repeat all three steps above for as many projects as your account allows. Most accounts can create 5–15 projects.

The `GEMINI_API_KEY` environment variable accepts **multiple comma-separated keys** and rotates through them automatically.

#### Render environment variable

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | One or more keys, e.g. `Key1,Key2,Key3` |

> 💡 **Optional:** To give Gemini extra context on YouTube links (video title, description), create a YouTube Data API v3 key from the same [Credentials page](https://console.cloud.google.com/apis/credentials) and add it as `YOUTUBE_API_KEY`.

</details>

<!-- ─── 4. UPSTASH ─────────────────────────────────────── -->

<details>
<summary><strong>4 — Upstash Redis Setup</strong></summary>

<br>

Upstash provides a free persistent database that stores chat logs, media history, and OAuth tokens across Render restarts.

#### Create a database

1. Go to [console.upstash.com](https://console.upstash.com) and create an account
2. Click **Create Database**
3. Give it a name (e.g. `twitch-bot`)
4. Select a region close to your Render region (e.g. **US-East-1** for Virginia)
5. Select the **Free** tier
6. Click **Create**

#### Get the connection string

1. On the database details page, find the **Redis** section
2. Copy the connection string that looks like:
   ```
   redis://default:xxxxxxxxxxxx@us1-xxxxxx.upstash.io:6379
   ```

#### Render environment variable

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_URL` | The full `redis://...` connection string |

</details>

<!-- ─── 5. TAVILY ──────────────────────────────────────── -->

<details>
<summary><strong>5 — Tavily Web Search Setup (optional)</strong></summary>

<br>

Tavily lets the bot look up real-time facts — scores, patch notes, breaking news, anything Gemini wouldn't know on its own.

#### Get your API key

1. Go to [app.tavily.com](https://app.tavily.com) and sign up
2. Copy your API key from the dashboard

#### Render environment variable

| Variable | Value |
|---|---|
| `TAVILY_API_KEY` | Your Tavily API key |

To turn search on, open your dashboard settings and set **Web search** to `Tavily`.

> 💡 The free tier gives you 1,000 searches a month, resetting on the 1st — plenty for daily chat use.

</details>

<!-- ─── 6. MEDIA ──────────────────────────────────────── -->

<details>
<summary><strong>6 — Media Generation (optional)</strong></summary>

<br>

The bot can create images, videos, voice clips, and music with Google and Pollinations.

Your Google key from step 3 already covers Google media models. To use Pollinations models as well, add a Pollinations API key:

#### Get your API key

1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Log in with your **GitHub account**
3. Create an API key in your dashboard
4. Copy the key

#### Render environment variable

| Variable | Value |
|---|---|
| `POLLINATIONS_API_KEY` | Your Pollinations API key |

You can switch models or providers anytime in your dashboard under **Commands**.

</details>

<!-- ─── 7. DASHBOARD CONFIG ─────────────────────────────── -->

<details>
<summary><strong>7 — Dashboard & Bot Customization</strong></summary>

<br>

Your Render URL (`https://YOUR-APP.onrender.com`) is your live control center. Sign in with Twitch and click your name → **⚙️ Bot Configuration** to customize:

- **Configuration.** Which channels the bot joins and how it behaves in chat. Plus search, emotes, and stream actions.
- **Persona.** Write your bot's personality, tone, and channel rules.
- **Commands.** Tune the media commands (`!image`, `!video`, `!tts`, `!song`). Rename them, switch models, and set who can use them. Add custom text commands like `!discord` below.
- **Alerts.** Toggle and customize AI or static celebrations for subs, raids, cheers, follows, and channel points.
- **Errors.** Fine-tune chat fallback notices if external services go down.

> 💡 All dashboard changes save instantly.

</details>

---

## FAQ

<details>
<summary><strong>How much can I use the bot each day?</strong></summary>

<br>

On the free tier, each API key under a project at [`console.cloud.google.com`](https://console.cloud.google.com/) gets around 20 calls per day. Your account may have anywhere from 5–15 available projects depending on account age, giving you 100–300 API calls per day. The `GEMINI_API_KEY` env var accepts multiple comma-separated keys and rotates through them automatically.

</details>

<details>
<summary><strong>Does the bot react to subs, bits, and raids?</strong></summary>

<br>

Yes, the bot automatically celebrates new subs, gift bombs, cheers, raids, and channel point redemptions in chat. You can toggle alerts, tweak templates, and adjust bit/viewer thresholds directly in your dashboard under **Alerts**.

</details>

<details>
<summary><strong>Can I ask the bot to do things on Twitch, not just chat?</strong></summary>

<br>

Yes. Depending on who's asking, the bot can:

- Change the stream category or title
- Timeout disruptive chatters
- Send a highlighted announcement
- Shout out another streamer
- Create a clip

Just ask in chat, e.g. `@mybot change the category to Just Chatting` or `@mybot clip that!`

Changing the title/category, timeouts, announcements, and shoutouts are limited to the broadcaster and moderators. Anyone in chat can ask for a clip.

</details>

<details>
<summary><strong>Can I turn off the bot's Twitch actions?</strong></summary>

<br>

Yes. In your dashboard, open **Settings → Configuration** and turn off **Stream actions**. The bot goes back to pure Q&A.

You can also tune **Clip Cooldown** and **Timeout Duration** below the toggle.

</details>

<details>
<summary><strong>Does the bot search the web?</strong></summary>

<br>

Yes, if you set it up. Add your `TAVILY_API_KEY` in Render, then set **Settings → Configuration → Web search** to `Tavily`.

Leave it on `Off` and the bot skips search — it still answers from its own knowledge, and you can still paste it a link directly to read via URL context.

`Google` uses Gemini's own built-in search instead of Tavily. This only works with a **paid** Gemini key, so stick to `Tavily` or `Off` unless you're already paying for Gemini.

</details>

<details>
<summary><strong>What happens when I run out of Tavily searches?</strong></summary>

<br>

The bot detects it automatically and falls back to answering without search.

The free tier gives 1,000 credits/month (basic search = 1 credit). How long that lasts depends on your chat's activity:

| Chat activity | ~Searches/day | Lasts you |
|---|---|---|
| Light | 10 | All month, with room to spare |
| Moderate | 50 | ~20 days |
| Busy | 200 | ~5 days |

> 💡 `TAVILY_SEARCH_DEPTH=advanced` costs 2 credits/search — roughly halve these numbers if you switch to it.

</details>

<details>
<summary><strong>Can Gemini see images or videos?</strong></summary>

<br>

**Images** — Yes. The bot automatically fetches any image URLs present in a chat message and sends them to Gemini for context. If an image isn't being recognized, try a different image host.

**Videos & Audio** — Only native YouTube URLs are supported. Gemini can process the video content directly.

</details>

<details>
<summary><strong>What is the optional YouTube API key for?</strong></summary>

<br>

Gemini can natively watch YouTube videos. When you supply a `YOUTUBE_API_KEY`, it provides Gemini with extra context such as the video title and description. You can obtain the key from the same [Google Cloud Console](https://console.cloud.google.com/apis/credentials) where you get your Gemini keys.

</details>

<details>
<summary><strong>Does the bot work while my stream is offline?</strong></summary>

<br>

Yes. As long as the Render service is running, the bot stays connected to your Twitch chat 24/7 — live or offline.

</details>

<details>
<summary><strong>Will Render spin down after inactivity?</strong></summary>

<br>

The bot has a built-in keepalive mechanism to prevent Render's free-tier spin-downs. If the bot is still spinning down, please [open an issue](../../issues).

</details>

<details>
<summary><strong>How do I see chat logs, media gallery, and settings?</strong></summary>

<br>

Your Render service URL (`https://YOUR-APP.onrender.com`) doubles as a split-screen web dashboard that displays live chat logs and generated media. Sign in with your Twitch account in the top right to open the **⚙️ Bot Configuration** menu.

</details>

<details>
<summary><strong>How do I update my bot with new features and fixes?</strong></summary>

<br>

When a new update is released, your fork on GitHub will show *"This branch is X commits behind VirtuallyJesse:main"*.

To update:
1. Open your fork on GitHub
2. Click **Sync fork → Update branch**
3. Render will automatically detect the new commits, rebuild, and redeploy your bot

> 💡 All your dashboard settings, personality, commands, and alerts stay completely safe in Redis during updates.

</details>

<details>
<summary><strong>Can I use Vertex AI instead of the Gemini API?</strong></summary>

<br>

Yes, set `VERTEX_PROJECT_ID` instead of `GEMINI_API_KEY`; never configure both at the same time. [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) must already be available to the process.

> Google owns project setup, authentication, IAM, billing, and model access. See the [Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/overview) for setup details.

</details>

<details>
<summary><strong>Can I run this locally?</strong></summary>

<br>

Yes, for development and testing. Run `npm install`, build the dashboard once with `npm run build`, create a `.env` file with the same variable names from `render.yaml`, then run `npm run dev`.

> ⚠️ **Use separate credentials for local development.** Create a different Twitch application (with `http://localhost:3000/auth/callback` as the redirect URL) and either omit `UPSTASH_REDIS_URL` or point it to a separate database. Using the same credentials as production will overwrite your live tokens and data.

Once running, visit `http://localhost:3000/auth/login` to authorize.

> 💡 `AI_VERBOSE` | `true` turns on detailed engine logging while debugging.

</details>

---

## License

[MIT](LICENSE) — use freely, attribution appreciated!

---

<div align="center">
  <a href="https://ko-fi.com/virtuallyjesse" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi2.png" alt="Support Me on Ko-fi" height="42" style="height: 42px;">
  </a>
  <br>
  <sub>Made with ❤️ by <a href="https://github.com/VirtuallyJesse">VirtuallyJesse</a></sub>
</div>
