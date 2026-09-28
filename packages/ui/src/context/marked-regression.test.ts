import { expect, test } from "bun:test"
import { Marked } from "marked"

test("preserves code spans adjacent to tildes", () => {
  const marked = new Marked()

  expect(marked.parse("~`0.1576` to measurement-window-only `0.00092`", { async: false })).toBe(
    "<p>~<code>0.1576</code> to measurement-window-only <code>0.00092</code></p>\n",
  )
  expect(marked.parse("`before`~`after`", { async: false })).toBe("<p><code>before</code>~<code>after</code></p>\n")
  expect(marked.parse("~~`deleted code`~~", { async: false })).toBe("<p><del><code>deleted code</code></del></p>\n")
})
