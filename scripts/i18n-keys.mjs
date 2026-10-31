// Lists the English source text passed to t() across the app, so tests can check every one has a translation.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** String literals in an expression, skipping ones compared with === or !== (state values, not text). */
function literals(expression) {
  const found = [];
  for (const match of expression.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
    if (!/[=!]==\s*$/.test(expression.slice(0, match.index))) found.push(match[2]);
  }
  return found;
}

/** The first argument of each t( … ) call: everything up to a top-level comma or the closing parenthesis. */
function firstArguments(source) {
  const result = [];
  const call = /(?<![\w.$])t\(/g;
  let match;
  while ((match = call.exec(source))) {
    let depth = 0, quote = null, i = match.index + 2, start = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
    result.push(source.slice(start, i));
  }
  return result;
}

export function translationKeys(root) {
  const keys = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.startsWith('i18n')) {
        for (const argument of firstArguments(readFileSync(path, 'utf8'))) {
          for (const text of literals(argument)) if (text) keys.add(text.replace(/\\(.)/g, '$1'));
        }
      }
    }
  };
  walk(root);
  return keys;
}

if (import.meta.url === `file://${process.argv[1]}`) for (const key of translationKeys(process.argv[2] ?? 'src')) console.log(key);
