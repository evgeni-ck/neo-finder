/* Cache-busting for GitHub Pages.
 *
 * Pages serves every file with `Cache-Control: max-age=600`, so after a deploy
 * a browser can keep running the previous neo.js against the new index.html for
 * up to ten minutes — or longer, since browsers heuristically extend it. Giving
 * the script a URL that changes with its content sidesteps that: index.html is
 * small and re-fetched, and a new `?v=` is a URL the cache has never seen.
 *
 * The stamp is the first eight hex digits of the SHA-1 of neo.js, so it only
 * changes when the script does. Run by the pre-commit hook; safe to run by hand:
 *     node .githooks/stamp.js
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'neo.js'));
const v = crypto.createHash('sha1').update(js).digest('hex').slice(0, 8);
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const stamped = html.replace(/<script src="neo\.js(?:\?v=[0-9a-f]*)?"><\/script>/,
                             '<script src="neo.js?v=' + v + '"></script>');
if (!/neo\.js\?v=/.test(stamped)) { console.error('stamp: script tag not found in index.html'); process.exit(1); }
if (stamped !== html) { fs.writeFileSync(htmlPath, stamped); console.log('stamp: neo.js?v=' + v); }
else console.log('stamp: unchanged (' + v + ')');
