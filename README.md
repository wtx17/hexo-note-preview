# Hexo Note Preview

Render Hexo/Fluid note and fold tags as callout boxes in Obsidian Reading View
and Live Preview. Note content follows Fluid's output model: Markdown is rendered
first and then wrapped by a note container. The preview also keeps a compact type
label such as `primary` or `warning`.

Supported forms:

```md
{% note warning %}
Markdown content, including math, lists and links.
{% endnote %}
```

`{% end note %}` is also accepted. Supported types are `primary`, `info`,
`success`, `warning`, `danger`, `secondary`, and `light`. In this vault an
omitted or `default` note type resolves to `light`, matching Fluid's
`post.updated.note_class` setting.

Fold tags are rendered as always-open boxes with a title:

```md
{% fold info @解 %}
Markdown content.
{% endfold %}
```

For preview compatibility the title may omit `@`; an unrecognized first word is
treated as part of the title rather than as a type. No actual folding behavior
is added.

Tag markers must start at the beginning of a line. This keeps them as top-level
Hexo tags: markers inside lists, blockquotes, fenced/indented code, raw blocks,
HTML comments, or front matter are intentionally left untouched.

A closing tag can immediately follow a Markdown list or blockquote; no
separating blank line is required for the preview. In Live Preview, hidden
closing tags keep a compact bottom edge without extending the quote border.

Nested blocks keep the parent background and render the child block inset from
it, including around rendered math blocks.

After installing or changing the plugin files, reload Obsidian and enable
**Hexo Note Preview** under **Settings -> Community plugins**.
