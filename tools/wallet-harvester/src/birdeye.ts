export const BIRDEYE_BASE_URL = "https://public-api.birdeye.so";
export const BIRDEYE_DEFAULT_DAILY_CU_CAP = 100_000;
export const BIRDEYE_DEFAULT_HOURLY_CU_CAP = 10_000;

export type ProviderState = "disabled" | "manual_only" | "batch_only" | "shadow_only" | "hot_path_allowed";
export type BirdeyeEndpoint = "ohlcv_v3" | "token_holders" | "token_transactions";

export type BirdeyeConfig = Readonly<{
  state: ProviderState;
  apiKey?: string;
  baseUrl?: string;
  chain?: "solana";
  dailyComputeUnitCap?: number;
  hourlyComputeUnitCap?: number;
  endpointComputeUnits?: Partial<Record<BirdeyeEndpoint, number>>;
  maxRetries?: number;
}>;

export type BirdeyeUsageSummary = Readonly<{
  provider: "birdeye";
  state: ProviderState;
  batchOnly: boolean;
  dailyComputeUnitCap: number;
  hourlyComputeUnitCap: number;
  computeUnitsConsumed: number;
  calls: number;
  capBreached: boolean;
  liveApiCalled: boolean;
  apiKeyConfigured: boolean;
}>;

export type BirdeyeFetch = (url: string, init: RequestInit) => Promise<Response>;
export type BirdeyeSleep = (ms: number) => Promise<void>;
export type BirdeyeHeaders = Record<string, string>;

export type OhlcvV3Params = Readonly<{
  address: string;
  type: string;
  timeFrom: number;
  timeTo: number;
}>;

export type TokenListParams = Readonly<{
  address: string;
  offset?: number;
  limit?: number;
}>;

type CuEntry = Readonly<{
  endpoint: BirdeyeEndpoint;
  computeUnits: number;
  atMs: number;
}>;

export class BirdeyeClientError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "BirdeyeClientError";
  }
}

export class BirdeyeClient {
  private readonly baseUrl: string;
  private readonly chain: "solana";
  private readonly dailyCap: number;
  private readonly hourlyCap: number;
  private readonly endpointCu: Record<BirdeyeEndpoint, number>;
  private readonly maxRetries: number;
  private readonly fetchImpl: BirdeyeFetch;
  private readonly sleep: BirdeyeSleep;
  private readonly usage: CuEntry[] = [];
  private capBreached = false;
  private liveApiCalled = false;

  constructor(
    private readonly config: BirdeyeConfig,
    options: Readonly<{ fetch?: BirdeyeFetch; sleep?: BirdeyeSleep; now?: () => number }> = {},
  ) {
    this.baseUrl = config.baseUrl ?? BIRDEYE_BASE_URL;
    this.chain = config.chain ?? "solana";
    this.dailyCap = config.dailyComputeUnitCap ?? BIRDEYE_DEFAULT_DAILY_CU_CAP;
    this.hourlyCap = config.hourlyComputeUnitCap ?? BIRDEYE_DEFAULT_HOURLY_CU_CAP;
    this.endpointCu = {
      ohlcv_v3: config.endpointComputeUnits?.ohlcv_v3 ?? 1,
      token_holders: config.endpointComputeUnits?.token_holders ?? 1,
      token_transactions: config.endpointComputeUnits?.token_transactions ?? 1,
    };
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (() => Promise.resolve());
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  async getOhlcvV3(params: OhlcvV3Params): Promise<unknown> {
    const response = await this.request("ohlcv_v3", "/defi/v3/ohlcv", {
      address: params.address,
      type: params.type,
      time_from: String(params.timeFrom),
      time_to: String(params.timeTo),
    });
    assertBirdeyeOhlcvV3Response(response);
    return response;
  }

  async getTokenHolders(params: TokenListParams): Promise<unknown> {
    const response = await this.request("token_holders", "/defi/v3/token/holder", {
      address: params.address,
      offset: String(params.offset ?? 0),
      limit: String(params.limit ?? 100),
      ui_amount_mode: "scaled",
    });
    assertBirdeyeHoldersResponse(response);
    return response;
  }

  async getTokenTransactions(params: TokenListParams): Promise<unknown> {
    const response = await this.request("token_transactions", "/defi/v3/token/txs", {
      address: params.address,
      offset: String(params.offset ?? 0),
      limit: String(params.limit ?? 100),
      sort_by: "block_unix_time",
      sort_type: "desc",
      tx_type: "swap",
      ui_amount_mode: "scaled",
    });
    assertBirdeyeTransactionsResponse(response);
    return response;
  }

  usageSummary(): BirdeyeUsageSummary {
    return {
      provider: "birdeye",
      state: this.config.state,
      batchOnly: this.config.state === "batch_only",
      dailyComputeUnitCap: this.dailyCap,
      hourlyComputeUnitCap: this.hourlyCap,
      computeUnitsConsumed: this.usage.reduce((total, entry) => total + entry.computeUnits, 0),
      calls: this.usage.length,
      capBreached: this.capBreached,
      liveApiCalled: this.liveApiCalled,
      apiKeyConfigured: Boolean(this.config.apiKey),
    };
  }

  private buildRequest(pathname: string, query: Record<string, string>): Readonly<{ url: string; headers: BirdeyeHeaders }> {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return {
      url: url.toString(),
      headers: {
        "x-api-key": this.config.apiKey ?? "",
        "x-chain": this.chain,
      },
    };
  }

  private async request(endpoint: BirdeyeEndpoint, pathname: string, query: Record<string, string>): Promise<unknown> {
    this.assertBatchOnly();
    this.assertApiKey();
    const estimatedCu = this.endpointCu[endpoint];
    this.assertCuAvailable(estimatedCu);

    const request = this.buildRequest(pathname, query);
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const response = await this.fetchImpl(request.url, {
        method: "GET",
        headers: request.headers,
      });
      lastStatus = response.status;
      if (response.ok) {
        const body = await response.json() as unknown;
        this.recordUsage(endpoint, estimatedCu);
        this.liveApiCalled = this.baseUrl === BIRDEYE_BASE_URL;
        return body;
      }
      if (!shouldRetryStatus(response.status) || attempt === this.maxRetries) break;
      await this.sleep(10 * (attempt + 1));
    }
    throw new BirdeyeClientError(`Birdeye request failed with status ${lastStatus ?? "unknown"}`, "http_error", lastStatus);
  }

