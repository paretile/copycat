# Copycat Writer

An unofficial copy of Jason Fried's Write_On.

Jason [showed Write_On off](https://x.com/jasonfried/status/2105403067793584590). He hadn't released it. So I copied it. That's the whole origin story, and the name is not trying to be clever. It used to be just "Copycat". I added "Writer" so you'd know what it copies without having to ask.

This is not Jason's app. It is not affiliated with him, endorsed by him, or released with his permission. Please don't treat it as if it were. No Write_On branding, marks, or assets are used here. The design is mine; the ideas are very obviously his.

**If Jason ever releases Write_On, go use his instead. It will be better.** Leave this behind. I mean it. This is not a bit, and it is not humble theater. I built Copycat Writer because the writing tool I wanted wasn't out yet. The day it is, this project should get out of the way. I'll be glad. I'll probably switch before you do.

## What it does

Copycat Writer is a small writing tool. You open it, you write, and the writing is the point. It is not a workspace, not a feed, and not a tour that congratulates you for starting. It stays quiet while you work.

- **First open.** You land on a short sample document that already shows a word with versions, a sentence with versions, a ghosted phrase, and a note in Overflow. A one-line hint sits on top until you close it. Click + at the bottom left for a blank page.
- **The workspace and plain mode.** The workspace (sidebar, icons, the beaker) is on by default. Click the word count in the top-left corner to hide it and get a blank page with nothing but the count. Click the count again to bring it back. It remembers which you picked.
- **Right-click** anything in your text for the tools. With no selection, it grabs the word under the pointer. The **?** button lists every shortcut.
- **Alternatives.** Keep more than one version of a word, a sentence, or a whole paragraph. Text with versions gets a squiggly underline and a row of dots, one per version. Hover it and press ↑/↓ to cycle in place. Whatever is showing is the one you picked. Click the text to see every version in the left sidebar. Add more at the bottom (Ctrl+Shift+A), and delete any with ×. When you swap words, "a"/"an" fixes itself (a thumbtack → an eraser).
- **Ghost it / Revive it.** Select text and press Ctrl+/ (or right-click). It fades to about 10% but stays put, in case you change your mind. Ghosted text doesn't count toward the word count.
- **Overflow.** "Stash this in Overflow" (Ctrl+Shift+S) cuts the selection into a scratchpad on the right. You can drag and copy/paste text either way.
- **The lab** (the beaker). Scans that mark weak or convoluted sentences, and four trims: Slight trim, Tighten some, Even sharper, Cut in half. A trim ghosts what it would cut. Then you pick **Make the cuts**, **Walk through** (cut or skip each one), or **Done** (keep them ghosted and decide later).
- **Save and documents.** Everything saves to your browser's localStorage (Ctrl+S, plus autosave). The bottom-left icons list your documents and start a new one.
- **Post to X.** Opens X's post composer with your text, minus anything ghosted. LinkedIn is there too. It's disabled, and it shakes if you poke it.

## AI, optionally

AI Alternatives (Ctrl+Shift+E), the scans, and the trims can use any OpenAI-compatible chat completions API. Open settings (the gear) and enter a base URL, a model, and your own key. The key stays in this browser's localStorage and is sent only to the URL you entered. No key ships with this, and there is no server.

Without a key, AI Alternatives politely asks for one. The scans and trims fall back to a quick built-in rule set: filler words, hedges, passive voice, run-ons.

## Use it

Open [https://paretile.com/copycat-writer/](https://paretile.com/copycat-writer/). In Chrome or Edge, install it as an app from the address bar or the browser's Install app menu. Once installed, it works offline.

Or download this repo and open `index.html` in a browser. That works straight from disk, with no server and no build step. Installing as an app needs a web host; browsers only allow that over HTTPS.

Recent Chrome, Edge, Firefox, or Safari. Scan highlights use the CSS Custom Highlight API.

## Shortcuts

| Keys | What |
| --- | --- |
| ↑ / ↓ while hovering underlined text | Cycle versions |
| Ctrl+Shift+A | Add an alternate for the selection (or the word/sentence/paragraph at the caret) |
| Ctrl+Shift+E | AI alternatives for the selection |
| Ctrl+/ | Ghost it / Revive it |
| Ctrl+Shift+S | Stash this in Overflow |
| Ctrl+S | Save |
| Right-click | Tools for the selection, or the word under the pointer |
| ? button | Show these shortcuts |

## Tests

```
pip install playwright && python -m playwright install chromium
python tests/test_app.py
```

The test drives the app headlessly. It covers cycling alternates, a/an fixing, ghost/revive, stash and drag, the scans, every trim with Make the cuts and Walk through, AI calls against a mock endpoint, save/reload, multiple documents, and the X intent URL. It also checks the first-open sample, the hint, and right-click with no selection. It writes screenshots to `screenshots/`. Point it at any Chromium with `CHROME=/path/to/chromium`.

## Status

Work in progress. It is not finished. Expect sharp edges.

## Credit and distance

Write_On is Jason Fried's project. Copycat Writer is Paretile's unofficial copy of it, made with respect and without permission. If he ships it, go use his instead. It will be better.

MIT licensed. See `LICENSE`. The fonts are under the SIL Open Font License (`fonts/LICENSE.txt`).

— Paretile
https://github.com/paretile
