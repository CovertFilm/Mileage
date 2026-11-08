# NFC Mileage Tracker: Setup (web page version)

Tap tag → your phone opens the Mileage page → it grabs GPS → your Google Sheet logs the trip → the page shows "4.2 mi" with **Round trip** and **Edit** buttons.

**You need:** your Google account, a free GitHub account, an Android phone with NFC, and an NFC sticker (NTAG213 or NTAG215; get an on-metal one if your dash is metal).

**Files you got:** `Code.gs` (backend), plus five page files: `index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`.

---

## Part A: Backend (Google Sheet + Apps Script)

If you already did this, you only need to **paste the new `Code.gs` over the old one, save, then Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The URL stays the same. (The new version adds a fallback the page uses.)

1. Create a Google Sheet named "Mileage".
2. **Extensions → Apps Script** (open it from the Sheet, not from script.google.com). Paste in all of `Code.gs` and save.
3. **Project Settings (gear) → Time zone:** set your zone, e.g. `America/New_York`.
4. Pick `setup` in the function dropdown and **Run**. Approve the permissions. The Execution log should end with a `TOKEN (MT_KEY ...)` line.
5. **Deploy → New deployment → Web app.** Execute as **Me**, access **Anyone**. Copy the Web app URL. It must end in `/exec`.
6. Run `showConfig` and copy your token from the log.
   - **Your URL** = the `/exec` URL from step 5 (not the `/dev` one from the log).
   - **Your key** = the token.
7. Test in a private window: `YOUR_URL?action=ping&k=YOUR_KEY` should show `ok|pong`.
8. On the `Dashboard` tab, enter the current IRS rate in the yellow cell (B8) if you want a $ estimate.

---

## Part B: Put the page online (GitHub Pages, free)

1. On github.com: **+ → New repository**. Name it `mileage`, set it to **Public**, click **Create repository**.
   - Public is required for free Pages. It's safe: the files contain **no secrets**. Your URL and key live only on your phone.
2. On the new repo page click **uploading an existing file**. Drag in the 5 page files (`index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`) and click **Commit changes**.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.**
4. Wait about a minute and refresh. GitHub shows your page address: `https://YOUR-USERNAME.github.io/mileage/`. Open it on your phone to check that it loads.

---

## Part C: First run on your phone

1. Open `https://YOUR-USERNAME.github.io/mileage/` in **Chrome** on your phone.
2. On the Settings screen, paste your **URL** (ends in `/exec`) and your **key**. Tap **Test connection**. You should see **Connected ✓**. Tap **Save**.
3. Tap **Start / end a trip now**. Chrome asks for location. Tap **Allow** (choose precise). You should see **Trip started**. Tap **Done**.
4. Tap it again (after 8 seconds), and you should see miles and the **Log as round trip** button. A row should appear in your Sheet. Delete the test rows in the Trips tab, or use the **Trip list** link to delete them.
5. Chrome **⋮ → Add to Home screen** (or **Install app**). This gives you an icon and makes the page open instantly, even with no signal.

---

## Part D: Write the tag

1. Install **NFC Tools** (free) on your phone.
2. **Write → Add a record → URL/URI**. Enter `https://YOUR-USERNAME.github.io/mileage/?scan=1`. Tap **OK**, then **Write**, and hold the phone to the sticker.
   - The tag holds no key or password, only the page address.
   - If the sticker had other data on it, use **Other → Erase tag** first.
3. Stick it where the phone naturally taps (dash top, mount, cup holder lid). Test the exact spot. NFC range is about 1 to 3 cm.
4. Tap your phone (screen on) to the tag. Android may ask which app should open the link the first time. Pick **Mileage** or **Chrome** and choose **Always**.

---

## Test checklist
1. Tap the tag outdoors. Within about 5 seconds you should see **Trip started** with your street address.
2. Drive somewhere and tap again. You see the miles. A row appears in the Sheet's Trips tab with status `done`.
3. Tap **Log as round trip ×2**. The miles double and the button becomes **Undo round trip**.
4. Tap **Edit trip**. It opens the Sheet-backed editor where you can change miles, purpose or notes, or delete the trip.
5. Check the `Dashboard` tab. The month total should match.
6. **Airplane-mode test:** turn on airplane mode and tap the tag. You see **Saved**. Turn airplane mode off and open the Mileage page. The trip appears in the Sheet with the **original scan time**.

---

## How it behaves
- **One tag, server-side state.** The Sheet decides start vs end, so you never choose.
- **Safe retries.** Every scan has a unique ID, so a duplicate can't create a second trip.
- **Accidental repeats are blocked.** Reloading the page, or two taps within 8 seconds, don't log anything extra.
- **Offline.** The page loads from your phone and saves the scan. It sends the next time you open the page with a connection. (It can't send while the page is closed, because Chrome limits background work.)
- **Forgot to end a trip?** After 10 hours (`STALE_HOURS` in `Code.gs`), the next scan flags the old trip `unclosed` (red row) and starts a new one. You also get one email. Fix it in the editor.
- **Round trip:** tap the button once after you arrive. Tapping repeatedly never double-doubles. Use it only if you're heading straight back. To go somewhere else, just scan again to start the next leg.
- **Default purpose is "Business".** You only scan trips you care about, so there's no business/personal prompt. Change it in the editor.
- **Miles are the driving route between your two scan points,** not your exact path. Fix detours in the editor. If the Maps lookup fails, it uses a straight-line estimate ×1.25 and notes it in the row.
- **Screen must be on** for Android to read the tag.

## Updating the page later
Replace the files in your GitHub repo (open a file → pencil icon, or upload again). Also change `mileage-v1` to `mileage-v2` in `sw.js` so phones pick up the new version.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Tag does nothing | Screen off; NFC off; wrong spot on the sticker; sticker not written |
| "Location is blocked" | Chrome → ⋮ → Settings → Site settings → Location → allow for your github.io site |
| "No GPS fix" | Try again outdoors. Garages block GPS. |
| "Key rejected" | Key in Settings doesn't match your token. Re-enter it. |
| "Could not reach the server" in Settings | URL typo, not `/exec`, or access not set to "Anyone" |
| Result says "Server error" | Open the Apps Script **Executions** page to see the error |
| Old page after an update | Bump the version in `sw.js` (see above), then open the page twice |
| **Done** button doesn't close it | Normal for installed apps. Swipe it away or press back. |
