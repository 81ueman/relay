# relay Herdr plugin — Ctrl+click pane links

`relay dashboard` renders each worker's Herdr pane id as an OSC8 link
(`https://relay.local/pane/<pane_id>`). This Herdr plugin makes a Control+click
on such a link **focus that pane** instead of opening the URL in a browser.

Herdr does not focus a pane by absolute id over its CLI, so the handler talks to
the Herdr socket (`pane.focus`). All of that lives in relay:
`focus-pane.ts` is a thin shim over `relay dashboard --focus`.

## Install

```bash
# from the relay checkout
herdr plugin link "$(pwd)/integrations/herdr"
herdr plugin list                                # relay.pane-links ... enabled
```

`relay` must be on `PATH` (`bun link`), or set `RELAY_BIN` for the action
(`RELAY_BIN="bun /path/to/relay/src/cli.ts"`).

## Verify / remove

```bash
herdr plugin list
herdr plugin log relay.pane-links --tail        # click-time output
herdr plugin unlink relay.pane-links
```

## Test without clicking

```bash
HERDR_PLUGIN_CLICKED_URL='https://relay.local/pane/w1:p1' bun integrations/herdr/focus-pane.ts
```
