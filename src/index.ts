interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Twelve Data MCP.
 */


const BASE = 'https://api.twelvedata.com';
const UA = 'pipeworx-mcp-twelvedata/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  { name: 'time_series', description: 'OHLC time series.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol', 'interval'] } },
  { name: 'quote', description: 'Quote snapshot.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'price', description: 'Latest price.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'eod', description: 'End-of-day quote.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'exchange_rate', description: 'Forex rate.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, format: { type: 'string' }, dp: { type: 'number' }, timezone: { type: 'string' } }, required: ['symbol'] } },
  { name: 'currency_conversion', description: 'FX conversion.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, amount: { type: 'number' }, format: { type: 'string' }, dp: { type: 'number' } }, required: ['symbol', 'amount'] } },
  { name: 'stocks', description: 'Stock symbols.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'forex_pairs', description: 'Forex pairs.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'cryptocurrencies', description: 'Crypto symbols.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'etfs', description: 'ETF symbols.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'indices', description: 'Index symbols.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'earnings', description: 'Earnings calendar (per symbol).', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'earnings_calendar', description: 'Broad earnings calendar.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'dividends', description: 'Dividends.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'splits', description: 'Splits.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
  { name: 'profile', description: 'Company profile.', inputSchema: { type: 'object', properties: {}, additionalProperties: true, required: ['symbol'] } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) throw new Error('Twelve Data requires an API key. Set PLATFORM_TWELVEDATA_KEY or pass ?_apiKey=… (free at https://twelvedata.com/register).');
  const get = async (path: string, params: Record<string, unknown>) => {
    const p = new URLSearchParams({ apikey: apiKey });
    for (const [k, v] of Object.entries(params)) if (k !== '_apiKey' && v != null) p.set(k, String(v));
    const res = await fetch(`${BASE}${path}?${p}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (res.status === 401 || res.status === 403) throw new Error('Twelve Data: invalid API key.');
    if (!res.ok) throw new Error(`Twelve Data: ${res.status}`);
    const j = (await res.json()) as { status?: string; code?: number; message?: string };
    if (j.status === 'error') throw new Error(`Twelve Data: ${j.code} ${j.message ?? ''}`);
    return j;
  };
  switch (name) {
    case 'time_series':
      return get('/time_series', args);
    case 'quote':
      return get('/quote', args);
    case 'price':
      return get('/price', args);
    case 'eod':
      return get('/eod', args);
    case 'exchange_rate':
      return get('/exchange_rate', args);
    case 'currency_conversion':
      return get('/currency_conversion', args);
    case 'stocks':
      return get('/stocks', args);
    case 'forex_pairs':
      return get('/forex_pairs', args);
    case 'cryptocurrencies':
      return get('/cryptocurrencies', args);
    case 'etfs':
      return get('/etf', args);
    case 'indices':
      return get('/indices', args);
    case 'earnings':
      return get('/earnings', args);
    case 'earnings_calendar':
      return get('/earnings_calendar', args);
    case 'dividends':
      return get('/dividends', args);
    case 'splits':
      return get('/splits', args);
    case 'profile':
      return get('/profile', args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
