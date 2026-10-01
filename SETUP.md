# Study Planner: setup

The site works right away in **local mode** (data stays in one browser).
Do the steps below to sync Hussein's and Zhra's phones.

## 1. Firebase project (about 5 minutes)
1. Go to https://console.firebase.google.com, choose **Add project**, name it `study-planner`, and turn Analytics off.
2. Go to **Build → Firestore Database → Create database**.
   - Location: **me-central1 (Doha)**. It's the closest region to Iraq, so it has the lowest delay. *You can't change this later.*
   - Start in **production mode**.
3. Go to **Build → Authentication → Get started → Email/Password → Enable**.
4. Under **Authentication → Users → Add user**, create both accounts:
   - `zhra@studyplanner.app` with a password
   - `hussein@studyplanner.app` with a password

   (If you use different emails, change them in `USERS` inside `index.html` and in the rules below.)
5. Go to **Firestore → Rules**, paste the following, and **Publish**:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       function member() {
         return request.auth != null &&
           request.auth.token.email in ['zhra@studyplanner.app', 'hussein@studyplanner.app'];
       }
       match /lectures/{id} {
         allow read, write: if member();
       }
       // Study sessions: each person can only start/stop their own; both can see.
       match /live/{u} {
         allow read: if member();
         allow write: if member() && request.auth.token.email == u + '@studyplanner.app';
       }
       match /studyLog/{id} {
         allow read: if member();
         allow create: if member() && request.auth.token.email == request.resource.data.user + '@studyplanner.app';
       }
       // Tasks and exams: both can see, only the owner can add, change or delete theirs.
       match /tasks/{id} {
         allow read: if member();
         allow create, update: if member() && request.resource.data.owner == request.auth.token.email.split('@')[0];
         allow delete: if member() && resource.data.owner == request.auth.token.email.split('@')[0];
       }
       match /exams/{id} {
         allow read: if member();
         allow create, update: if member() && request.resource.data.owner == request.auth.token.email.split('@')[0];
         allow delete: if member() && resource.data.owner == request.auth.token.email.split('@')[0];
       }
       // Peony phrases: both can read, only Hussein (admin) can edit.
       match /config/peony {
         allow read: if member();
         allow write: if request.auth != null && request.auth.token.email == 'hussein@studyplanner.app';
       }
     }
   }
   ```
6. Go to **Project settings (⚙) → Your apps → Web (</>)** and register the app. Copy `apiKey`, `authDomain`, `projectId` and `appId` into `FIREBASE_CONFIG` at the top of the `<script>` in `index.html`.
7. Under **Authentication → Settings → Authorized domains**, add `ihetd.github.io`.

## 2. Host on GitHub Pages
Create the repo `Study-Planner`, push `index.html`, then go to **Settings → Pages → Deploy from branch → main / root**.
The site will be at https://ihetd.github.io/Study-Planner/.

## 3. (Optional) Automatic PDF names
This only works if the Telegram channel is **public**, meaning links look like `https://t.me/<name>/<number>`.
1. Go to https://dash.cloudflare.com → **Workers & Pages → Create → Worker**, paste `worker.js`, and click **Deploy**.
2. Put the worker URL (e.g. `https://study-pdf.<you>.workers.dev`) in `PDF_WORKER_URL` in `index.html`.

For private channels, type the lecture name into the lecture card.

## Install on iPhone (like a normal app)
Open https://ihetd.github.io/Study-Planner/ in **Safari**, then tap **Share → Add to Home Screen → Add**. It opens full screen with the Peony icon and still opens without internet. On Android or desktop Chrome, use the **Install** button in the app.

## Admin PIN (Hussein)
The first time the Hussein profile is opened on a phone, it asks you to create an admin PIN, which also protects the ⚙ phrases page. Only a salted hash of the PIN is saved on that phone. Open the Hussein profile once on زهرة's phone too and set your PIN there, so nobody else can create one. ⇄ (switch user) locks the profile again. Once Firebase is on, your account password protects it as well, and the Firestore rules only let your account write phrases.

## Features at a glance
- **Tasks**: deadlines with due date, priority and subject; weekly view; they also show on Today and in the Calendar.
- **Exams**: countdown plus a topic list split evenly into a daily goal (fill topics from a subject's lectures).
- **Pomodoro**: "Free session" lets you pick a subject and ⏱ stopwatch or 🍅 25·5; 🍅 in the session bar switches mid-session. Every session is logged per subject.
- **Reviews**: ticking a lecture schedules reviews 1, 3, 7 and 14 days later ("Reviews due" on Today, 🔁 in the Calendar).
- **Stats**: study time per day, hours per subject, streak, pomodoros, lectures/reviews/tasks done for 7, 30 or 90 days.

## Daily use
1. Open the channel post, select all, and copy.
2. In the site, open **＋ Telegram**, paste, click **Analyze**, check the preview, then **Save**.
3. Hussein: tap ⚙ in the header to add Peony phrases for زهرة. She sees them in a random order when she taps the Peony, one pops up by itself every few minutes, and they also appear in her study mode.
4. Press ▶ on a lecture to start a study session (the other person sees it live). ✔ Done ends it and marks the lecture studied.
5. ❚❚ pauses a session (paused time isn't counted) and ▶ resumes it.
6. Tick ✔ when you study a lecture.
7. Calendar → Month / Week / Day. Tap an empty time in Week or Day view (or pick a start time in the planner), tick the lectures, choose a length, then **Plan**. Tap a study block → **Add to Google Calendar** to get Google's reminder notification.

## Telegram bot: automatic schedule and lecture names (option A)

The bot is an admin of the batch channel, so Telegram sends it every post. It saves each lecture PDF's
file name under the post's link and keeps each day's schedule. When the app opens it asks the bot for
both: tomorrow's lectures are added by themselves and each lecture gets its name. Pasting still works.

1. **Create the bot.** In Telegram open @BotFather → `/newbot` → pick a name. Keep the token private.
2. **Add the bot to the channel as an admin** (whoever owns the batch channel has to do this; no special
   rights are needed). If the PDFs are posted in a second channel, add it there too. The bot only sees
   posts made after it joins; older PDFs can be forwarded to the bot in a private chat to fill their names.
3. **Put the bot online** (free Cloudflare account, from the `bot/` folder):
   ```
   cd bot
   npx wrangler login                      # opens Cloudflare in the browser
   npx wrangler d1 create study-planner-bot  # copy the database_id into wrangler.toml
   npx wrangler deploy
   npx wrangler secret put BOT_TOKEN       # paste the token here, in your own terminal
   ```
4. **Connect Telegram to it:** open `https://study-planner-bot.<your-subdomain>.workers.dev/setup` once.
   It should say `"webhook": "connected"`.
5. **Tell the app where the bot is:** set `BOT_URL` near the top of `index.html` to that workers.dev URL.

`/inbox` is readable by anyone who knows the URL (it holds lecture file names and schedule text only).
