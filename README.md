<div align="center">

<img src="assets/banner.png" alt="Twitch Gemini Chatbot Banner" width="100%">

# Twitch Gemini Chatbot

**A free AI bot for your Twitch chat. Runs 24/7.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](#license)

</div>

---

## Features

<div align="center">
<img src="assets/features.png" alt="Features Overview" width="100%">
<br><br>
<img src="assets/dashboard.png" alt="Web Dashboard and Media Gallery" width="100%">
</div>

---

## What You Need

Everything runs on free tiers. No credit card required, and no coding needed:

- **GitHub account** (to hold your copy of the bot)
- **Twitch Developer app** (gives your bot a name and connects to chat)
- **Google Gemini API key** (powers the bot's responses)
- **Upstash Redis database** (saves your settings and chat history)
- **Render account** (hosts the bot 24/7 in the cloud)

Follow the step-by-step [Setup Guide](#setup-guide) below to set them up.

---

## Setup Guide

Follow these steps in order to get your bot running.

<!-- ─── 1. FORK & DEPLOY ─────────────────────────────────── -->

<details>
<summary><strong>Step 1: Fork and deploy to Render</strong></summary>

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
3. Leave this tab open. Fill in the fields as you complete the steps below
4. Click **Deploy Blueprint** once every value is ready

</details>

<!-- ─── 2. TWITCH ──────────────────────────────────────── -->

<details>
<summary><strong>Step 2: Twitch setup</strong></summary>

<br>

To give your bot its own name and chat badge, you will use two Twitch accounts:
1. **Your Streamer account** (where you go live)
2. **Your Bot account** (a separate Twitch account created for your bot)

> 💡 Keep your main browser logged into your **Streamer account**, and open an **Incognito window** logged into your **Bot account**.

#### 1. Create the Twitch application

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console) and sign in with your **Streamer account**.
2. Click **Register Your Application**.
3. Fill in the form:
   - **Name:** anything you like (e.g. `My Stream Bot`)
   - **OAuth Redirect URL:** `https://YOUR-APP.onrender.com/auth/callback`  
     *(Replace `YOUR-APP` with your Render service name)*
   - **Category:** `Chat Bot`
4. Click **Create**.

#### 2. Get your credentials

1. Click **Manage** on your new application.
2. Copy the **Client ID**.
3. Click **New Secret** and copy the **Client Secret**.

#### 3. Fill in your Render fields

Paste these into your open Render tab:

| Setting | What to enter |
|---|---|
| `TWITCH_USERNAME` | Your **bot account's** username (lowercase) |
| `ADMIN_USERNAMES` | Your **streamer account's** username |
| `TWITCH_CLIENT_ID` | The Client ID copied above |
| `TWITCH_CLIENT_SECRET` | The Client Secret copied above |

> 💡 You will connect both accounts to the dashboard after Render finishes deploying in Step 7.

</details>

<!-- ─── 3. GEMINI ──────────────────────────────────────── -->

<details>
<summary><strong>Step 3: Gemini API keys</strong></summary>

<br>

> ⚠️ Create your keys through the **Google Cloud Console**, not Google AI Studio. Keys created in the Cloud Console are managed separately and behave differently.

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
3. Copy the generated key (starts with `AIza`)

#### Multiple keys (recommended)

Each key is tied to one project and gets its own daily quota. More keys = more capacity. Repeat all three steps above for as many projects as your account allows. Most accounts can create 5-15 projects.

The `GEMINI_API_KEY` setting accepts **multiple comma-separated keys** and rotates through them automatically.

#### Render setting

| Setting | Value |
|---|---|
| `GEMINI_API_KEY` | One or more keys, e.g. `Key1,Key2,Key3` |

> 💡 To give Gemini extra context on YouTube links (video title, description), create a YouTube Data API v3 key from the same [Credentials page](https://console.cloud.google.com/apis/credentials) and add it as `YOUTUBE_API_KEY`.

</details>

<!-- ─── 4. UPSTASH ─────────────────────────────────────── -->

<details>
<summary><strong>Step 4: Upstash Redis setup</strong></summary>

<br>

Upstash provides a free database that saves your settings, chat logs, and media history across Render restarts.

#### Create a database

1. Go to [console.upstash.com](https://console.upstash.com) and create an account
2. Click **Create Database**
3. Give it a name (e.g. `twitch-bot`)
4. Select a region close to your Render region (e.g. **US-East-1** for Virginia)
5. Select the **Free** tier
6. Click **Create**

#### Get your database URL

1. On the database details page, find the **Redis** section
2. Click the **copy button** next to the URL:
   ```
   redis://default:xxxxxxxxxxxx@us1-xxxxxx.upstash.io:6379
   ```

#### Render setting

| Setting | Value |
|---|---|
| `UPSTASH_REDIS_URL` | The full `redis://...` connection URL |

</details>

<!-- ─── 5. TAVILY ──────────────────────────────────────── -->

<details>
<summary><strong>Step 5: Web search setup (optional)</strong></summary>

<br>

Google's built-in search requires a paid account. Tavily provides 1,000 free web searches per month with no payment required.

#### Get your API key

1. Go to [app.tavily.com](https://app.tavily.com) and sign up
2. Copy your API key from the dashboard

#### Render setting

| Setting | Value |
|---|---|
| `TAVILY_API_KEY` | Your Tavily API key |

To turn search on, open your dashboard settings and set **Web search** to `Tavily`.

</details>

<!-- ─── 6. MEDIA ──────────────────────────────────────── -->

<details>
<summary><strong>Step 6: Media generation (optional)</strong></summary>

<br>

The bot can create images, videos, voice clips, and music with Google and Pollinations.

Your Google key from Step 3 already works for Google models. To use Pollinations models as well, add a Pollinations API key:

#### Get your API key

1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Log in with your **GitHub account**
3. Create an API key in your dashboard
4. Copy the key

#### Render setting

| Setting | Value |
|---|---|
| `POLLINATIONS_API_KEY` | Your Pollinations API key |

> 💡 You can switch models or providers anytime in your dashboard under **Commands**.

</details>

<!-- ─── 7. DASHBOARD CONFIG ─────────────────────────────── -->

<details>
<summary><strong>Step 7: Connect accounts and customize</strong></summary>

<br>

Once Render finishes deploying, open your dashboard at `https://YOUR-APP.onrender.com` and sign in with Twitch at the bottom left.

#### 1. Connect your accounts

Open **Configuration → Connection & channels**:

1. **Authorize the bot:** In your Bot account's incognito window, click **Authorize** next to Bot account.
2. **Join your channel:** In your Streamer browser, enter your channel name under Configured channels and click **+ Join**.
3. **Link your channel:** Click **Link** beside your channel name to enable stream controls and alerts.
4. **Mod the bot:** In your Twitch chat, type `/mod yourbotname`.

#### 2. Customize your bot

Click your name at the bottom left to explore your settings:

- **Configuration:** Manage web search, emote sync, and AI models.
- **Persona:** Write your bot's personality, tone, and chat rules.
- **Stream Actions:** Toggle Twitch controls like category changes, moderation, and viewer clipping.
- **Commands:** Set up media commands (`!image`, `!video`, `!tts`, `!song`) and add custom text commands.
- **Alerts:** Customize chat reactions for subs, raids, cheers, and channel points.

> 💡 All dashboard changes save instantly.

</details>

---

## FAQ

<details>
<summary><strong>How do I update my bot with new features and fixes?</strong></summary>

<br>

When a new update is released:

1. Open your forked repository on GitHub.
2. Click **Sync fork**, then **Update branch**.
3. Render will automatically detect the changes, rebuild, and relaunch your bot.

> 💡 All of your dashboard settings are preserved during updates.

</details>

<details>
<summary><strong>Where do I find my Render URL and dashboard?</strong></summary>

<br>

1. Go to your [Render Dashboard](https://dashboard.render.com/).
2. Click your web service name.
3. Your URL (ending in `.onrender.com`) is located near the top, directly below your repository name.

</details>

<details>
<summary><strong>How much can I use the bot each day?</strong></summary>

<br>

On the free tier, each key in a Google Cloud project gets roughly 20 responses per day. Most Google accounts can create 5-15 projects, giving you 100-300 free responses daily. The `GEMINI_API_KEY` setting accepts multiple comma-separated keys, rotating through them automatically.

</details>

<details>
<summary><strong>Does the bot stay online 24/7?</strong></summary>

<br>

Yes. The bot stays connected to your chat around the clock, whether you are live or offline. It includes a built-in keepalive ping to prevent Render's free tier from sleeping due to inactivity.

</details>

<details>
<summary><strong>Can the bot perform Twitch actions like changing the title or moderating?</strong></summary>

<br>

Yes. Chatters can ask the bot to perform stream actions in natural language:

- **Broadcaster and moderators:** Update the stream category or title, timeout chatters, post announcements, and run shoutouts (e.g. `@mybot change category to Just Chatting`).
- **Everyone in chat:** Create clips (e.g. `@mybot clip that!`).

You can toggle individual actions on or off or adjust the clip cooldown from the **Stream Actions** tab in your dashboard.

</details>

<details>
<summary><strong>Does the bot react to subs, bits, and raids?</strong></summary>

<br>

Yes. The bot automatically celebrates new subs, gift bombs, cheers, raids, and channel point redemptions in chat. You can toggle alerts, customize messages, and adjust bit and viewer thresholds in your dashboard under **Alerts**.

</details>

<details>
<summary><strong>Can chatters send images or videos to the bot?</strong></summary>

<br>

Yes, through links posted in chat:

- **Images:** The bot fetches image URLs present in a chat message. If an image is not recognized, try a direct link or a different image host.
- **Videos and audio:** Only native YouTube URLs are supported; other video and audio links are unsupported. Adding the optional `YOUTUBE_API_KEY` setting gives the bot extra context like the video title and description.

> 💡 Certain image models also accept image links alongside prompts to edit or remix existing pictures.

</details>

<details>
<summary><strong>How does web search work, and what happens if I run out?</strong></summary>

<br>

When enabled under **Configuration → Web search** with your `TAVILY_API_KEY`, the bot decides on its own when it needs to search the web.

Tavily includes 1,000 free searches each month (roughly 33 per day). If you run out, the bot detects it automatically and falls back to answering from its own knowledge without failing.

> 💡 The `Google` search option requires a paid Gemini billing account. For free setups, stick with `Tavily` or `Off`.

</details>

<details>
<summary><strong>Can I use Vertex AI instead of Gemini API keys?</strong></summary>

<br>

Yes. Set `VERTEX_PROJECT_ID` instead of `GEMINI_API_KEY`. Do not configure both at the same time. [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) must already be configured in your environment.

> 💡 See the [Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/overview) for Google Cloud project setup and IAM details.

</details>

<details>
<summary><strong>Can I run this locally?</strong></summary>

<br>

Yes, for development and testing. Run `npm install`, build the dashboard with `npm run build`, create a `.env` file with the settings from `render.yaml`, then run `npm run dev`.

> ⚠️ **Use separate credentials for local development.** Create a different Twitch application (with `http://localhost:3000/auth/callback` as the redirect URL) and either omit `UPSTASH_REDIS_URL` or point it to a separate database. Using your production credentials will overwrite live tokens.

Once running, visit `http://localhost:3000/` to access your local dashboard.

> 💡 Set `AI_VERBOSE=true` in `.env` for detailed engine logs while debugging.

</details>

---

## License

[MIT](LICENSE). Use freely, attribution appreciated!

---

<div align="center">
  <a href="https://ko-fi.com/virtuallyjesse" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi2.png" alt="Support Me on Ko-fi" height="42" style="height: 42px;">
  </a>
  <br>
  <sub>Made with ❤️ by <a href="https://github.com/VirtuallyJesse">VirtuallyJesse</a></sub>
</div>
