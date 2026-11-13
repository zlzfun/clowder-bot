// How the app's stylesheets rank against each other, for the tests that keep a
// palette's rules above the café's (tests/theme-lab.test.ts, tests/colors.test.ts):
// the declarations of a stylesheet with their single selectors, and the
// specificity and the mode/bubble a selector of these stylesheets applies in.
// Only the simple selectors these files use are understood.

/** Every declaration: one entry per single selector of a rule (comments removed; @media blocks read as plain rules). */
export function declarations(css: string) {
  const out: Array<{ selector: string; prop: string; value: string }> = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = splitList(m[1]!.trim().replace(/\s+/g, ' '));
    for (const d of m[2]!.split(';')) {
      const at = d.indexOf(':');
      if (at < 0) continue;
      const prop = d.slice(0, at).trim(), value = d.slice(at + 1).trim();
      if (!prop || !value) continue;
      for (const selector of selectors) out.push({ selector, prop, value });
    }
  }
  return out;
}
// A selector list split at its top-level commas (not those inside :is(), :not() or :has()).
function splitList(list: string) {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(list.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

/** Specificity as one number: ids × 10000 + (classes, attributes, pseudo-classes) × 100 + types; :not() counts its argument. */
export function specificity(selector: string): number {
  let s = selector.replace(/:not\(([^()]*)\)/g, ' $1');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length; s = s.replace(/\[[^\]]*\]/g, '');
  const classes = (s.match(/\.[\w-]+/g) || []).length;
  const pseudo = (s.match(/(?<!:):[\w-]+/g) || []).length;
  const types = (s.replace(/[.#:][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + (attrs + classes + pseudo) * 100 + types;
}

/** Whether a selector applies in a mode, on a code block outside or inside the owner's bubble ([data-colors] is taken as matching). */
export function applies(selector: string, dark: boolean, bubble: boolean) {
  const darkOnly = /\[data-theme="dark"\]/.test(selector.replace(/:not\([^()]*\)/g, ''));
  const lightOnly = /:not\(\[data-theme="dark"\]\)/.test(selector);
  return (!darkOnly || dark) && (!lightOnly || !dark) && (!/\.bubble\b/.test(selector) || bubble);
}
