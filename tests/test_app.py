"""Headless end-to-end test for Copycat Writer.

Run:  pip install playwright && python -m playwright install chromium
      python tests/test_app.py            (or set CHROME=/path/to/chrome)
Screenshots go to screenshots/.
"""
import functools, http.server, json, os, sys, threading, urllib.parse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'screenshots')
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + str(detail)))

def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
        extensions_map = dict(getattr(http.server.SimpleHTTPRequestHandler, 'extensions_map', {}))
        extensions_map.update({
            '.webmanifest': 'application/manifest+json',
            '.js': 'application/javascript',
        })
    h = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

SELECT_JS = """([needle, nth]) => {
  const ed = document.getElementById('editor'); const t = ed.textContent;
  let i = -1; for (let k = 0; k <= (nth||0); k++) i = t.indexOf(needle, i + 1);
  if (i < 0) throw new Error('not found: ' + needle);
  const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n, pos = 0, r = document.createRange(), s = false;
  while ((n = w.nextNode())) { const L = n.data.length;
    if (!s && i < pos + L) { r.setStart(n, i - pos); s = true; }
    if (s && i + needle.length <= pos + L) { r.setEnd(n, i + needle.length - pos); break; }
    pos += L; }
  ed.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}"""

def select(page, needle, nth=0):
    page.evaluate(SELECT_JS, [needle, nth])

def caret_in(page, needle):
    select(page, needle)
    page.evaluate("() => { getSelection().collapseToStart(); }")

def text(page):
    return page.evaluate("() => document.getElementById('editor').textContent")

def main():
    srv = serve()
    url = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]
    exe = os.environ.get('CHROME')
    if not exe:
        for candidate in ('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'):
            if os.path.exists(candidate):
                exe = candidate
                break
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        try:
            run(b, url)
        except Exception as e:
            check('test run completed without exceptions', False, repr(e)[:600])
            try: print('EDITOR HTML:', DEBUG['page'].evaluate("document.getElementById('editor').innerHTML"))
            except Exception: pass
        b.close()
    srv.shutdown()
    failed = [n for n, ok in results if not ok]
    print('\n%d passed, %d failed' % (len(results) - len(failed), len(failed)))
    sys.exit(1 if failed else 0)

DEBUG = {}