  private assertBatchOnly(): void {
    if (this.config.state !== "batch_only") {
      throw new BirdeyeClientError("Birdeye is restricted to batch_only state for MVP", "state_not_batch_only");
    }
  }

  private assertApiKey(): void {
    if (!this.config.apiKey) {
      throw new BirdeyeClientError("BIRDEYE_API_KEY is not configured", "missing_api_key");
    }
  }

  private assertCuAvailable(nextComputeUnits: number): void {
    const now = this.now();
    const dailyUsed = this.usedSince(now - 24 * 60 * 60 * 1000);
    const hourlyUsed = this.usedSince(now - 60 * 60 * 1000);
    if (dailyUsed + nextComputeUnits > this.dailyCap || hourlyUsed + nextComputeUnits > this.hourlyCap) {
      this.capBreached = true;
      throw new BirdeyeClientError("Birdeye compute-unit cap breached; provider is fail-closed", "compute_unit_cap_breached");
    }
  }

  private recordUsage(endpoint: BirdeyeEndpoint, computeUnits: number): void {
    this.usage.push({ endpoint, computeUnits, atMs: this.now() });
  }

  private usedSince(minAtMs: number): number {
    return this.usage
      .filter((entry) => entry.atMs >= minAtMs)
      .reduce((total, entry) => total + entry.computeUnits, 0);
  }
}

export function loadBirdeyeBatchOnlyConfigFromEnv(env: NodeJS.ProcessEnv): BirdeyeConfig {
  return {
    state: "batch_only",
    apiKey: env.BIRDEYE_API_KEY,
    dailyComputeUnitCap: parseOptionalPositiveInt(env.BIRDEYE_DAILY_COMPUTE_UNIT_CAP, BIRDEYE_DEFAULT_DAILY_CU_CAP),
    hourlyComputeUnitCap: parseOptionalPositiveInt(env.BIRDEYE_HOURLY_COMPUTE_UNIT_CAP, BIRDEYE_DEFAULT_HOURLY_CU_CAP),
  };
}

export function assertBirdeyeOhlcvV3Response(value: unknown): asserts value is unknown {
  const data = requireSuccessfulData(value, "OHLCV V3");
  const items = extractItems(data, "OHLCV V3");
  for (const item of items) {
    const object = asRecord(item, "OHLCV V3 item");
    requireAnyFiniteNumber(object, ["unixTime", "unix_time", "time", "timestamp"], "OHLCV V3 item timestamp");
    requireAnyFiniteNumber(object, ["open", "o"], "OHLCV V3 item open");
    requireAnyFiniteNumber(object, ["high", "h"], "OHLCV V3 item high");
    requireAnyFiniteNumber(object, ["low", "l"], "OHLCV V3 item low");
    requireAnyFiniteNumber(object, ["close", "c"], "OHLCV V3 item close");
    requireAnyFiniteNumber(object, ["volume", "v"], "OHLCV V3 item volume");
  }
}

export function assertBirdeyeHoldersResponse(value: unknown): asserts value is unknown {
  const data = requireSuccessfulData(value, "holders");
  const items = extractItems(data, "holders");
  for (const item of items) {
    const object = asRecord(item, "holder item");
    requireString(object.amount, "holder amount");
    requireString(object.owner, "holder owner");
    requireFiniteNumber(object.ui_amount, "holder ui_amount");
  }
}

export function assertBirdeyeTransactionsResponse(value: unknown): asserts value is unknown {
  const data = requireSuccessfulData(value, "transactions");
  const items = extractItems(data, "transactions");
  for (const item of items) {
    const object = asRecord(item, "transaction item");
    requireString(object.tx_hash, "transaction tx_hash");
    requireFiniteNumber(object.block_unix_time, "transaction block_unix_time");
  }
  if ("hasNext" in data && typeof data.hasNext !== "boolean") {
    throw new Error("transactions hasNext must be boolean when present");
  }
}

function requireSuccessfulData(value: unknown, label: string): Record<string, unknown> {
  const object = asRecord(value, `${label} response`);
  if (object.success !== true) throw new Error(`${label} response success must be true`);
  return asRecord(object.data, `${label} response data`);
}

function extractItems(data: Record<string, unknown>, label: string): readonly unknown[] {
  const candidate = Array.isArray(data.items) ? data.items : Array.isArray(data.ohlcv) ? data.ohlcv : undefined;
  if (!candidate) throw new Error(`${label} response data must include an items array`);
  return candidate;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireAnyFiniteNumber(object: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (typeof object[key] === "number" && Number.isFinite(object[key])) return;
  }
  throw new Error(`${label} must be a finite number`);
}

function requireFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function parseOptionalPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
