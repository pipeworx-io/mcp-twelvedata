# @pipeworx/twelvedata

[Twelve Data](https://twelvedata.com/docs) MCP — stock, ETF, forex, crypto data. Free 800 req/day.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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
- `etfs(symbol?, exchange?, country?, format?)` — ETF symbols
- `indices(symbol?, country?, format?)` — index symbols
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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Twelvedata data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
