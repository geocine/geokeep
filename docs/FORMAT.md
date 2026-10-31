# Data format

GeoKeep stores notes exactly as Google Takeout exports Keep. This page describes that format and the few files GeoKeep adds beside it.

## Layout

A Takeout archive:

```
takeout-<YYYYMMDDTHHMMSSZ>-<part>-<parts>.zip
  Takeout/
    Keep/
      Labels.txt        label catalog
      <stem>.json       one note (the data)
      <stem>.html       the same note as a human-readable preview (ignored on import)
      <attachment>      images and audio, referenced by basename
```

Large exports arrive in several zip parts. A note in one part can reference an attachment in another, so import all the parts together.

The GeoKeep data folder:

```
data/
  Keep/                 same shape as Takeout/Keep, without the .html files
  geokeep.json          app-only: maps file stems to stable note ids
  snapshots/*.zip       Takeout-shaped zips (daily, and before each import)
  linkcache/            fetched link-preview metadata and images (safe to delete)
```

An export is `Takeout/Keep/…` with the exact files from `data/Keep/`, plus regenerated `.html` previews.

## Note JSON

One compact UTF-8 JSON object per file, with no BOM. Key order is not significant. Unknown keys are preserved.

| Field | Type | Notes |
|---|---|---|
| `title` | string | May be `""` |
| `color` | string | See [Colors](#colors) |
| `isPinned` | bool | |
| `isArchived` | bool | |
| `isTrashed` | bool | Pin, archive and trash are stored independently |
| `createdTimestampUsec` | int | Unix epoch in microseconds, UTC. Older exports may omit it; use the edited time instead |
| `userEditedTimestampUsec` | int | Same unit. Changes on every content edit |
| `textContent` | string | Plain-text body, with `\n` line breaks. Present on text notes |
| `textContentHtml` | string | Formatted body. Present only when `textContent` is non-empty |
| `listContent` | item[] | Checklist. Present on list notes instead of `textContent` |
| `labels` | `{ name }[]` | In the order shown on the note. Omitted when empty |
| `attachments` | `{ filePath, mimetype }[]` | Omitted when empty |
| `annotations` | annotation[] | Link previews. Omitted when empty |

A note is either a text note (`textContent`) or a checklist (`listContent`).

### Checklist item

```json
{ "textHtml": "<p dir=\"ltr\">buy milk</p>", "text": "buy milk", "isChecked": false }
```

`text` is the source of truth and may be empty or contain `\n`. Checked items come after unchecked ones. Keep the array order.

### Annotation (link preview)

```json
{ "description": "Page summary, may be empty", "source": "WEBLINK", "title": "Page title", "url": "https://example.com/page" }
```

`source` is `WEBLINK` in practice. GeoKeep adds an annotation when a note contains a reachable `http(s)` link without one, using the page's Open Graph title and description. The preview image is cached in `linkcache/` and never stored on the note. Takeout's stylesheet also defines `CALENDAR`, `DOCS`, `GMAIL`, `SHEETS` and `SLIDES`, so accept any value.

### Example

```json
{"color":"YELLOW","isTrashed":false,"isPinned":true,"isArchived":false,"title":"Groceries","userEditedTimestampUsec":1700000000000000,"createdTimestampUsec":1722620000000000,"listContent":[{"textHtml":"<p dir=\"ltr\">eggs</p>","text":"eggs","isChecked":false},{"textHtml":"<p dir=\"ltr\">bread</p>","text":"bread","isChecked":true}],"labels":[{"name":"Home"}]}
```

## Body text and HTML

`textContent` is authoritative. `textContentHtml` exists only to carry formatting:

- one `<p dir="ltr">` per line, with `<p dir="ltr"></p>` for an empty line
- `<br />` for a break inside a block, plus `<h1>` and `<h2>` headings
- formatting on `<span style="…">`: `font-weight:700` (bold), `font-style:italic`, `text-decoration:underline`
- spaces a browser would collapse are written as U+00A0

Google's own HTML wraps every run in a long Docs-style span, which GeoKeep reads. GeoKeep writes the short form above.

## Labels.txt

UTF-8 with LF line endings, one label name per line, and a trailing newline. It is the full catalog, in display order, including labels no note uses. Every label on a note also appears here. If the file is missing (older exports), the catalog is the set of labels found on the notes.

## Attachments

`filePath` is a basename in the same folder. Reject absolute paths and paths containing `..`. Names follow one of two schemes, both starting with the time the file was added:

- `{unix_millis}.{random}.{ext}`, for example `1500000000000.123456789.jpg`
- `{hex_unix_millis}.{hex_random}.{ext}`, for example `17a3b2c4d5e.0123456789abcdef.png` (GeoKeep uses this one)

Images (`image/png`, `image/jpeg`, `image/gif`, …) are the common case. Audio has shipped as `.3gp`, `.3gpp`, `.m4a` or `.aac`. If a named file is missing, try the same stem with a sibling extension (`.jpg`/`.jpeg`, the audio extensions). Failing that, keep the note and record the missing reference.

Keep drawings are exported as PNG images.

## File names

The file stem is only packaging. The title always comes from the JSON. Takeout's rules, which GeoKeep follows when it names files:

- `\ / : * ? " < > |` and `'` become `_`
- a trailing space or dot becomes `_`
- the stem is cut to 50 characters
- duplicates get `(1)`, `(2)`, … before the extension
- untitled notes get a local timestamp stem such as `2021-06-14T09_30_15.250+00_00`

GeoKeep renames a note's file when its title changes.

## Colors

Store the name. An unknown name renders as `DEFAULT`.

| Name | Keep UI name | Light | Dark |
|---|---|---|---|
| `DEFAULT` | Default | `#ffffff` | `#202124` |
| `RED` | Coral | `#faafa8` | `#77172e` |
| `ORANGE` | Peach | `#f39f76` | `#692b17` |
| `YELLOW` | Sand | `#fff8b8` | `#7c4a03` |
| `GREEN` | Mint | `#e2f6d3` | `#264d3b` |
| `TEAL` | Sage | `#b4ddd3` | `#0c625d` |
| `BLUE` | Fog | `#d4e4ed` | `#256377` |
| `CERULEAN` | Storm | `#aeccdc` | `#284255` |
| `PURPLE` | Dusk | `#d3bfdb` | `#472e5b` |
| `PINK` | Blossom | `#f6e2dd` | `#6c394f` |
| `BROWN` | Clay | `#e9e3d4` | `#4b443a` |
| `GRAY` | Chalk | `#efeff1` | `#232427` |

## Identity and re-import

Takeout has no note id, and `createdTimestampUsec` is not unique (notes created together can share it). On import, GeoKeep assigns its own id. On a later import it matches an incoming note to a stored one by:

1. the same `createdTimestampUsec`
2. then, among those, the same edited time, title, and set of attachment names

A matched note is replaced only if the incoming `userEditedTimestampUsec` is newer. Notes that exist only locally are kept.

## HTML preview

Each `.html` file is XHTML with an inline stylesheet: `<div class="note COLOR">`, a heading with the localized edited time, `.title`, `.content`, `li.listitem[.checked]`, `.attachments img`, `.chip.label` and `.chip.annotation`. It is for people, and no importer should read it.

## GeoKeep additions

- **`geokeep.json`:** `{ "app": "geokeep", "version": 1, "ids": { "<stem>": "<uuid>" } }`. It only keeps ids stable across restarts, and losing it is harmless.
- **Drawings** made in GeoKeep are ordinary PNG attachments. Their strokes are stored inside the PNG in a `tEXt` chunk with keyword `GeoKeepInk`, holding base64 JSON:

  ```json
  { "v": 1, "width": 1400, "height": 900, "grid": "none | square | dots | rules",
    "strokes": [{ "tool": "pen | marker | highlighter", "color": "#000000", "size": 2, "points": [x, y, pressure, …] }] }
  ```

  Other software shows the image and ignores the chunk.
- Reminders, collaborators and version history are not in Takeout. If GeoKeep ever adds fields for them, they go beside the Takeout keys, and a strict Takeout export should leave them out.
