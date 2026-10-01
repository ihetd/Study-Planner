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

## Daily use
1. Open the channel post, select all, and copy.
2. In the site, open **＋ Telegram**, paste, click **Analyze**, check the preview, then **Save**.
3. Hussein: tap ⚙ in the header to add Peony phrases for زهرة (optionally for a specific day, e.g. a birthday).
4. Press ▶ on a lecture to start a study session (the other person sees it live). ✔ Done ends it and marks the lecture studied.
5. ❚❚ pauses a session (paused time isn't counted) and ▶ resumes it.
6. Tick ✔ when you study a lecture.
7. Calendar → Month / Week / Day. Tap an empty time in Week or Day view (or pick a start time in the planner), tick the lectures, choose a length, then **Plan**. Tap a study block → **Add to Google Calendar** to get Google's reminder notification.
