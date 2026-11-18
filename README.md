# cindy-bili-scroll (刷B站)

Scrolls Bilibili for you on a schedule: browse the home feed or search your keywords → read subtitles to decide what is worth watching → write a Markdown daily report. Optionally leave one comment that @-mentions you, favorite the video, or deliver the report by direct message — all according to your settings.

There is also a **reply lane**: it only handles who replied to your comments and who @-mentioned you, with its own check count and its own reply quota. It never shares a budget with browsing — and since 1.5.0 both lanes share **one** automation task: the gate says whether this tick deserves the model, the plugin says which lane it is.

Ported from [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT) and reimplemented against Cindy's capability boundaries, not translated line by line. See "Differences from the original" below.

## What it does

1. **Collect candidates** — empty keyword list means your own home recommendation feed; otherwise it searches one keyword per round. Videos matching your exclude words are dropped.
2. **Deduplicate** — it reads its own ledger (`seen.jsonl`), skips anything already seen, and gets back the verdicts it wrote for itself in earlier rounds (see "Video memory" below).
3. **Read** — it reads the subtitle transcript of each candidate. No subtitle track means "skipped (no subtitle)"; it never guesses.
4. **Write the report** — one block per pick in `out/<date>.md`, whose first line is always `### BVnumber`. The plugin counts those lines to enforce the daily quota. The card's 卡片 tab renders it as a wall of cards with covers and verdict tags, filterable by 值得看 / 可以看 / 不值当 and searchable by title.
5. **Optional interaction** — comment (with an optional @mention), favorite, DM delivery. Comment and DM counts are capped by settings; every comment has to pass a style gate. Favorites are hard-capped at one per round and eight a day, and stay off until you pick a folder. None of these tools asks for approval per call: with the setting off nothing can be sent at all, and with it on you have authorised the round to send up to its quota.
6. **Close the round** — `bili_round({action:"finish", roundId})` (pass the `roundId` from the opening `bili_round` call verbatim) advances this segment's automatic round count, then `bili_verify()` rechecks whether the comments really are publicly visible and writes the result into the 评论复核 section of **the report of each comment's own day**.

**Replies are not part of this flow.** They belong to the interaction round (`bili_inbox({action:"start"})`), see "Automatic runs" below. A browsing round's `budget.reply` is always 0.

## Video memory

The ledger has always been a list of what was watched. Since 1.3.1 each entry can also carry a short **note**: what the video was actually about, why it was skipped, what this channel is worth. **The model writes the note itself**; the plugin only stores it and hands it back — so the memory carries the tone and standards of whichever companion ran that round.

The one-line note (`note`, ≤200 characters) matters in three places:

- The next round's opening `bili_round` returns `memory`: the last 12 entries that have a note (BV number, title, channel, verdict, day), plus channels folded together — "how I judged this channel last time" (up to 6, most-noted first).
- `bili_browse` attaches `note` to any candidate already seen, and `upNote` to other videos from the same channel. So by round two it already knows what it made of that channel.
- The card's 判重表 tab has a 当时的判断 ("verdict at the time") column, so you can read what it thought each round without opening a file.

The weighting is fixed in the charter: **an old note is its own judgement, not something someone else said** — it ranks above titles and descriptions, below the subtitles actually read this round. When it disagrees with an old note it goes with this round's evidence, but must say in the new note why it changed its mind; otherwise the next round meets two contradictory past selves.

When the ledger can't be read, `memory` is `null`, not an empty object: an empty memory would tell the model "I have never thought about anything before", which is worse than nothing.

Two things worth knowing:

- **Append-only, never pruned automatically.** The caps (200 characters per note, 12 notes + 6 channels per round) keep it from flooding the context, but the file itself keeps growing. To slim it, edit `seen.jsonl` by hand in the plugin's private data directory — deleting the whole file also forgets what was watched.
- **The memory belongs to the plugin, not the companion.** The ledger lives in the plugin's private data directory, so whichever companion runs a round sees the same video memory and simply continues judging with its own taste. Different standards per companion come from their own SOUL and memories, not from this.

## First step: sign in

Bilibili account features (AI subtitles, comments, favorites, DMs) need a login. **Credentials never pass through the conversation.**

Sign in from the plugin's details page → **自定义设置 → the 登录 tab** (the first one). Two ways in, either is fine:

- **QR code** — a code is fetched only when you press 生成二维码: opening the page or leaving it alone makes no login request at all. Scan it with the Bilibili mobile app and confirm with "remember me / long term".
- **Three named cookie fields** — `SESSDATA` (required), `bili_jct` (needed to comment / favorite / send DMs) and `DedeUserID` (optional). Each name sits on its own label, so it is still visible after you have pasted a value. **Paste only the value, never `name=`** — the plugin puts the names back (if you do paste `SESSDATA=…` it is recognised and stripped).
  You can also paste a whole `Cookie` header into any of the three fields: the plugin picks out the three names and fills the matching fields, then you can check them before submitting. All three fields are cleared as soon as it is submitted.

Both routes first ask Bilibili who that cookie belongs to and only write it if the answer is a real account; if Bilibili rejects it, the call errors and the existing credential is left untouched. The value goes only between the settings page and your machine: it never enters the conversation, is never echoed, and never appears in an error message.

The same tab has two more buttons: 核对一下 really asks Bilibili whether the stored credential is still accepted (opening the page normally only reads the local file, no API call), and 退出登录 needs two clicks.

