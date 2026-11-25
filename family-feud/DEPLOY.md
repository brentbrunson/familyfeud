# Family Feud: put it online (one time, about 15 minutes)

You do this ONCE. After that, anyone can play by opening the website. No Terminal, nothing to install.
(Menu names on these sites change now and then, so follow the spirit of the steps if a button looks different.)

## 1. Put the files on GitHub
1. Make a free account at github.com and click **New repository**. Name it `family-feud`. Keep it Public or Private, either works.
2. On the new repository page click **uploading an existing file**.
3. Unzip this folder on your computer, then drag EVERYTHING inside it (server.js, package.json, sample.js, the `public` folder, etc.) into the browser window.
   Important: the `public` folder must come along. If folders don't upload, drag the folder itself, not just its files.
4. Click **Commit changes**.

## 2. Host it on Render
1. Make a free account at render.com (sign in with GitHub is easiest).
2. Click **New +**, then **Web Service**, then pick your `family-feud` repository.
3. Fill in:
   - Runtime / Language: **Node**
   - Build Command: leave blank (or `echo ok`)
   - Start Command: `node server.js`
   - Instance type: **Free**
4. Click **Create Web Service**. After a couple of minutes you get an address like `https://family-feud-abcd.onrender.com`.

That address is your game. Send it to your family.

## Things to know
- **Free hosting naps when idle.** The first visit after a quiet spell can take about a minute to wake up. Open the site 5 to 10 minutes before game time.
- **Games live in the server's memory.** If the site restarts or naps mid-game, the game is lost. Don't leave a game for hours. Finishing a game in one sitting is fine.
- Don't share the host link (the one with `&k=` in it). Whoever has it controls the game.

## Playing (for the person running the game)
1. Open your website, click **Start a game**.
2. Change the questions, answers and team names if you like (a Thanksgiving sample is already filled in). Click **Save & go to the game controls**.
3. On the computer connected to the TV, click **Open TV** (or copy the TV link), tap the screen once so sound works, and press F11 for full screen.
4. Captains open the **captain link** on their phones (or go to your website and type the 4-letter code), then pick their team.
5. Run the game from the host controls on your phone or laptop.

You can also run it on your own computer: install Node.js, then in a terminal run `node server.js` and open http://localhost:3000.
