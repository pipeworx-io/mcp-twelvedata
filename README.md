# @pipeworx/twelvedata

[Twelve Data](https://twelvedata.com/docs) MCP — stock, ETF, forex, crypto data. Free 800 req/day.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Auth

- Platform: `PLATFORM_TWELVEDATA_KEY`. BYO: `?_apiKey=…`.

## Tools

- `time_series(symbol, interval, exchange?, mic_code?, country?, type?, outputsize?, prepost?, dp?, order?, timezone?, date?, start_date?, end_date?, previous_close?, format?, delimiter?)` — OHLC time series
- `quote(symbol, interval?, exchange?, country?, format?, dp?, prepost?, timezone?, eod?)` — quote snapshot
- `price(symbol, format?, prepost?)` — latest price
- `eod(symbol, exchange?, mic_code?, country?, type?, prepost?, dp?, format?)` — end-of-day quote
- `exchange_rate(symbol, format?, dp?, timezone?)` — forex rate (e.g. `EUR/USD`)
- `currency_conversion(symbol, amount, format?, dp?)` — FX conversion
- `stocks(symbol?, exchange?, mic_code?, country?, type?, format?)` — stock symbols
- `forex_pairs(symbol?, currency_base?, currency_quote?, format?)` — forex pairs
- `cryptocurrencies(symbol?, exchange?, currency_base?, currency_quote?, format?)` — crypto symbols
- `etfs(symbol?, exchange?, mic_code?, country?, page?, outputsize?)` — ETF symbols, paged (default 200 rows; `count` is the total). A stock ticker returns `empty_reason: wrong_instrument_class` with a pointer to `stocks`.
- `indices(symbol?, country?, exchange?, mic_code?, page?, outputsize?)` — index symbols, paged. ~1,300 non-US indices only: **US indices (SPX, DJI, IXIC) are not in Twelve Data's reference list**, and quoting them requires a Grow-or-higher key via `_apiKey`; a US filter returns that refusal rather than an empty list.
- `earnings(symbol, exchange?, country?, mic_code?, type?, period?, outputsize?, format?, dp?, start_date?, end_date?)` — earnings calendar
- `earnings_calendar(start_date?, end_date?, country?, format?, dp?)` — broad earnings calendar
- `dividends(symbol, exchange?, country?, mic_code?, range?, start_date?, end_date?)` — dividends
- `splits(symbol, exchange?, country?, mic_code?, range?, start_date?, end_date?)` — splits
- `profile(symbol, exchange?, country?, mic_code?)` — company profile

## Data source

`https://api.twelvedata.com`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "twelvedata": {
      "url": "https://gateway.pipeworx.io/twelvedata/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/twelvedata/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/time_series \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL","interval":"1h"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/time_series`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-twelvedata` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/twelvedata/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "twelvedata": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-twelvedata"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Twelvedata data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