`SESSDATA` is mandatory. Without `bili_jct` the plugin can still scroll but cannot comment, favorite or send DMs — it says so on the spot. The credential is written to the plugin's private data directory (`credential.json`); the page only shows your nickname.

The settings page is the **only** place to sign in. Since 1.3.8 the card lost its 登录 tab: every tool call a card makes can show up as a request card in the conversation, and reinstalling the plugin invalidates cards that were already open — both are bad properties for a flow that waits on your phone.

To sign out you can also say "退出 B站 登录" in chat — the plugin calls `bili_config({action:"logout"})` and asks you to confirm.

## Automatic runs: one task, one gate, the plugin decides what to do

The original's autonomy is a `setInterval` that runs a pure script every minute and spawns a session only when the round should happen. The Cindy equivalent is an **automation pre-run hook**: a zero-token script decides whether the model should be called at this tick, allows (exit 0) or skips (exit 2).

Since 1.5.0 there is exactly **one automation**, and it covers both kinds of work. Three layers, each answering one question:

```
gate     (Node script, 0 tokens)  is there anything to do at this tick?    → exit 0 / exit 2
dispatch (plugin, bili_round)     browsing round, reply check, or nothing? → mode=report / inbox / none
execute  (model)                  do that one thing, following its charter
```

1. **Gate** — `schedule/precheck.mjs`, wired to the task as a pre-run hook. It reads the mirror the plugin writes (`%APPDATA%\Cindy\duty\cindy-bili-scroll/{config,state}.json`) and decides *whether* this tick deserves a model. It deliberately does not say which kind of work: pre-run hook stdout never reaches the model.
2. **Dispatch** — the model's first call is `bili_round({action:"start"})`. The plugin runs the same decision function (`schedule/decide.cjs`) against the bookkeeping it just read, so it is the authority, and it answers `mode=report` (with the browsing charter), `mode=inbox` (with the reply charter, and the check is already open — no extra tool), or `mode=none`.
3. **Execute** — the model follows the charter it was handed.

