# Redis Cache Project

An Express API that puts **Redis in front of MongoDB** using the cache-aside pattern, with a load-test script to measure the difference.

## Stack

- Node.js >= 20.19, Express 5
- MongoDB + Mongoose 9
- Redis (`redis` client v6)
- autocannon (load testing)
- Docker + Docker Compose

## How it works

**`GET /api/products?category=Laptops&page=1&limit=20`**

1. Validates `category` (fixed list), `page`, `limit` (max 100)
2. Builds a cache key from those validated params only, e.g. `products:list:Laptops:p1:l20`
3. Cache hit: returns the stored JSON (`X-Cache: HIT`)
4. Cache miss: queries MongoDB, stores the result in Redis with a TTL (default 60s), returns it (`X-Cache: MISS`)

**`POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id`**
write to MongoDB, then invalidate every cached list (`SCAN` + `DEL`, never `KEYS`).

`GET /health` reports MongoDB and Redis status.

### Design decisions

- **Only validated params in the cache key.** Unknown query params are ignored, and `category` must be in a fixed list, so a client cannot create unlimited cache keys.
- **`SCAN` instead of `KEYS`** for invalidation. `KEYS` is O(N) and blocks Redis.
- **Allow-listed fields** (`name`, `price`, `category`, `specs`) on writes, so clients can't set arbitrary fields (mass assignment).
- **Bad ids return 400**, missing products 404, validation errors 400, anything else a generic 500.
- **Compound index** `{ category: 1, _id: 1 }` serves category filtering plus stable pagination.
- **Cache is best-effort.** If Redis is down, requests fall back to MongoDB.
- **Single-flight on misses.** Concurrent misses for the same key share one MongoDB query.
- **Config via environment variables** (see `.env.example`).

## Run with Docker (recommended)

```powershell
docker compose up -d --build
docker compose exec api node seed.js 5000
curl.exe -i "http://localhost:4000/api/products?category=Laptops&limit=5"
```

Call the last command twice: the first response is `X-Cache: MISS`, the second `X-Cache: HIT`.

## Run locally

Requires MongoDB on `127.0.0.1:27017` and Redis on `127.0.0.1:6379`.

```powershell
npm install
Copy-Item .env.example .env   # optional, defaults already match
npm run seed                  # 5000 products (or: node seed.js 20000)
npm start
```

### Try the write routes

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/products -ContentType 'application/json' -Body '{"name":"Test Laptop","price":999,"category":"Laptops"}'
Invoke-RestMethod -Method Put  -Uri http://localhost:4000/api/products/<id> -ContentType 'application/json' -Body '{"price":899}'
Invoke-RestMethod -Method Delete -Uri http://localhost:4000/api/products/<id>
```

## Benchmark: with vs without cache

`benchmark.js` hits `/api/products?category=Laptops&limit=100` with 100 connections for 30 seconds (override with `BENCH_URL`, `BENCH_CONNECTIONS`, `BENCH_DURATION`, `BENCH_LABEL`).

```powershell
# 1) Baseline: cache disabled
$env:CACHE_ENABLED = "false"; docker compose up -d --build
$env:BENCH_LABEL = "no cache"; npm run bench

# 2) With Redis
$env:CACHE_ENABLED = "true"; docker compose up -d
$env:BENCH_LABEL = "redis cache"; npm run bench
```

Paste the printed rows here:

| Scenario    | Req/sec | Avg latency | p99 latency |
|-------------|---------|-------------|-------------|
| no cache    | _fill in_ | _fill in_ | _fill in_ |
| redis cache | _fill in_ | _fill in_ | _fill in_ |

_Environment: add your CPU/RAM and note that MongoDB, Redis, the API and autocannon all ran on the same machine._

## Trade-offs and limitations

- **Stale reads:** cached lists can be up to `CACHE_TTL_SECONDS` old if data changes outside this API. Writes through this API invalidate immediately.
- **Why a 60s TTL:** a compromise. Short enough that stale data from out-of-band changes disappears quickly, long enough that popular lists are served from Redis most of the time. Tune it with `CACHE_TTL_SECONDS`.
- **Invalidation is coarse:** any write clears all cached lists. Simple and correct, but a write-heavy workload would hurt hit rate.
- **Small race window:** a read that started before a write can store its (old) result after the invalidation. The TTL bounds how long that stale entry lives.
- **Cache stampede:** single-flight protects within one API process only. Multiple instances would need a Redis lock or TTL jitter.
- **Empty results are cached too**, so repeated queries for an empty page don't hit MongoDB.

## Documentation

- [Project guide](docs/01-PROJECT-GUIDE.md): architecture, code walkthrough, every change and why
- [Operating guide](docs/02-OPERATING-GUIDE.md): step-by-step commands to run, test, benchmark and experiment
- [Errors and fixes](docs/03-ERRORS-AND-FIXES.md): what broke, how it was diagnosed, troubleshooting table

## Possible next steps

- Redis-based locking or TTL jitter for multi-instance deployments
- Tests (Vitest + supertest) and a GitHub Actions CI workflow
- Kubernetes manifests
