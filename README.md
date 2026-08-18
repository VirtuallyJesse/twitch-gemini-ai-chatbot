<div align="center">

<img src="assets/banner.png" alt="Twitch Gemini Chatbot Banner" width="100%">

# Twitch Gemini Chatbot

**A free, AI-powered Twitch chatbot running on Google Gemini — deploys in minutes, runs 24/7.**

[![Built with Pollinations](https://img.shields.io/badge/Built%20with-Pollinations-8a2be2?style=for-the-badge&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAMAAAAp4XiDAAAC61BMVEUAAAAdHR0AAAD+/v7X19cAAAD8/Pz+/v7+/v4AAAD+/v7+/v7+/v75+fn5+fn+/v7+/v7Jycn+/v7+/v7+/v77+/v+/v77+/v8/PwFBQXp6enR0dHOzs719fXW1tbu7u7+/v7+/v7+/v79/f3+/v7+/v78/Pz6+vr19fVzc3P9/f3R0dH+/v7o6OicnJwEBAQMDAzh4eHx8fH+/v7n5+f+/v7z8/PR0dH39/fX19fFxcWvr6/+/v7IyMjv7+/y8vKOjo5/f39hYWFoaGjx8fGJiYlCQkL+/v69vb13d3dAQEAxMTGoqKj9/f3X19cDAwP4+PgCAgK2traTk5MKCgr29vacnJwAAADx8fH19fXc3Nz9/f3FxcXy8vLAwMDJycnl5eXPz8/6+vrf39+5ubnx8fHt7e3+/v61tbX39/fAwMDR0dHe3t7BwcHQ0NCysrLW1tb09PT+/v6bm5vv7+/b29uysrKWlpaLi4vh4eGDg4PExMT+/v6rq6vn5+d8fHxycnL+/v76+vq8vLyvr6+JiYlnZ2fj4+Nubm7+/v7+/v7p6enX19epqamBgYG8vLydnZ3+/v7U1NRYWFiqqqqbm5svLy+fn5+RkZEpKSkKCgrz8/OsrKwcHByVlZVUVFT5+flKSkr19fXDw8Py8vLJycn4+Pj8/PywsLDg4ODb29vFxcXp6ene3t7r6+v29vbj4+PZ2dnS0tL09PTGxsbo6Ojg4OCvr6/Gxsbu7u7a2trn5+fExMSjo6O8vLz19fWNjY3e3t6srKzz8/PBwcHY2Nj19fW+vr6Pj4+goKCTk5O7u7u0tLTT09ORkZHe3t7CwsKDg4NsbGyurq5nZ2fOzs7GxsZlZWVcXFz+/v5UVFRUVFS8vLx5eXnY2NhYWFipqanX19dVVVXGxsampqZUVFRycnI6Ojr+/v4AAAD////8/Pz6+vr29vbt7e3q6urS0tLl5eX+/v7w8PD09PTy8vLc3Nzn5+fU1NTdRJUhAAAA6nRSTlMABhDJ3A72zYsJ8uWhJxX66+bc0b2Qd2U+KQn++/jw7sXBubCsppWJh2hROjYwJyEa/v38+O/t7Onp5t3VyMGckHRyYF1ZVkxLSEJAOi4mJSIgHBoTEhIMBvz6+Pb09PLw5N/e3Nra19bV1NLPxsXFxMO1sq6urqmloJuamZWUi4mAfnx1dHNycW9paWdmY2FgWVVVVEpIQjQzMSsrKCMfFhQN+/f38O/v7u3s6+fm5eLh3t3d1dPR0M7Kx8HAu7q4s7Oxraelo6OflouFgoJ/fn59e3t0bWlmXlpYVFBISEJAPDY0KignFxUg80hDAAADxUlEQVRIx92VVZhSQRiGf0BAQkEM0G3XddPu7u7u7u7u7u7u7u7u7u7W7xyEXfPSGc6RVRdW9lLfi3k+5uFl/pn5D4f+OTIsTbKSKahWEo0RwCFdkowHuDAZfZJi2NBeRwNwxXfjvblZNSJFUTz2WUnjqEiMWvmbvPXRmIDhUiiPrpQYxUJUKpU2JG1UCn0hBUn0wWxbeEYVI6R79oRKO3syRuAXmIRZJFNLo8Fn/xZsPsCRLaGSuiAfFe+m50WH+dLUSiM+DVtQm8dwh4dVtKnkYNiZM8jlZAj+3Mn+UppM/rFGQkUlKylwtbKwfQXvGZSMRomfiqfCZKUKitNdDCKagf4UgzGJKJaC8Qr1+LKMLGuyky1eqeF9laoYQvQCo1Pw2ymHSGk2reMD/UadqMxpGtktGZPb2KYbdSFS5O8eEZueKJ1QiWjRxEyp9dAarVXdwvLkZnwtGPS5YwE7LJOoZw4lu9iPTdrz1vGnmDQQ/Pevzd0pB4RTlWUlC5rNykYjxQX05tYWFB2AMkSlgYtEKXN1C4fzfEUlGfZR7QqdMZVkjq1eRvQUl1jUjRKBIqwYEz/eCAhxx1l9FINh/Oo26ci9TFdefnM1MSpvhTiH6uhxj1KuQ8OSxDE6lhCNRMlfWhLTiMbhMnGWtkUrxUo97lNm+JWVr7cXG3IV0sUrdbcFZCVFmwaLiZM1CNdJj7lV8FUySPV1CdVXxVaiX4gW29SlV8KumsR53iCgvEGIDBbHk4swjGW14Tb9xkx0qMqGltHEmYy8GnEz+kl3kIn1Q4YwDKQ/mCZqSlN0XqSt7rpsMFrzlHJino8lKKYwMxIwrxWCbYuH5tT0iJhQ2moC4s6Vs6YLNX85+iyFEX5jyQPqUc2RJ6wtXMQBgpQ2nG2H2F4LyTPq6aeTbSyQL1WXvkNMAPoOOty5QGBgvm430lNi1FMrFawd7blz5yzKf0XJPvpAyrTo3zvfaBzIQj5Qxzq4Z7BJ6Eeh3+mOiMKhg0f8xZuRB9+cjY88Ym3vVFOFk42d34ChiZVmRetS1ZRqHjM6lXxnympPiuCEd6N6ro5KKUmKzBlM8SLIj61MqJ+7bVdoinh9PYZ8yipH3rfx2ZLjtZeyCguiprx8zFpBCJjtzqLdc2lhjlJzzDuk08n8qdQ8Q6C0m+Ti+AotG9b2pBh2Exljpa+lbsE1qbG0fmyXcXM9Kb0xKernqyUc46LM69WuHIFr5QxNs3tSau4BmlaU815gVVn5KT8I+D/00pFlIt1/vLoyke72VUy9mZ7+T34APOliYxzwd1sAAAAASUVORK5CYII=&logoColor=white&labelColor=6a0dad)](https://pollinations.ai)
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

1. **Fork this repository** and customize the bot's personality files
2. **Create a Twitch application** at [`dev.twitch.tv/console`](https://dev.twitch.tv/console) — note your Client ID & Secret
3. **Get Gemini API key(s)** from [`console.cloud.google.com`](https://console.cloud.google.com/)
4. **Create an Upstash Redis database** at [`console.upstash.com`](https://console.upstash.com) — copy the Redis connection string
5. *(Optional)* **Get a Tavily API key** from [`app.tavily.com`](https://app.tavily.com) to enable live web search
6. *(Optional)* **Get a Pollinations API key** from [`enter.pollinations.ai`](https://enter.pollinations.ai) to enable `!image`, `!video`, `!tts`, and `!song`
7. **Deploy your fork to Render** and fill in your environment variables
8. **Authorize the bot** at `https://YOUR-APP.onrender.com/auth/login` and link your channel on the dashboard

That's it. No local install. No terminal commands.

---

## Tutorial

Full walkthrough for each requirement. Complete these in order.

<!-- ─── 1. FORK & DEPLOY ─────────────────────────────────── -->

<details>
<summary><strong>1 — Fork, Customize & Deploy to Render</strong></summary>

<br>

#### Fork the repository

1. Click **Fork** at the top of this GitHub repo
2. This creates your own copy where you can edit all files freely

#### Customize your bot

These files shape the bot's personality and behavior — edit them in your fork before deploying:

**`system_instructions.txt`** (required)

This is the bot's personality prompt — Gemini follows these instructions for every response. Define tone, character, rules, etc.

**`custom_commands.txt`** (optional)

Define static commands with instant responses — no AI call needed.

**`error_messages.json`** (optional)

Override the default error messages to match your bot's personality.

#### Deploy to Render

Once your files are ready, click the button below to deploy your fork:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Sign into [Render](https://render.com) with your **GitHub account**
2. Render will detect your fork and the `render.yaml` Blueprint
3. You'll see a form with all the environment variables — fill these in as you complete the sections below
4. Click **Deploy Blueprint** once every value is ready

> 💡 After the first deploy, every push to `main` in your fork automatically redeploys your bot.

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
| `JOIN_CHANNELS` | Your **streamer channel's** username (where the bot should chat) |
| `TWITCH_CLIENT_ID` | The Client ID copied above |
| `TWITCH_CLIENT_SECRET` | The Client Secret copied above |

#### 4. Connect your accounts (after Render deploys)

1. In your **Bot's Incognito window**, visit:
   ```
   https://YOUR-APP.onrender.com/auth/login
   ```
   Click **Authorize** to connect the bot to chat.

2. In your **Streamer browser**, open your dashboard:
   ```
   https://YOUR-APP.onrender.com/
   ```
   Click the **`[Link Broadcaster]`** button next to your channel name to allow the bot to change your title and game category.

3. **Mod the Bot:** In your Twitch stream chat, type `/mod mybot` so the bot can use it's full toolkit.

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

#### Render environment variables

| Variable | Value |
|---|---|
| `SEARCH_GROUNDING` | `tavily` |
| `TAVILY_API_KEY` | Your Tavily API key |
| `TAVILY_SEARCH_DEPTH` | `basic` (1 credit/search, default) or `advanced` |

> 💡 The free tier gives you 1,000 searches a month, resetting on the 1st — plenty for daily chat use.

</details>

<!-- ─── 6. POLLINATIONS ────────────────────────────────── -->

<details>
<summary><strong>6 — Pollinations Setup (optional)</strong></summary>

<br>

Pollinations powers the `!image`, `!video`, `!tts`, and `!song` commands.

#### Get your API key

1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Log in with your **GitHub account**
3. From your dashboard, create an API key
4. Copy the key

#### Render environment variable

| Variable | Value |
|---|---|
| `POLLINATIONS_API_KEY` | Your Pollinations API key |

> 💡 Pollinations is an actively evolving platform — available models change frequently. If a command stops working, check [enter.pollinations.ai](https://enter.pollinations.ai) for current model names and update your environment variables accordingly.

</details>

---

## FAQ

<details>
<summary><strong>How much can I use the bot each day?</strong></summary>

<br>

On the free tier, each API key under a project at [`console.cloud.google.com`](https://console.cloud.google.com/) gets around 20 calls per day. Your account may have anywhere from 5–15 available projects depending on account age, giving you 100–300 API calls per day. The `GEMINI_API_KEY` env var accepts multiple comma-separated keys and rotates through them automatically.

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

Yes. Set `ENABLE_HELIX_ACTIONS` to `false` and the bot goes back to pure conversational Q&A.

You can also tune `HELIX_CLIP_COOLDOWN_SECONDS` (default `30`) and `HELIX_DEFAULT_TIMEOUT_SECONDS` (default `600`) if you want to adjust those defaults.

</details>

<details>
<summary><strong>Does the bot search the web?</strong></summary>

<br>

Yes, if you set it up. Set `SEARCH_GROUNDING` to `tavily` and add a `TAVILY_API_KEY` to enable free web search.

Leave it on `off` (the default) and the bot skips search — it still answers from its own knowledge, and you can still paste it a link directly to read via URL context.

`SEARCH_GROUNDING=google` uses Gemini's own built-in search instead of Tavily. This only works with a **paid** Gemini key, so stick to `tavily` or `off` unless you're already paying for Gemini.

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
<summary><strong>How do I see chat logs and the media gallery?</strong></summary>

<br>

Your Render service URL doubles as a public web dashboard that displays your channels' chat logs and generated media gallery. It's the same base link you used to authorize your bot (e.g. `https://YOUR-APP.onrender.com`).

</details>

<details>
<summary><strong>The Pollinations command isn't working — what do I do?</strong></summary>

<br>

Pollinations is an actively evolving platform — available models change frequently. You can update the model names in your environment variables at any time. Current model names are listed on the same page as your API key at [enter.pollinations.ai](https://enter.pollinations.ai).

</details>

<details>
<summary><strong>Can I run this locally?</strong></summary>

<br>

Yes, for development and testing. Run `npm install`, create a `.env` file with the same variable names from `render.yaml`, then run `npm run dev`.

> ⚠️ **Use separate credentials for local development.** Create a different Twitch application (with `http://localhost:3000/auth/callback` as the redirect URL) and either omit `UPSTASH_REDIS_URL` or point it to a separate database. Using the same credentials as production will overwrite your live tokens and data.

Once running, visit `http://localhost:3000/auth/login` to authorize.

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