The gate is a conservative pre-filter: it sees the last synced mirror, which can be a few minutes old. When it lets a tick through and the plugin then finds nothing to do, the cost is one wasted session (at most the slot's 3 attempts); the plugin also refreshes the mirror when it finds nothing to do, so the gate stops on the next tick instead of allowing every tick. **It never posts anything twice.**

Why one lane instead of 1.4.0's two: with two crons, two model sessions could run at the same time on the same account, and the plugin cannot tell which model is calling a tool — "a reply check may only reply" could only be a prompt, not a structural guarantee. It also made "attach the right hook to the right task" a whole class of setup errors.

### Why the cron keeps ticking

Cindy's scheduler **does not backfill**: a missed cron tick is simply gone. So "two rounds a day" has two shapes:

- two narrow schedules (08:00, 18:00): **a sleeping or shut-down computer loses that day's round**;
- one broad schedule ticking repeatedly (every 30 minutes, or denser) with the gate deciding whether a tick becomes a round: **as long as the machine is awake somewhere in the window, the round happens**.

This plugin takes the second shape, which is why the gate works on **per-segment quotas** for browsing: each segment keeps its own count, so the morning segment only allows its own round and the evening segment keeps its own for the evening. That buys both dispersion and no missed rounds — without the old failure where the first ten minutes after boot consumed the whole day.

### Configuring segments

Settings → 日常 → 时段配额 is a list of `start – end × rounds` rows, for example

| start | end | rounds |
| --- | --- | --- |
| 06:00 | 10:00 | 1 |
| 18:00 | 24:00 | 1 |

That is "one round in the morning + one in the evening", and neither eats the other's quota. Rules:

- Each segment is a **half-open interval within one day** (`06:00–10:00` includes 06:00, excludes 10:00). **No wrapping**: cover 22:00–02:00 with two segments, `22:00–24:00` and `00:00–02:00` (each with its own quota).
- Segments may not overlap; invalid or overlapping ones are dropped. If none survives, it falls back to `00:00–24:00 ×1` so the automation never silently stops.
- When the cron ticks is up to you, as long as it is **denser than the quota**: every tick is a zero-token script, and the model is only called when the gate opens. The prefilled task runs every 30 minutes (the host's minimum for a prefilled interval), which is enough for segments at least an hour wide; for `*/5 * * * *` density, change the task's frequency to a cron expression yourself (or ask Cindy to) — the gate still lets only N through.
- Manual rounds ("现在刷一轮") ignore segments and never consume a segment's quota.

### What the gate decides

One list, both lanes. **There is exactly one implementation of the rules** (`schedule/decide.cjs`): the gate `import`s it, and the plugin reaches it through the bundled worker — `duty/decide` (what to do this tick), `duty/segments` (the washed segment table it mirrors into `config.json`) and `duty/layout` (where we are right now, how many rounds this segment has left, how many times this slot was tried, how many reply checks remain). `main.js` runs in a sandbox and cannot `require`, so it asks the worker instead of owning a second copy: there is no `parseClock`, `normalizeSegments`, `attemptsOf` or `inboxLimits` in it at all. `tests/test-main-gate.cjs` section 12 fails if anyone copies one back in, and `tests/test-decide.cjs` checks the segment table's two renderings (minutes for judging, `HH:MM` + key + label for storing/display) describe the same table. The one deliberate difference: the plugin passes `claim` to `decide`, the script does not — the script's previous allowance is already spent, while the plugin's is the attempt it is about to use.

It allows the tick when **either** lane has room:

- **browsing lane** — signed in, no browsing round running, daily pick quota (`perDay`) not filled (`perDay = 0` means "no automatic cap", not "allow nothing"), inside a segment, that segment has not finished its `rounds` yet, and that segment round has not already failed 3 times.
- **reply lane** — signed in, replies enabled ("允许回复别人的追问" on and "checks per day" above 0), no browsing round running, no check running, today's checks not used up, and at least the minimum gap since the last check.

And it skips when neither has room, saying why:

- not signed in (the biggest saving: no login means the model is never called)
- a browsing round is already running (a lock younger than 12 minutes), or a reply check is (a lock younger than 15 minutes) — one lane means one thing at a time, in both directions
- the browsing segment ran out, or its current round failed 3 times (same value as the original's `MAX_WINDOW_TRIES`), or today's picks are filled
- the reply checks ran out, or the minimum gap has not passed

Only `bili_round({action:"finish"})` counts as a finished browsing round; writing a report deliberately does not, so a round that wrote two picks and then crashed still gets retried instead of spending the segment's budget. For replies, **used = max(the plugin's count, the script's count)**: the plugin records "a check actually started", the script records "I allowed one" — a model that crashed halfway was still a real billed session and must count.

The gate **cannot know whether the inbox has new messages** — the script has no Bilibili credentials and must not make network calls. So the reply lane's cost model is "woken N times a day, each time one inbox fetch, immediately wrapped up when it is empty", with N from "checks per day". That is the one cost of this design, stated plainly.

### What one check is

One `bili_inbox({action:"start"})` through to its `finish` (an automatic tick uses the same path: `bili_round` opens it for you when it dispatches `mode=inbox`). It has nothing to do with how many people replied: **even an empty inbox means the model was woken**, so it counts and consumes a check. An empty inbox wraps up immediately (`nothing:true`, no lock), so the model does not need a second call to `finish`.

### Mirror files

The script cannot read the plugin's private directory or `/kv`, so after every round, settings change and report write the plugin mirrors the minimum facts it needs to:

| File | Contents | Written by |
| --- | --- | --- |
| `%APPDATA%\Cindy\duty\cindy-bili-scroll\config.json` | the gate settings only (`segments` / `perDay` / `replyToComments` / `inboxChecksPerDay` / `inboxMinGapMin`); keywords, exclusions, tone, @ names and DM recipients stay in the plugin's private directory | plugin |
| `%APPDATA%\Cindy\duty\cindy-bili-scroll\state.json` | picks today, rounds finished per segment, attempts per segment round, login state (no nickname), whether a round is running; the reply ledger (`inboxChecks` / `inboxLastAt` / `inboxLock`); plus the gate's own `hookStarts` / `hookDay` / `hookAt` / `inboxHookTries` / `inboxHookDay` / `inboxHookAt` / `lastSkip` | plugin, except those keys |

Mostly one-way: **the plugin writes, the script reads**, with one exception — when the gate opens, it increments its own counter (`hookStarts[slot]` for the browsing lane, `inboxHookTries` for the reply lane). A model woken but never reaching the tools would otherwise be invisible to the script and retried on every tick forever; the plugin preserves those keys when it syncs, and reads the merged values back into its own state so both sides count the same way. `hookDay` / `inboxHookDay` record which day a counter belongs to: yesterday's three failed attempts must not block today.

**Saving the settings page also refreshes the mirror** (the page wakes the plugin over `/wake` and asks it to rewrite both files; the save message says whether that worked). This is required, not a nicety: the mirror is written by the plugin, and the plugin is only ever invoked when something calls it — so after you switch the interaction round from off to on, the gate keeps reading "off", skips every tick, never wakes anything, and therefore never gets another chance to rewrite the mirror. The reverse is the same deadlock in the expensive direction (up to twenty billed wakes a day after you turned it off). If the sync fails (plugin asleep, older host), saying "刷B站 看设置" in chat rewrites it. Editing the files by hand is overwritten at the next plugin run.

**Since 1.6.2 the mirror is no longer at the root of your home directory.** Up to 1.6.1 it lived in `~/bili-duty/` (on Windows, `C:\Users\<you>\bili-duty`). Cindy offers plugins exactly two storage places: `/kv` (settings) and `cindy.fs root:'data'` (a private directory, reclaimed on uninstall). The home-directory copy was neither — it was written straight to disk by the bundled Node process, and the home directory is exactly where sync and backup tools look, while these two files are a record of account activity. The paths now follow each platform's convention: Windows `%APPDATA%\Cindy\duty\cindy-bili-scroll`, macOS `~/Library/Application Support/Cindy/duty/cindy-bili-scroll`, Linux `$XDG_DATA_HOME/cindy/duty/cindy-bili-scroll`. The plugin and the gate **compute the same path independently**, so nothing has to pass it around. After upgrading, whichever wakes first (plugin or gate) copies the two files from the old location; **the old directory is not deleted automatically** — if you hand-edited it, check that the new copy is the one you want before removing it.

### Wiring it up — one task

**Point the hook at the script inside the install directory, by absolute path. Do not copy it.**

```
"<absolute path to node.exe>" "<install dir>/schedule/precheck.mjs"
```

On Windows that looks like `"C:\Program Files\nodejs\node.exe" "C:\Users\<you>\AppData\...\cindy-bili-scroll\schedule\precheck.mjs"` (quote both parts; paths may contain spaces). The working directory is whatever the task uses — the script does not depend on it; `decide.cjs` and `gate.mjs` are resolved relative to `precheck.mjs` itself.

Why not a copy: a copy **goes stale silently** after a plugin upgrade and keeps deciding by the old rules while you notice nothing. A broken absolute path fails loudly (the pre-run hook fails, the task does not run, you get a notice) — the right direction when the alternative is "runs by the wrong rules". (The 1.3.x README taught copying into the task directory; that is obsolete.)

The rest of the task:

1. agent mode, `silentWhenIdle: true`;
2. frequency: the prefill is every 30 minutes (the host's minimum for a prefilled interval); for `*/5 * * * *`, change it to a cron expression in the panel, or tick only in the hours you care about — the gate decides what a tick becomes, and denser ticking only costs zero-token script runs;
3. attach `precheck.mjs` as the pre-run hook. **There is no second task and no second hook to get wrong.**

Saying "设成每天自动刷" or "帮我盯着回复" in chat opens the same prefilled panel for that one task.

Check the gate by hand: `node "<install dir>/schedule/precheck.mjs"` — exit 0 allows, exit 2 skips, and the reason is printed to stdout, naming both lanes ("segment ran out; checks used up 2/2"). `--home <dir>` / `--now <ISO time>` let you try it against a fake duty directory.

### Upgrading and migrating (1.4.0 → 1.5.0)

1.4.0 gave you **two** automations (a browsing task and a "回复互动" task, each with its own hook). 1.5.0 wants **one**:

**Do this first: delete the "刷B站 · 回复互动" task.** Nothing gets posted twice (one lock admits one session; the second gets `busy`), but it is worse than one idle session. The two hooks read the same `state.json` in sequence and each increments it:

- the browsing lane's 3 attempts per segment round are **burned at double rate**, halving its retry budget;
- if the first script uses the slot's last allowance, the second may switch lanes and allow a **reply check** — that check's quota is spent without a check happening (with "checks per day" set to 2 you get one real check that day);
- with the minimum gap set to 0, the same check can be counted twice, same effect;
- two model sessions wake on one tick; the second only gets `busy`, but it is already billed.

Delete it, and the remaining task is genuinely one lane.

Then, for **the browsing task you keep**:

1. **Point its pre-run hook at `<install dir>/schedule/precheck.mjs`** (absolute path, as above). If it already points there, nothing changes — same file name, and it now covers both lanes.
2. **Update that task's prompt.** The 1.4.0 prompt only knew about a browsing round and does not branch on `mode`. Two ways:
   - **Create a fresh task (recommended)**: say "设成每天自动刷" in chat; the plugin opens the new-automation panel prefilled with the new prompt → save it as "刷B站 · 自动运行" → **attach the same hook to that new task** → then delete the old one (otherwise you are back to two).
   - **Edit the existing task**: open it in the automation panel and paste in the prompt from the new panel (**cancel** the new panel, do not save it, or you get an extra task). The hook path stays as it is.
   - Saving the new task but forgetting the hook gives you "one gated task + one ungated task": the ungated one calls the model every 30 minutes unconditionally, more expensive than before the upgrade.
3. `schedule/precheck-inbox.mjs` **still ships for one version** and simply delegates to `precheck.mjs`, so an old task whose hook still points at it does not fail loudly. Be aware it is no longer reply-only: it will also open the browsing lane. That is another reason to delete the old task.
4. Settings need no migration: segments still govern browsing; "允许回复别人的追问" + "每天最多检查几次" + "两次检查至少隔几分钟" still govern replies. They now share the task instead of each having one.
5. The old settings keys from 1.3.x (`peakValley` / `noon` / `night`) are still ignored silently on read, and `autoRoundsPerDay` still migrates into one full-day segment.

If you are coming straight from 1.3.x as well:

- the three time-window switches are gone; time control belongs to cron alone, and a master switch with no window used to mean "weekends only";
- replies moved out of the browsing round: turn on "允许回复别人的追问", set "每天最多检查几次" above 0, and keep the single task. It is off by default — upgrading must not start waking the model on its own;
- if you copied `precheck.mjs` per the 1.3.x README, replace it with the absolute path inside the install directory. A stale copy still finds the compatibility fields (it never exceeds a quota) but knows nothing about segment quotas: it can wake the model outside every segment, `bili_round` refuses, and a refusal never syncs — the stale copy then keeps knocking with its own three attempts until it gives up, which can cost you the day.
- The mirror still emits `runs` / `autoRoundsPerDay` / `windows` for stale copies. We are keeping them past 1.5.0 (they cost a few dozen bytes per tick) because they are what stops a 1.3.x copy from opening every tick; they go away when no such copy can be in play.

## Usage

| You want | Say |
| --- | --- |
| Run a round now | "现在替我看一轮 B站" |
| Run daily | see "Automatic runs" above; you can also say "每天早晚各刷一次 B站" and the plugin opens the "new automation" panel (prefilled as one tick every 30 minutes) — **it only exists after you press save** (the prefilled one has a schedule but no gate, so attach the hook). How many rounds run is the segment quota; cron only decides when to knock |
| Watch replies to my comments | say "帮我盯着回复": there is no second task any more — it opens the same single task (and you still need it saved with the hook attached). Just enable replies and set "checks per day" above 0 |
| Read today's report | "看看今天的 B站 日报" → opens the card's 日报 tab |
| See the card wall | "打开 B站 卡片" → the card's 卡片 tab: covers, verdict tags, filter, search, pagination |
| Change preferences | The plugin's settings page, five tabs: 登录 / 日常 / 偏好 / 互动 / 高级 |
| Sign in / out | The 登录 tab of that same settings page (QR code or pasted cookie) |
| Check what it watched | "刷B站 最近刷过啥", or the ledger tab in the card |
| Check comments are still up | "刷B站 复核一下评论" → `bili_verify`, which writes a 评论复核 section into the report of each comment's own day (anything under 90 seconds old is marked "not checked yet" — moderation lag, not a failure) |

## Settings

| Tab | Field | Meaning |
| --- | --- | --- |
| 日常 | keywords / exclude words | one per line; empty keywords = home feed |
| 日常 | picks per day | 0 disables the automatic cap |
| 日常 | segment quotas | rows of `start – end × rounds` (1–6), each segment counted separately and never eating another's budget. Half-open, no wrapping, no overlap; invalid or overlapping segments are dropped. Default is one `00:00–24:00 ×1` segment; "早晚各一轮" fills in 06:00–10:00 + 18:00–24:00 |
| 日常 | report shape | full / brief / off — with off, the quota is counted from the `挑了` rows in the ledger, and the daily quota plus the manual per-round cap are enforced there too |
| 偏好 | search order / pages | newest / relevance / views / danmaku |
| 偏好 | candidates per round | drives the model cost (reading subtitles is the expensive step) |
| 偏好 | manual cap + cooldown | both are hard limits: a manual round cannot exceed the cap, and a second request inside the cooldown is refused; at most 4 manual rounds a day (manual skips the segments and the daily quota, so it cannot be unlimited) |
| 偏好 | favorite folder | 0 = no favorites; pick from the dropdown (the last synced list) or type the number after `fid=` in the favorites URL. The list refreshes when you open the card's 卡片 tab or say "刷B站 看设置". Favorites are capped at 1 per round and 8 per day |
| 互动 | auto comment + cap | off by default; the cap counts **per browsing round** (how many rounds a day there are is the sum of the segment quotas); each video is commented on once. There is also a hard cross-round ceiling of 10 comments a day, written into the plugin rather than exposed as a setting |
| 互动 | comment length (short / medium / long) | a tone preset, not a character switch; the hard cap is always 150 |
| 互动 | @mention name | nickname only; the plugin keeps "@name" without a space; 150 characters total including the mention (same as the original) |
| 互动 | DM delivery | off by default; DM only, or comment + DM; 500 characters per message, at most 1 per round, and an `@name` mention is rejected outright (`DM_NO_MENTION` — an email address is not a mention and passes) |
| 互动 | DMs per day | the whole-day cap, 0–5, default 2 (= the number 1.5.0 hard-coded, so an upgrade changes nothing); 0 means "no DMs at all". The per-round cap stays 1 and is not affected |
| 互动 | DM recipient UID | 0 means "resolve from the mention name" |
| 互动 | reply to follow-ups | the interaction round's master switch, off by default; while off the interaction gate skips without waking the model |
| 互动 | checks per day | how many interaction checks may open per day (0 = no automatic checking). This is the interaction round's only "round count" and has nothing to do with browsing rounds. A manual check (`manual=true`) skips this count and the minimum gap, but is capped at 6 a day |
| 互动 | minimum gap between checks | keeps a fast cron from waking the model over and over |
| 互动 | replies per check / replies per day | "per check" is the interaction round's quota; "per day" is the account-safety hard cap (0 = unlimited, keep it in single digits). A day's maximum is checks × per-check, bounded by this cap |
| 高级 | comment tone hint | optional, up to 2000 characters |

## Tools

`bili_round` (start here, and the first call of every automatic tick: it answers `mode=report` with quota, budget, how many rounds this segment has left, settings, ledger, `memory`, `roundId` and the browsing charter; `mode=inbox` with the check already opened for you (`inboxId`, items, reply budget, reply charter); or `mode=none`. `action:"finish"` with that `roundId` closes the round and advances this segment's automatic round count — a mismatched token means this round already expired and the call is refused), `bili_browse` (adds `note` / `upNote` for anything already judged), `bili_detail` (video + subtitles), `bili_comments`, `bili_report_append`, `bili_seen` (read; pass `record` to write, with an optional `note`), `bili_inbox` (the inbox *and* the reply lane's manual entry point: no action = a free peek; `action:"start"` opens a check and returns `inboxId`, items, reply budget and the reply charter; `action:"finish"` closes it), `bili_verify` (are the comments still publicly visible), `open_view` (`intent`: report / cards / library / schedule / schedule-inbox — both schedule intents open the same single task), `bili_comment`, `bili_reply` (reply lane: takes `inboxId`), `bili_favorite`, `bili_dm` (no per-call approval — see below), and `bili_config` (`action:"logout"` clears the credential; per-call approval). `view_data` (`kind`: report / library / cards / folders) is called by the card only; login has no tool at all any more — the settings page drives it over `BroadcastChannel`.

**What "no per-call approval" means.** Every tool a round needs is `approval: "auto"` in `ghost.json` — the four outward-writing ones (`bili_comment` / `bili_reply` / `bili_favorite` / `bili_dm`) plus the reading and recording side (`bili_round` / `bili_browse` / `bili_detail` / `bili_comments` / `bili_inbox` / `bili_verify` / `bili_report_append` / `bili_seen`): no prompt per call, the model can call them directly inside a round. That declaration is what makes an unattended automation work: a schedule carries no permission mode of its own (`schedule_create` has no such field), so anything left undeclared would inherit the task's mode and could stall a 3 a.m. round on a card nobody is looking at. All the protection sits in the settings gate — settings off, quota spent, video already commented on, style gate failed, a mention or an over-long body: the plugin refuses locally and the request is never sent. The cost is that **a misjudged round publishes a comment under your name**, and you can only delete it afterwards. To take the authorisation back, turn the corresponding setting off (the tools stay, but every call is refused).

`bili_config` stays `"each-call"`: changing settings or signing out always asks first.

An older Cindy ignores `approval: "auto"` and keeps asking per call — that is the stricter side, never the looser one.

**Every write carries the round it belongs to.** `bili_report_append`, `bili_seen` (with `record`), `bili_comment`, `bili_favorite` and `bili_dm` take the `roundId` from the opening `bili_round` call; `bili_reply` takes the `inboxId` from `bili_inbox({action:"start"})`. That is how the plugin knows which round — and which day, and whether it was automatic — a write belongs to, including when the round outlived the 12-minute lock (reading a dozen subtitles takes longer than that; a round is still credited with its own writes for up to two hours). An id that matches no current round — a newer round took over, this one was closed, or the lock is older than two hours — is refused with `ROUND_MISMATCH` / `INBOX_MISMATCH`; it is never charged to another round and never silently treated as a one-off write. A call *without* an id is treated as a one-off (it is counted against whatever round is running, so it consumes that round's budget).

Rewriting a video that is already in the report costs no extra quota, and a `### BV…` heading whose id is followed by anything other than a space or the end of the line is refused instead of being truncated onto a different video.

**Comment ids are strings, always.** Bilibili's `rpid` is a 64-bit integer; JavaScript `Number` starts losing the last digits above 2^53, and replying with a truncated id lands the reply under someone else's comment while verification reports it as missing. So `bili_reply`'s `aid` / `rpid` / `root` are strings in the tool schema, and `bili_comments` / `bili_inbox` return strings — pass them through untouched.

Cindy caps a plugin at 16 tools, so pairs were merged instead of dropping features: `bili_video`+`bili_subtitle` → `bili_detail`, `bili_seen`+`bili_seen_append` → `bili_seen`, `login_start`+`login_poll` → `login` (1.3.0 added a `cookie` action; 1.3.8 removed the tool altogether once login moved to the settings bridge), `bili_logout` → `bili_config`, and starting/closing a round became `bili_round({action})`. `bili_status` was redundant with `bili_round`; `bili_install_schedule` became `open_view({intent:"schedule"})` (opening a panel is not worth a tool slot); `bili_frames` had no model-side value.

## Differences from the original

**Ported as-is**: report format and the `### BVnumber` convention, the seen ledger, daily quota and manual cooldown, the comment style gate (`@ x` → `@x`, cliché openers, bigram similarity against past comments and hot comments), and the request shapes for feed/search/video/subtitle/comments (copied from `bilibili-api-python` 17.4.2 `data/api/*.json`). The original's peak-valley windows — a time filter — were replaced in 1.4.0 by per-segment quotas; the reason is in "Automatic runs": cron does not backfill, so filtering time alone cannot save a missed round.

**Rewritten and why**:

- **Data access** — the original uses Python `bilibili-api`; a Cindy plugin cannot ship a Python runtime, and it may not run `npm install` / `npx` / `postinstall` on the user's machine — dependencies have to be bundled into the worker at build time (the packer skips `node_modules`). None turned out to be necessary: native `fetch` plus `node:crypto` for WBI signing, `finger/spi` for buvid3/4 (without them the API answers HTTP 412), one buvid refresh retry on risk control, and ≥300 ms between requests.
- **Login** — credentials may not enter chat, so the QR code is drawn inside the page (vendored MIT `qrcode-generator` on a canvas; the login URL is never handed to a third party) and the result is stored as `credential.json` by `main.js`. Since 1.3.0 a pasted cookie is accepted too: the plugin verifies it against Bilibili's `auth/account` *before* writing anything, and the value never reaches the model. Since 1.3.3 both live in the settings page: that page is a zero-bridge sandbox (only `/kv`, no tool channel, no network), so it wakes the plugin (`/wake`) and hands the work over a `BroadcastChannel`, retransmitting by `reqId` until it gets an answer; the plugin dedupes by `reqId` so a retransmission cannot fetch a second QR (which would invalidate the one being scanned). 1.3.8 finished the move: the card no longer renders a login tab and the `login` tool is gone.
- **Settings UI** — Cindy's `settingsHtml` + `/kv`, five tabs (login was added in 1.3.3).
- **Report location** — same format, stored in the plugin's private data directory and rendered in the card.
- **Scheduling** — the original scheduling itself (`setInterval`). A Cindy plugin cannot create tasks, so it is an automation plus a pre-run hook (see "Automatic runs"): the decision stays in a zero-token script and the model is woken only when the gate opens. The cost is that the hook has to be attached to the task separately, and the plugin must mirror the facts the gate needs into `%APPDATA%\Cindy\duty\cindy-bili-scroll/` (the original kept scheduler and business logic in one process and needed no mirror).
- **Favorite folder choice** — the original lists folders directly in its settings page. Cindy's settings page can only read and write `/kv`, with no way to call a tool, so the plugin syncs the folder list into `/kv` (whenever the 卡片 tab opens or `bili_config` is read) and the settings page shows it in a dropdown; typing the id from the favorites URL always works too.

**Not ported and why**:

- **Restricted execution profile** (the original's `cordis.patch.yml` strips file/command/network from the model runtime). In Cindy that layer belongs to the host. The equivalent pressure is three things: every outward-writing tool goes through the settings gate (quota, one comment per video, the style gate, hard limits on mentions and length — all enforced inside the plugin, so a setting that is off means nothing can be sent), a fixed tool surface (the model reaches Bilibili only through these tools, with paths fixed by the plugin), and a charter that states every word of video text is data, not instructions. **This is not claimed to be equivalent to the original's permission stripping** — the model still holds whatever permissions the task gives it, and those four tools are now `approval: "auto"` (no prompt per call), so a misjudged round publishes under your own name.
- **Speech transcription (Whisper)** — needs Python plus ~1 GB of weights, which a plugin cannot install. Videos without subtitles are skipped.
- **Automatic DM replies** — only delivery plus reading the message list (`bili_inbox`). Three separate blockers: it needs a long-lived web_im connection that an on-demand worker does not hold; it would have your account talk to strangers unattended; and answering with any memory of the previous message needs a model session the plugin can keep addressing — in Cindy a plugin can only run a turn in a session the user has opened by clicking its card (or, with a capability this one does not request, continue such a session in the background). Seeing the plugin at work is a different matter: every step appears as a tool call **in whichever session runs that round**, and the card (report / cards / ledger) reads the files live — but automatic rounds run inside the automation's session and do not pop up in your own chat.

  Since 1.6.0, when a round really wrote new entries into today's report the model calls `open_view({intent:"cards"})` after finishing (`finish` returns `reportUpdated: true` only then). **What actually happens:** `open_view` is bound to the plugin's interactive page (an MCP Apps resource), and the card hangs off **that tool-use message** and is stored with the run's transcript (the host treats it as a visible history result, so reopening the session still shows it). To see it you open the "刷B站 · 自动运行" task session; if that session was already open, the card appears there live. Nothing is pushed into your private chat and there is no notification on this path. Two honest caveats: with a viewer older than 0.1.122-beta, or a permission mode that requires human approval for tool calls, the card will not appear (or waits for that approval) — **do not treat it as "it always pops up".**

**Not done**: **choosing videos by picture**. The original samples storyboard frames when a video has no subtitle. Here nothing of that path exists beyond the `videoshot` endpoint URL sitting unused in the API table: no request function, no sprite geometry parsing, no frame extraction, no tool. Zero-dependency Node could not decode JPEG anyway. So a video without a subtitle is judged by title and description only, and the charter forbids claiming to have seen any picture.

## Known limits

- **The settings page talks to the plugin over BroadcastChannel.** The page itself cannot call tools or reach Bilibili, so login has to be done by the plugin's background logic; the page wakes it first and retransmits until it answers. If the plugin never answers, the page says so plainly — there is no second way in, since 1.3.8 the card has no login tab either.

- **Your own comment being visible to you does not make it public.** Bilibili only shows a comment under review or rate-limited to its own author: the same comment appears in the newest-thread list with your credential and disappears for anyone else (and the @mention never fires). Since 1.3.5 the check runs twice — once with your login, once without any credential — and only says "publicly visible" when the anonymous pass finds it; if only you can see it, it says so plainly.
- **Subtitles require a login.** Anonymous requests returned `available:false` for all 8 sampled search results, so without signing in the plugin falls back to titles and descriptions.
- **Write paths are unverified with a real account.** The comment / favorite / DM request shapes are copied from `bilibili-api-python`. With no credential the plugin refuses locally (`NOT_LOGGED_IN`) before any request is sent, so those shapes have never been exercised at all; `-101` only appears when a credential file exists but is invalid, and it is an authentication rejection that never reaches body validation. Whether the writes truly succeed needs one round with a real account. DM delivery is reported as `sent:false` unless the API returns a `msg_key` receipt.
- **The favorite-folder list is a cache.** The settings page is a bridge-less sandbox page (`/kv` only, no tool channel), so it cannot list folders itself: the dropdown shows whatever the plugin last synced (opened from the card's 卡片 tab, or by saying "刷B站 看设置"). With no sync yet it is just an empty dropdown — typing the id always works.
- **The mirror lags.** `%APPDATA%\Cindy\duty\cindy-bili-scroll/state.json` is rewritten after a plugin call, and saving the settings page also syncs it (say "刷B站 看设置" if the plugin was asleep), so mid-round the gate sees the previous snapshot. If the plugin cannot read its own `state.json`, the settings half of the mirror is still written and only `state.json` stays on the previous snapshot — an outdated file beats a fabricated "nothing ran today, no round is running" one that makes the gate open an extra round. That is a consequence of the capability boundary, not a bug.
- **In a rare interleaving the two sides can overwrite each other's write.** The gate and the plugin's `duty/sync` both read-modify-write the same `state.json`, and the plugin writes the whole file. Both directions exist:
  - the gate's increment lands between the plugin's read and write → that counter falls back to the older value, and **one extra model wake** is possible;
  - the plugin's write lands between the gate's read and write → the gate writes back a lock it had just seen released, or an older segment count: **that lane is held by a revived lock for 12 minutes** (or the slot allows once more and the plugin answers `mode:none`).
  The gate re-stats the file right before writing and re-merges if it changed, which keeps the second window small; there is no file lock on purpose: this runs in every pre-run hook, and locking for a rare race is not worth the cost. Leaving two tasks in place after upgrading makes both directions much more likely, which is one more reason to delete the old one.
- **The two lanes never start on their own, and "reply only" is decided by the token the caller carries.** Both directions re-check the other lane's lock inside the lock, so only one model **starts new work** at a time; and whether a comment / favourite / DM may go out depends on whether the call carries a `roundId` or an `inboxId` (`laneOf`) — so neither an expired lock nor a browsing round running past 12 minutes lets a write slip out of the reply lane.
- **Once a lock expires, two things can run at the same time.** The browsing lock is 12 minutes and the reply lock 15, both shorter than "reading a dozen subtitles" tends to take. Work that outlives its lock lets the other lane in; each still writes under its own token, but "only one model touches the account at a time" holds only inside the lock window. That is a deliberate trade: a longer lock would block the lane for that long after a crash.
- What remains: after a check is *finished*, a tool call that still arrives without a token is treated as a one-off write, exactly like the user asking the plugin to do something in chat — the plugin cannot tell which session is calling it.
- **The first-run allowance is bounded.** When the mirror has never been written (fresh install), the gate opens once so the plugin can create it. That escape hatch allows at most three wakes **per day**; if the plugin can never write the mirror (broken credential directory, worker failing to start), the gate stops for the rest of that day and records why, instead of waking a model every tick.
- **`network.hosts` only governs `cindy.fetch`.** The bundled Node worker uses its own network stack to reach Bilibili (`*.bilibili.com`); the manifest declares the cover domains the page needs plus that actual reach. The install screen is the authoritative permission list.
- **Search and feed endpoints are rate-limited by Bilibili**: on HTTP 412 the plugin refreshes buvid and retries once, then reports the error.

## Where data lives

| Location | Contents |
| --- | --- |
| `/kv` | every setting above |
| plugin private data directory | `credential.json`, `state.json` (today's round bookkeeping, cooldown, replies, cover cache, the current round lock), `seen.jsonl` (the ledger, each entry optionally carrying the model's own one-line verdict), `out/<date>.md` |
| `%APPDATA%\Cindy\duty\cindy-bili-scroll\` | `config.json` + `state.json` — the mirror the pre-run hook reads. Settings and bookkeeping only: **no credentials, no report body** |

Credentials stay in the private data directory only — never in `/kv`, never in chat, never echoed, and not in the mirror either.

## Packaging

```
ghost_forge_pack({ dir: "<absolute path of this directory>" })
ghost_forge_install({ dir: "<absolute path of this directory>" })
```

Installation lists the capabilities this plugin asks for: a bundled Node worker (it holds local file and network permissions because Bilibili requests are made from your machine), the plugin private data directory (`fs`), and requesting new automations (`agent.schedule`).

`ui/page.html` is the page the host actually loads; `ui/page.template.html` is the same file with its header comment and version stamp regenerated from `ghost.json`. The generator lives in the repo, not in the package: run `node tools/build-page.cjs` from the repo root. Change the template, then regenerate the page from it — a template edit alone never reaches what ships. The QR login lives only in the settings page, which loads the vendored `ui/qrcode.js` directly; the card does not inline it.

## Development

The repository root **is** the package root: `ghost.json` sits at the top, so `ghost_forge_pack` can point straight at it. The packer has no exclude list, so `tools/` and `tests/` travel inside the `.cindy` package too — about 50 KB that the host never loads. That is the price of keeping one directory for both the repo and the package; the alternative is a `plugin/` subdirectory and one more path in every command.

```
node tools/build-page.cjs          # regenerate ui/page.html from ui/page.template.html
node tools/sync-charter.cjs        # rewrite prompts/*.md from main.js's charter arrays
node tools/sync-charter.cjs --check # ...or just fail if the two drifted
```

Tests need no dependencies and no network — plain Node, each file prints its own pass count:

```
node tests/test-main.cjs        # tool dispatch of main.js against a fake host (the main regression suite)
node tests/test-main-gate.cjs   # settings/gate contract; section 12 fails if gate logic is duplicated into main.js
node tests/test-decide.cjs      # segment table: both renderings describe the same table
node tests/test-duty.cjs         # mirror write-side merge rules (hook counters across midnight)
node tests/test-api.cjs          # how Bilibili responses are parsed
node tests/test-precheck.mjs     # the pre-run hook end to end
node tests/test-precheck-inbox.mjs
node tests/gate-selftest/run.mjs  # six fixed gate scenarios; pass an absolute path to test an installed copy instead
```

Run all of them after touching `main.js`, the gate, or the charter. `tests/test-duty.cjs` runs against a temp directory and never touches your real mirror.

## License and provenance

- This plugin: MIT, see `LICENSE`.
- Derived from [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT).
- `ui/qrcode.js` ships [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (MIT, Copyright (c) 2009 Kazuhiko Arase) for the settings page's login QR code. See `NOTICE`.