def run(b, url):
    if True:
        ctx = b.new_context(viewport={'width': 1360, 'height': 860})
        page = ctx.new_page(); page.set_default_timeout(5000); DEBUG['page'] = page
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(url)

        # 0. First open: workspace visible, sample document showing every feature, hint bar.
        page.wait_for_selector('#editor .alt')
        check('first open: workspace visible by default', page.is_visible('#alts') and page.is_visible('#btn-lab') and page.is_visible('#btn-save') and page.is_visible('#btn-docs') and page.is_visible('#btn-help'))
        check('first open: sample has a word alternate', page.evaluate("Object.values(CopycatWriter.state.alts).some(a => a.level === 'word' && a.versions.length > 1)"))
        check('first open: sample has a sentence alternate', page.evaluate("Object.values(CopycatWriter.state.alts).some(a => a.level === 'sentence' && a.versions.length > 1)"))
        check('first open: dots drawn under alternates', page.locator('.dots').count() == 2)
        check('first open: a ghosted phrase', page.locator('#editor .ghost').count() == 1)
        check('first open: Overflow open with content', page.is_visible('#overflow') and 'scratchpad' in page.input_value('#overflow-text'))
        check('first open: hint shown', page.is_visible('#hint') and 'right-click text for tools' in page.inner_text('#hint'))
        page.mouse.move(1, 1)
        page.screenshot(path=os.path.join(SHOTS, '0-initial-open.png'))
        page.hover('#editor .alt >> nth=0'); page.keyboard.press('ArrowDown')
        check('sample: swapping thumbtack fixes the article', 'with an eraser' in text(page), text(page))
        # right-click with no selection selects the word under the pointer and opens our menu
        page.evaluate("getSelection().removeAllRanges()")
        box = page.evaluate("""() => { const ed = document.getElementById('editor'); const t = ed.textContent; const i = t.indexOf('Welcome');
            const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n, pos = 0; while ((n = w.nextNode())) { if (i < pos + n.data.length) break; pos += n.data.length; }
            const r = document.createRange(); r.setStart(n, i - pos + 2); r.setEnd(n, i - pos + 3); const b = r.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; }""")
        page.mouse.click(box[0], box[1], button='right')
        check('right-click with no selection selects the word', page.evaluate("getSelection().toString()") == 'Welcome', page.evaluate("getSelection().toString()"))
        check('right-click opens the custom menu', page.is_visible('#ctx') and page.inner_text('#ctx-ghost-label') == 'Ghost it')
        page.click('#ctx [data-ctx="ghost"]')
        check('menu Ghost it works on that word', page.evaluate("[...document.querySelectorAll('#editor .ghost')].some(g => g.textContent === 'Welcome')"))
        # ? shows the shortcuts
        page.click('#btn-help')
        check('? button shows shortcuts', page.is_visible('#help') and 'Ctrl' in page.inner_text('#help') and 'Ghost it' in page.inner_text('#help'))
        page.click('#help-close')
        check('shortcuts close', not page.is_visible('#help'))
        # hint dismissal is remembered
        page.click('#hint-close')
        page.reload(); page.wait_for_selector('#editor')
        check('hint stays dismissed after reload', not page.is_visible('#hint'))
        check('sample not re-seeded over your edits', page.evaluate("CopycatWriter.state.docId") == 'd-sample' and 'with an eraser' in text(page), text(page)[:80])

        # 1. New blank document, then plain mode via the count.
        page.click('#btn-new')
        check('new document is blank', text(page) == '')
        ed = page.locator('#editor')
        ed.click()
        page.keyboard.type('I need a thumbtack for the corkboard.')
        page.keyboard.press('Enter')
        page.keyboard.type('Honestly, this is a really very simple plan that is just fine.')
        check('typing works with a newline paragraph', text(page) == 'I need a thumbtack for the corkboard.\nHonestly, this is a really very simple plan that is just fine.', repr(text(page)))
        check('count top-left shows words and chars', page.inner_text('#count').startswith('19 words'), page.inner_text('#count'))
        page.click('#count')
        check('count click hides the workspace (plain mode)', not page.is_visible('#alts') and not page.is_visible('#btn-lab') and not page.is_visible('.topbar'))
        page.mouse.click(5, 850)
        page.screenshot(path=os.path.join(SHOTS, '1-plain-editor.png'))

        # 2. Clicking the count toggles the workspace back.
        page.click('#count')
        check('count click opens workspace', page.is_visible('#alts') and page.is_visible('#btn-lab') and page.is_visible('#btn-save') and page.is_visible('#btn-docs'))
        check('tabs Word/Sentence/Paragraph', page.locator('.tab').all_inner_texts() == ['Word', 'Sentence', 'Paragraph'])
        check('about line credits Jason and says go use his', 'go use his instead. It will be better.' in page.inner_text('#about-line') and "Jason Fried's Write_On" in page.inner_text('#about-line'))
        if page.is_visible('#overflow'): page.click('#btn-overflow')

        # 3. Word alternate with Ctrl+Shift+A, then cycle with hover + Up/Down, a/an fix.
        select(page, 'thumbtack')
        page.keyboard.press('Control+Shift+A')
        check('Ctrl+Shift+A focuses the alt input', page.evaluate("document.activeElement.id") == 'alt-input')
        page.keyboard.type('eraser'); page.keyboard.press('Enter')
        page.keyboard.type('pushpin'); page.keyboard.press('Enter')
        check('sidebar lists 3 versions', page.locator('#alt-list li').count() == 3, page.locator('#alt-list li').count())
        check('squiggly underline on alternate', 'wavy' in page.eval_on_selector('#editor .alt', 'e => getComputedStyle(e).textDecorationStyle'))
        check('three dots, first active', page.locator('.dots i').count() == 3 and page.locator('.dots i.on').count() == 1 and page.get_attribute('.dots i:nth-child(1)', 'class') == 'on')
        page.hover('#editor .alt'); ed.focus()
        page.hover('#editor .alt')
        page.keyboard.press('ArrowDown')
        check('ArrowDown swaps to eraser', 'I need an eraser for' in text(page), text(page))
        check('a -> an fixed', text(page).startswith('I need an eraser'))
        check('active dot moved', page.get_attribute('.dots i:nth-child(2)', 'class') == 'on')
        page.hover('#editor .alt'); page.keyboard.press('ArrowDown')
        check('ArrowDown again: pushpin, an -> a', text(page).startswith('I need a pushpin'), text(page))
        page.hover('#editor .alt'); page.keyboard.press('ArrowUp'); page.keyboard.press('ArrowUp')
        check('ArrowUp cycles back to thumbtack', text(page).startswith('I need a thumbtack'), text(page))
        page.hover('#editor .alt'); page.keyboard.press('ArrowUp')
        check('ArrowUp wraps to last version', text(page).startswith('I need a pushpin'), text(page))
        check('articleFor edge cases', page.evaluate("[CopycatWriter.articleFor('hour'), CopycatWriter.articleFor('unicorn'), CopycatWriter.articleFor('umbrella'), CopycatWriter.articleFor('eraser')]") == ['an', 'a', 'an', 'an'])
        # clicking a sidebar row picks that version
        page.click('#editor .alt'); page.click('#alt-list li:nth-child(2)')
        check('clicking a sidebar row picks it', text(page).startswith('I need an eraser'), text(page))

        # 4. Sentence alternate via Sentence tab + click.
        caret_in(page, 'plan that')
        page.click('.tab[data-level="sentence"]')
        check('sentence target shown', 'This sentence' in page.inner_text('#alt-target'), page.inner_text('#alt-target'))
        page.fill('#alt-input', 'Honestly, the plan is fine.')
        page.press('#alt-input', 'Enter')
        check('sentence alternate created', page.evaluate("Object.values(CopycatWriter.state.alts).some(a => a.level === 'sentence' && a.versions.length === 2)"))
        page.mouse.move(1, 1)
        page.hover('#editor .alt >> nth=1'); page.keyboard.press('ArrowDown')
        check('sentence cycles in place', text(page).endswith('Honestly, the plan is fine.'), text(page))
        page.hover('#editor .alt >> nth=1'); page.keyboard.press('ArrowDown')
        check('sentence cycles back', text(page).endswith('just fine.'), text(page))
        # Paragraph tab uses a multi-line textarea
        caret_in(page, 'need')
        page.click('.tab[data-level="paragraph"]')
        check('paragraph tab shows a textarea', page.is_visible('#alt-textarea') and not page.is_visible('#alt-input'))
        page.fill('#alt-textarea', 'I need something to pin this up.')
        page.press('#alt-textarea', 'Enter')
        check('paragraph alternate created', page.evaluate("Object.values(CopycatWriter.state.alts).some(a => a.level === 'paragraph' && a.versions.length === 2)"))
        page.mouse.move(1, 1)
        page.hover('#editor .alt >> nth=0'); page.keyboard.press('ArrowDown')
        check('paragraph cycles', text(page).startswith('I need something to pin this up.'), text(page))
        # delete versions with x
        page.click('#editor .alt >> nth=0')
        page.hover('#alt-list li:nth-child(2)'); page.click('#alt-list li:nth-child(2) .del')
        check('nested word alternate survives a paragraph swap', page.evaluate("[...document.querySelectorAll('#editor .alt')].some(e => e.textContent === 'eraser')"), page.evaluate("document.getElementById('editor').innerHTML"))
        check('x deletes a version; last one unwraps', page.evaluate("!Object.values(CopycatWriter.state.alts).some(a => a.level === 'paragraph')") and text(page).startswith('I need'), text(page))

        # 5. Ghost it / Revive it.
        select(page, 'corkboard')
        page.keyboard.press('Control+/')
        g = page.locator('#editor .ghost')
        check('Ctrl+/ ghosts the selection', g.count() == 1 and g.inner_text() == 'corkboard')
        check('ghost opacity is about 10%', abs(float(page.eval_on_selector('#editor .ghost', 'e => getComputedStyle(e).opacity')) - 0.1) < 0.01)
        check('ghosted words leave the count', page.inner_text('#count').startswith('18 words'), page.inner_text('#count'))
        caret_in(page, 'corkboard')
        page.click('#editor .ghost', button='right')
        check('right-click on ghost offers Revive it', page.is_visible('#ctx') and page.inner_text('#ctx-ghost-label') == 'Revive it')
        page.click('#ctx [data-ctx="ghost"]')
        check('Revive it restores the text', page.locator('#editor .ghost').count() == 0 and 'corkboard' in text(page))
        select(page, 'corkboard')
        page.click('#editor', button='right', position={'x': 5, 'y': 5})
        select(page, 'corkboard')
        page.evaluate("() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); window.__pt = [r.x + 5, r.y + 5]; }")
        pt = page.evaluate('window.__pt'); page.mouse.click(pt[0], pt[1], button='right')
        check('right-click on selection offers Ghost it', page.inner_text('#ctx-ghost-label') == 'Ghost it')
        page.click('#ctx [data-ctx="ghost"]')
        check('context menu Ghost it works', page.locator('#editor .ghost').count() == 1)
        caret_in(page, 'corkboard'); page.keyboard.press('Control+/')
        check('Ctrl+/ revives', page.locator('#editor .ghost').count() == 0)

        # 6. Stash in Overflow.
        select(page, ' really very simple')
        page.keyboard.press('Control+Shift+S')
        check('stash cuts from editor', 'really very simple' not in text(page), text(page))
        check('stash lands in Overflow, panel open', page.is_visible('#overflow') and 'really very simple' in page.input_value('#overflow-text'))
        # paste back from Overflow into the editor (copy/paste both ways)
        page.fill('#overflow-text', 'pasted from overflow')
        page.click('#overflow-text'); page.keyboard.press('Control+A'); page.keyboard.press('Control+C')
        caret_in(page, 'plan'); page.keyboard.press('Control+V')
        pasted = 'pasted from overflow' in text(page)
        check('copy from Overflow, paste into editor', pasted, text(page))
        page.keyboard.press('Control+Z')
        # drag from the editor into the Overflow
        page.fill('#overflow-text', '')
        # Native text drag in headless Chrome is occasionally flaky, so allow a few attempts.
        for attempt in range(4):
            select(page, 'corkboard')
            r = page.evaluate("() => { const b = getSelection().getRangeAt(0).getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; }")
            o = page.locator('#overflow-text').bounding_box()
            page.mouse.move(r[0], r[1]); page.mouse.down(); page.mouse.move(r[0] + 20, r[1] + 5, steps=4)
            page.mouse.move(o['x'] + 40, o['y'] + 30, steps=10); page.mouse.up()
            if 'corkboard' in page.input_value('#overflow-text'): break
            page.mouse.click(5, 850)
        check('drag text from editor into Overflow', 'corkboard' in page.input_value('#overflow-text'), (page.input_value('#overflow-text'), text(page), page.evaluate('getSelection().toString()')))
        # drag from Overflow back into the editor
        page.evaluate("() => { const t = document.getElementById('overflow-text'); t.focus(); t.setSelectionRange(0, t.value.length); }")
        ob = page.locator('#overflow-text').bounding_box()
        end = page.evaluate("() => { const ed = document.getElementById('editor'); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const b = r.getClientRects(); const x = b.length ? b[0] : ed.getBoundingClientRect(); return [x.x + 2, x.y + x.height/2]; }")
        page.evaluate("() => { const t = document.getElementById('overflow-text'); t.focus(); t.setSelectionRange(0, t.value.length); }")
        page.mouse.move(ob['x'] + 30, ob['y'] + 18); page.mouse.down(); page.mouse.move(ob['x'] + 40, ob['y'] + 22, steps=4)
        page.mouse.move(end[0], end[1], steps=12); page.mouse.up()
        check('drag text from Overflow back into editor', text(page).count('corkboard') >= 1 and page.input_value('#overflow-text').strip() == '', (text(page), page.input_value('#overflow-text')))
        page.click('#btn-overflow')
        check('Overflow toggle hides panel', not page.is_visible('#overflow'))

        # 7. AI without a key explains politely; with a mock endpoint fills the sidebar with sparkles.
        select(page, 'plan')
        page.keyboard.press('Control+Shift+E')
        check('AI without key explains', 'needs your own AI key' in page.inner_text('#toast'), page.inner_text('#toast'))
        page.evaluate("""() => localStorage.setItem('ccw.settings', JSON.stringify({base:'https://mock-ai.test/v1', model:'mock', key:'test-key-not-real'}))""")
        seen = {}
        def fake(route, request):
            seen['auth'] = request.headers.get('authorization'); seen['url'] = request.url
            body = json.loads(request.post_data)
            sysmsg = body['messages'][0]['content']
            if '"alternatives"' in sysmsg: content = json.dumps({'alternatives': ['scheme', 'idea']})
            elif '"cuts"' in sysmsg: content = json.dumps({'cuts': ['Honestly, ', 'that is ']})
            else: content = json.dumps({'flags': []})
            route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'choices': [{'message': {'content': content}}]}))
        page.route('https://mock-ai.test/**', fake)
        select(page, 'plan')
        page.keyboard.press('Control+Shift+E')
        page.wait_for_function("document.querySelectorAll('#alt-list li .mark svg').length >= 2")
        check('AI alternatives listed with sparkle icon', page.locator('#alt-list li .mark svg').count() == 2)
        check('own version has a plain bullet', page.inner_text('#alt-list li:nth-child(1) .mark') == '•')
        check('AI call uses configured base URL + bearer key', seen.get('url') == 'https://mock-ai.test/v1/chat/completions' and seen.get('auth') == 'Bearer test-key-not-real', seen)
        page.evaluate("() => localStorage.removeItem('ccw.settings')")

        # Set up a longer text for the lab.
        page.evaluate("""() => { const ed = document.getElementById('editor'); ed.innerHTML = ''; CopycatWriter.state.alts = {}; ed.textContent =
 'We really need to ship the new editor this week. I think it is basically ready, and it is very fast.\\n' +
 'The sidebar was designed by the team in order to make alternates easy. It is just a list. There are a lot of things that we could add later, which is fine, because that is how software works, which nobody denies, although some disagree, and that is okay.\\n' +
 'Writing should feel quiet. The tool should actually get out of the way. Simply put, less is more.'; ed.dispatchEvent(new Event('input')); }""")
        page.mouse.move(1, 1)
        before = text(page)

        # 8. Lab scans.
        page.click('#btn-lab')
        check('Lab menu titled "The lab guide"', page.inner_text('#lab-menu .pop-h') == 'The lab guide')
        check('Lab has the four trims', all(page.is_visible('[data-lab="trim-%s"]' % k) for k in ['slight', 'tighten', 'sharper', 'half']))
        page.click('[data-lab="scan-weak"]')
        check('weak scan marks sentences', page.evaluate("CSS.highlights.get('cc-weak').size") >= 2, page.inner_text('#toast'))
        page.click('#btn-lab'); page.click('[data-lab="scan-convoluted"]')
        check('convoluted scan marks the long sentence', page.evaluate("CSS.highlights.get('cc-conv').size") >= 1, page.inner_text('#toast'))
        page.click('#btn-lab'); page.click('[data-lab="scan-clear"]')

        # 9. Slight trim -> Make the cuts.
        page.click('#btn-lab'); page.click('[data-lab="trim-slight"]')
        n = page.locator('#editor .ghost.cut').count()
        check('Slight trim ghosts suggested cuts', n >= 4, n)
        check('trim toast has Make the cuts / Walk through / Done', page.locator('#toast button').all_inner_texts() == ['Make the cuts', 'Walk through', 'Done'])
        page.screenshot(path=os.path.join(SHOTS, '3-lab-trim-toast.png'))
        page.click('#trim-make')
        t = text(page)
        check('Make the cuts deletes ghosted text', 'really' not in t and 'basically' not in t and 'very fast' not in t and 'just a list' not in t and 'actually' not in t, t)
        check('cuts leave clean spacing', '  ' not in t and ' ,' not in t and 'Simply put, less is more' in t, t)
        check('no ghosts left after cutting', page.locator('#editor .ghost').count() == 0)

        # 10. Tighten some -> Walk through: accept first, skip second, accept the rest.
        page.click('#btn-lab'); page.click('[data-lab="trim-tighten"]')
        cuts = page.evaluate("[...document.querySelectorAll('#editor .ghost.cut')].map(e => e.textContent)")
        check('Tighten some finds cuts', len(cuts) >= 2, cuts)
        page.click('#trim-walk')
        check('walk through shows step 1', 'Cut 1 of %d' % len(cuts) in page.inner_text('#toast'), page.inner_text('#toast'))
        check('walk through focuses the suggestion', page.locator('#editor .cut.focus').count() == 1)
        page.click('#walk-accept')
        check('walk through step 2', 'Cut 2 of %d' % len(cuts) in page.inner_text('#toast'), page.inner_text('#toast'))
        page.click('#walk-skip')
        while page.locator('#walk-accept').count():
            page.click('#walk-accept')
        t = text(page)
        check('walk through: first cut made', cuts[0].strip() not in t or t.count(cuts[0].strip()) < before.count(cuts[0].strip()), (cuts[0], t))
        check('walk through: skipped one kept and revived', cuts[1].strip() in t and page.locator('#editor .ghost').count() == 0, (cuts[1], t))
        check('walk through summary', 'Walked through' in page.inner_text('#toast'), page.inner_text('#toast'))

        # 11. Even sharper, Done keeps ghosts as plain ghosts.
        page.click('#btn-lab'); page.click('[data-lab="trim-sharper"]')
        k = page.locator('#editor .ghost.cut').count()
        page.click('#trim-done')
        check('Done leaves suggestions ghosted (revivable)', page.locator('#editor .ghost').count() == k and page.locator('#editor .ghost.cut').count() == 0 and k > 0, k)
        page.evaluate("() => document.querySelectorAll('#editor .ghost').forEach(g => { const p = g.parentNode; while (g.firstChild) p.insertBefore(g.firstChild, g); g.remove(); })")

        # 12. Cut in half.
        vis_words = len(page.evaluate("CopycatWriter.visibleText()").split())
        page.click('#btn-lab'); page.click('[data-lab="trim-half"]')
        after_words = len(page.evaluate("CopycatWriter.visibleText()").split())
        check('Cut in half ghosts about half the words', after_words <= vis_words * 0.6, (vis_words, after_words))
        page.click('#trim-make')
        check('Cut in half: Make the cuts', len(text(page).split()) == after_words, (len(text(page).split()), after_words))

        # 13. AI trims with a mock key.
        page.evaluate("() => { const ed = document.getElementById('editor'); ed.textContent = 'Honestly, this is a plan that is fine.'; ed.dispatchEvent(new Event('input')); }")
        page.evaluate("""() => localStorage.setItem('ccw.settings', JSON.stringify({base:'https://mock-ai.test/v1', model:'mock', key:'test-key-not-real'}))""")
        page.click('#btn-lab'); page.click('[data-lab="trim-slight"]')
        page.wait_for_selector('#trim-make')
        page.click('#trim-make')
        check('AI trim cuts exact substrings', text(page) == 'This is a plan fine.', text(page))
        page.evaluate("() => localStorage.removeItem('ccw.settings')")

        # 14. Save, multiple documents, reload.
        page.evaluate("() => { const ed = document.getElementById('editor'); ed.innerHTML = ''; CopycatWriter.state.alts = {}; ed.textContent = 'Doc one has a thumbtack.'; ed.dispatchEvent(new Event('input')); }")
        select(page, 'thumbtack'); page.keyboard.press('Control+Shift+A'); page.keyboard.type('eraser'); page.keyboard.press('Enter')
        page.mouse.move(1, 1); page.hover('#editor .alt'); page.keyboard.press('ArrowDown')
        if not page.is_visible('#overflow'): page.click('#btn-overflow')
        page.fill('#overflow-text', 'overflow note')
        page.click('#btn-save')
        check('save toast', 'Saved' in page.inner_text('#toast'))
        page.click('#btn-new')
        check('new document is empty', text(page) == '')
        page.click('#editor'); page.keyboard.type('Doc two.'); page.keyboard.press('Control+S')
        page.click('#btn-docs')
        check('documents list shows sample + both docs', page.locator('.doc-row').count() == 3 and page.locator('.doc-row:has-text("Doc one")').count() == 1, page.locator('.doc-row').all_inner_texts())
        page.click('.doc-row button.open:has-text("Doc one")')
        check('switch back to doc one', text(page) == 'Doc one has an eraser.', text(page))
        page.reload()
        check('reload restores the current doc', text(page) == 'Doc one has an eraser.', text(page))
        check('reload restores alternates and dots', page.evaluate("Object.keys(CopycatWriter.state.alts).length") == 1 and page.locator('.dots i').count() == 2)
        check('reload restores Overflow', page.input_value('#overflow-text') == 'overflow note')
        check('workspace still visible after reload', page.is_visible('#alts'))
        page.hover('#editor .alt'); page.keyboard.press('ArrowUp')
        check('alternate still cycles after reload, a/an fixed', text(page) == 'Doc one has a thumbtack.', text(page))

        # 15. Post to X intent and LinkedIn shake.
        page.evaluate("() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; }")
        select(page, 'one'); page.keyboard.press('Control+/')
        page.click('#btn-x')
        opened = page.evaluate('window.__opened')
        expected = 'https://x.com/intent/post?text=' + urllib.parse.quote('Doc has a thumbtack.', safe="-_.!~*'()")
        check('Post to X opens the web intent without ghosted text', opened == [expected], (opened, expected))
        page.click('#btn-linkedin', force=True)
        check('LinkedIn is disabled and shakes', page.get_attribute('#btn-linkedin', 'aria-disabled') == 'true' and 'shake' in page.get_attribute('#btn-linkedin', 'class'))

        # 16. Count toggles the workspace off again.
        page.click('#count')
        check('count click closes workspace', not page.is_visible('#alts'))
        check('no page errors', not errors, errors)

        # Showcase screenshot: workspace with alternates and the sidebar.
        sc = b.new_context(viewport={'width': 1360, 'height': 860}); sp = sc.new_page(); sp.set_default_timeout(5000)
        sp.route('https://mock-ai.test/**', fake)
        sp.goto(url)
        sp.click('#hint-close'); sp.click('#btn-new'); sp.click('#btn-overflow')
        sp.evaluate("""() => localStorage.setItem('ccw.settings', JSON.stringify({base:'https://mock-ai.test/v1', model:'mock', key:'test-key-not-real'}))""")
        sp.click('#editor')
        sp.keyboard.type('The draft is done. I wrote it with a thumbtack in one hand and coffee in the other.')
        sp.keyboard.press('Enter'); sp.keyboard.press('Enter')
        sp.keyboard.type('Every sentence has a job. If it does not do the job, it goes. Simple plan.')
        select(sp, 'Simple plan.'); sp.keyboard.press('Control+Shift+A'); sp.keyboard.type('Simple rule.'); sp.keyboard.press('Enter')
        select(sp, 'coffee in the other'); sp.keyboard.press('Control+/')
        select(sp, 'thumbtack'); sp.keyboard.press('Control+Shift+A'); sp.keyboard.type('eraser'); sp.keyboard.press('Enter')
        sp.keyboard.press('Control+Shift+E'); sp.wait_for_function("document.querySelectorAll('#alt-list li').length >= 4")
        sp.mouse.move(1, 1); sp.hover('#editor .alt >> nth=0'); sp.keyboard.press('ArrowDown')
        check('showcase: a/an fixed after swap', 'with an eraser' in text(sp), text(sp))
        sp.mouse.move(1, 1); sp.click('#editor .alt >> nth=0'); sp.mouse.move(1, 1)
        sp.evaluate("document.getElementById('toast').hidden = true")
        sp.screenshot(path=os.path.join(SHOTS, '2-workspace-alternates.png'))
        sc.close()

        # 17. PWA: relative manifest and a service worker that registers over http.
        man_href = page.evaluate("() => document.querySelector('link[rel=\"manifest\"]').getAttribute('href')")
        check('manifest link is relative', bool(man_href) and not man_href.startswith('/') and '://' not in man_href, man_href)
        man = page.evaluate("""async () => {
          const href = document.querySelector('link[rel="manifest"]').href;
          const r = await fetch(href);
          return { ok: r.ok, type: (r.headers.get('content-type') || ''), body: await r.json() };
        }""")
        check('manifest is served as manifest+json', man['ok'] and 'application/manifest+json' in man['type'], man.get('type'))
        check('manifest name is Copycat Writer', man['body'].get('name') == 'Copycat Writer', man['body'].get('name'))
        start, scope = man['body'].get('start_url', ''), man['body'].get('scope', '')
        check('manifest start_url and scope are relative', start.startswith('./') and scope.startswith('./'), (start, scope))
        purposes = set()
        sizes = set()
        for ic in man['body'].get('icons') or []:
            purposes.add(ic.get('purpose') or '')
            sizes.add(ic.get('sizes') or '')
            check('manifest icon src is relative', bool(ic.get('src')) and not ic['src'].startswith('/') and '://' not in ic['src'], ic.get('src'))
        check('manifest has 192, 512 and maskable icons', '192x192' in sizes and '512x512' in sizes and 'maskable' in purposes, (sizes, purposes))
        sw = page.evaluate("""async () => {
          const r = await navigator.serviceWorker.ready;
          const keys = await caches.keys();
          return { scope: r.scope, active: !!(r.active && r.active.state), keys: keys, cache: 'copycat-writer-v1' };
        }""")
        check('service worker becomes ready on http', sw['active'] and 'copycat-writer-v1' in sw['keys'], sw)

        # 18. Opening index.html straight from disk works too, and does not register a worker.
        p2 = ctx.new_page(); errs2 = []
        p2.on('pageerror', lambda e: errs2.append(str(e)))
        p2.goto('file://' + os.path.join(ROOT, 'index.html'))
        p2.wait_for_selector('#editor .alt')
        check('file:// opens with workspace, sample and hint', p2.is_visible('#alts') and p2.is_visible('#hint') and p2.locator('.dots').count() == 2 and not errs2, errs2)
        p2.click('#btn-new'); p2.click('#editor'); p2.keyboard.type('From disk.')
        p2.evaluate("getSelection().removeAllRanges()")
        bb = p2.evaluate("() => { const r = document.createRange(); const n = document.getElementById('editor').firstChild; r.setStart(n, 6); r.setEnd(n, 7); const b = r.getBoundingClientRect(); return [b.x + 2, b.y + b.height/2]; }")
        p2.mouse.click(bb[0], bb[1], button='right')
        check('file:// typing, count and right-click menu work', p2.inner_text('#count').startswith('2 words') and p2.is_visible('#ctx') and p2.evaluate("getSelection().toString()") == 'disk', (p2.inner_text('#count'), p2.evaluate("getSelection().toString()"), errs2))
        no_sw = p2.evaluate("""() => {
          if (!('serviceWorker' in navigator)) return true;
          return navigator.serviceWorker.controller == null;
        }""")
        check('file:// does not register a service worker', no_sw and not errs2, (no_sw, errs2))

if __name__ == '__main__':
    main()
