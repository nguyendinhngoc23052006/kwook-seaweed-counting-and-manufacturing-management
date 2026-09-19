import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// styles.css is the floor's design system, imported into the `legacy` cascade
// layer by index.css. Layers arbitrate between declarations OF THE SAME
// PROPERTY -- so a legacy rule on a bare element wins every property the
// Tailwind class on that element does not itself declare, no matter the layer
// order. That is invisible to code review, because nothing in the JSX is
// wrong.
//
// It has cost two production fixes already: `.grid` set grid-template-columns
// that Tailwind's `grid` utility (display only) never contested, laying every
// hub dialog out in two columns; and `button { min-height; padding;
// background; border }` turned every Radix control that renders a <button>
// into floor chrome -- a 20px checkbox measured 34x44px and ghost buttons
// rendered solid blue.
//
// Both are fixed at the source. This test is what stops the third one: the
// floor addresses its own elements through its own classes (.btn,
// .field__input, .table), so a bare selector for anything shadcn also renders
// is always a latent collision, never a deliberate style.
// `a` is here for the same reason as the rest: an anchor with no colour class
// of its own -- a shadcn menu item, a link inside a card -- inherits its
// colour, and inheritance always loses to a rule that matches the element
// itself. The floor's anchors all carry .btn, .navlink or .card--link, each
// of which sets its own colour, so the bare rule only ever reached the hub.
const FORBIDDEN_BARE = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "table",
  "th",
  "td",
  "fieldset",
];

// Tailwind ships a utility of the same name for each of these, so a legacy
// class rule here wins any property that utility does not set.
const FORBIDDEN_CLASSES = ["grid", "table", "truncate", "flex", "block", "hidden", "container"];

// Splits a selector list on its TOP-LEVEL commas only. `:is(a, button)` is one
// selector, not two -- splitting naively turns a harmless focus-ring rule into
// a phantom bare `button` rule and the test cries wolf.
function splitTopLevel(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of prelude) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function selectorsOf(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  // Every prelude that opens a block. At-rules are kept out: their prelude is
  // a condition, and the rules nested inside them are matched on the next
  // pass through this same regex.
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = (match[1] ?? "").trim();
    if (!prelude || prelude.startsWith("@")) continue;
    selectors.push(...splitTopLevel(prelude));
  }
  return selectors;
}

describe("the legacy stylesheet", () => {
  const css = readFileSync(join(__dirname, "styles.css"), "utf8");
  const selectors = selectorsOf(css);

  it("has rules to check", () => {
    expect(selectors.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN_BARE)("does not style bare <%s>", (element) => {
    // Only an UNSCOPED rule is dangerous. `.floor-card td { }` reaches a cell
    // only inside floor markup that opted in by class, so it can never touch a
    // shadcn component; a bare `td { }` reaches every cell in the app. The
    // difference is whether any class, id or attribute appears in the
    // selector, so that is what is tested -- not the subject alone.
    const offenders = selectors.filter((s) => {
      if (/[.#[]/.test(s)) return false;
      const parts = s.split(/[\s>+~]+/).filter(Boolean);
      return parts.some((part) => part.replace(/:.*$/, "") === element);
    });
    expect(offenders).toEqual([]);
  });

  it.each(FORBIDDEN_CLASSES)("does not define .%s, which Tailwind also ships", (className) => {
    const offenders = selectors.filter((s) => {
      const subject = s.split(/\s+|>/).filter(Boolean).pop() ?? "";
      return subject === `.${className}` || subject.startsWith(`.${className}:`);
    });
    expect(offenders).toEqual([]);
  });
});
